import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { GH_ESCAPE_REFUSAL } from "./workflow-step.mjs";

const SCRIPT = fileURLToPath(new URL("../reviewer-stopped.sh", import.meta.url));
const TITLE = "Reviewer stopped: startup_failure on review.yml";
const SINCE = "2026-11-22T10:00:00Z";

// A fake gh: logs each call on one line and answers reads from fixtures in its folder. The
// `--jq` filters are run with the real jq over the fixture, so the script's filters are tested
// too: runs.json (the runs list), open.json and closed.json (the issues lists), issue-<n>.json
// and comments-<n>.json. A write logs its body file's text after the call. Like the runner's gh
// (#668), it refuses output that holds an ESC byte unless the call passes
// --allow-escape-sequences: a raw string out of --jq can hold one, JSON never does.
const FAKE_GH = `#!/usr/bin/env bash
d=$(dirname "$0")
s="$*"
printf '%s\\n' "$s" >>"$d/calls"
jqf=""; body=""; prev=""
for a in "$@"; do
  [[ $prev == --jq ]] && jqf=$a
  [[ $a == body=@* ]] && body=\${a#body=@}
  prev=$a
done
case "$*" in
  *"actions/workflows/review.yml/runs"*) f=runs.json ;;
  *"repos/o/r/issues -f per_page"*"state=open"*) f=open.json ;;
  *"repos/o/r/issues -f per_page"*"state=closed"*) f=closed.json ;;
  *"issues/"*"/comments --jq"*) n=\${s#*issues/}; f=comments-\${n%%/*}.json ;;
  "api repos/o/r/issues/"*" --jq"*) n=\${s#*issues/}; f=issue-\${n%% *}.json ;;
  *"--silent repos/o/r/issues/"*"/comments"*) printf 'BODY<<\\n%s\\n>>\\n' "$(cat "$body")" >>"$d/calls"; exit 0 ;;
  "api repos/o/r/issues -f title="*) printf 'BODY<<\\n%s\\n>>\\n' "$(cat "$body")" >>"$d/calls"; echo 99; exit 0 ;;
  *) echo "fake gh: unexpected call: $*" >&2; exit 98 ;;
esac
[[ -f $d/$f ]] || f=empty.json
out="$d/response"
jq -r "$jqf" "$d/$f" >"$out"
${GH_ESCAPE_REFUSAL}`;

const run = (id, created = "2026-11-22T11:00:00Z") => ({
	id,
	created_at: created,
	html_url: `https://github.com/o/r/actions/runs/${id}`,
	conclusion: "startup_failure",
});
const BOT = "github-actions[bot]";
// An issue as the issues list gives it; by default one this workflow opened.
const issue = (number, state, { title = TITLE, author = BOT } = {}) => ({
	number,
	state,
	title,
	user: { login: author },
});
// A comment: a plain string is the workflow's own, [author, body] someone else's.
const comment = (c) =>
	typeof c === "string" ? { user: { login: BOT }, body: c } : { user: { login: c[0] }, body: c[1] };

let dir;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

function alert({
	runs = [],
	open = [],
	closed = [],
	bodies = {},
	comments = {},
	env = {},
	others = [],
} = {}) {
	dir = mkdtempSync(join(tmpdir(), "reviewer-stopped-"));
	const bin = join(dir, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "gh"), FAKE_GH);
	chmodSync(join(bin, "gh"), 0o755);
	writeFileSync(join(bin, "empty.json"), "[]");
	writeFileSync(
		join(bin, "runs.json"),
		JSON.stringify({ total_count: runs.length, workflow_runs: runs }),
	);
	writeFileSync(join(bin, "open.json"), JSON.stringify([...open, ...others]));
	writeFileSync(join(bin, "closed.json"), JSON.stringify(closed));
	for (const [n, body] of Object.entries(bodies))
		writeFileSync(join(bin, `issue-${n}.json`), JSON.stringify({ number: Number(n), body }));
	for (const [n, list] of Object.entries(comments))
		writeFileSync(join(bin, `comments-${n}.json`), JSON.stringify(list.map(comment)));
	const res = spawnSync("bash", [SCRIPT], {
		cwd: dir,
		encoding: "utf8",
		env: {
			PATH: `${bin}:${process.env.PATH}`,
			GITHUB_REPOSITORY: "o/r",
			SINCE,
			RUNNER_TEMP: dir,
			...env,
		},
	});
	const calls = existsSync(join(bin, "calls")) ? readFileSync(join(bin, "calls"), "utf8") : "";
	const writes = calls
		.split("\n")
		.filter((l) => /^api (--silent )?repos\/o\/r\/issues( -f title|\/\d+\/comments -F)/.test(l));
	return { code: res.status, log: res.stdout + res.stderr, calls, writes };
}

describe("reviewer-stopped.sh", () => {
	it("files nothing when review.yml had no startup_failure", () => {
		const a = alert();
		expect(a.code).toBe(0);
		expect(a.log).toMatch(
			/^ALERT none: no startup_failure on review.yml since 2026-11-22T10:00:00Z$/m,
		);
		expect(a.writes).toEqual([]);
		// It asks for exactly those runs: startup_failure, created in the window.
		expect(a.calls).toContain(
			`api -X GET --paginate repos/o/r/actions/workflows/review.yml/runs -f status=startup_failure -f created=>=${SINCE}`,
		);
	});

	it("opens one issue, labelled blocked:admin, linking every failed run on the first failure", () => {
		const a = alert({ runs: [run(2, "2026-11-22T11:05:00Z"), run(1, "2026-11-22T11:00:00Z")] });
		expect(a.code).toBe(0);
		expect(a.log).toMatch(/^ALERT opened: #99, 2 run\(s\)$/m);
		expect(a.writes).toHaveLength(1);
		const [create] = a.writes;
		expect(create).toContain(`-f title=${TITLE}`);
		for (const label of ["blocked:admin", "chore", "area:ci-cd", "triage"])
			expect(create).toContain(`-f labels[]=${label}`);
		// The links, oldest first.
		expect(a.calls).toMatch(
			/- \[1\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/1\), 2026-11-22T11:00:00Z\n- \[2\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/2\)/,
		);
	});

	it("comments on the open issue instead of opening another on a repeat failure, linking only the new runs", () => {
		const a = alert({
			runs: [run(1), run(2, "2026-11-22T12:00:00Z")],
			open: [issue(40, "open")],
			bodies: { 40: "Runs:\n\n- [1](https://github.com/o/r/actions/runs/1), x\n" },
		});
		expect(a.code).toBe(0);
		expect(a.log).toMatch(/^ALERT commented: #40, 1 run\(s\)$/m);
		expect(a.writes).toHaveLength(1);
		expect(a.writes[0]).toMatch(/^api --silent repos\/o\/r\/issues\/40\/comments -F body=@/);
		expect(a.calls).toContain("actions/runs/2)");
		expect(a.calls).not.toMatch(/BODY<<[^>]*actions\/runs\/1\)/);
	});

	it("comments on an open issue even when the failure is the first since it was opened", () => {
		const a = alert({ runs: [run(5)], open: [issue(40, "open")], bodies: { 40: "old runs" } });
		expect(a.log).toMatch(/^ALERT commented: #40, 1 run\(s\)$/m);
		expect(a.writes).toHaveLength(1);
	});

	// The second case: an issue's text can hold a terminal escape sequence (someone edits the
	// body), which the runner's gh refuses to print raw, so its runs would be filed again (#668).
	it.each([
		["", ""],
		[" when the text holds escape sequences", "\x1b[31m"],
	])("writes nothing when every run is already linked, from the body or a comment%s", (_, esc) => {
		const a = alert({
			runs: [run(1), run(2)],
			open: [issue(40, "open")],
			bodies: { 40: `${esc}- [1](https://github.com/o/r/actions/runs/1)${esc}` },
			comments: { 40: [`${esc}- [2](https://github.com/o/r/actions/runs/2)`] },
		});
		expect(a.code).toBe(0);
		expect(a.log).toMatch(/^ALERT none: every startup_failure since .* is already reported$/m);
		expect(a.writes).toEqual([]);
	});

	it("doesn't refile runs a closed issue already holds, but opens a new issue for later ones", () => {
		const held = alert({
			runs: [run(1)],
			closed: [issue(30, "closed")],
			bodies: { 30: "https://github.com/o/r/actions/runs/1" },
		});
		expect(held.writes).toEqual([]);

		const later = alert({
			runs: [run(1), run(3)],
			closed: [issue(30, "closed")],
			bodies: { 30: "https://github.com/o/r/actions/runs/1" },
		});
		expect(later.log).toMatch(/^ALERT opened: #99, 1 run\(s\)$/m);
		expect(later.calls).toContain("actions/runs/3)");
	});

	it.each([
		["run 1 linked doesn't hide run 12", 12, 1],
		["run 12 linked doesn't hide run 1", 1, 12],
	])("matches the run id whole: %s", (_n, failed, linked) => {
		const a = alert({
			runs: [run(failed)],
			open: [issue(40, "open")],
			bodies: { 40: `https://github.com/o/r/actions/runs/${linked}` },
		});
		expect(a.log).toMatch(/^ALERT commented: #40, 1 run\(s\)$/m);
	});

	it.each([
		["another title", { title: "Something else" }],
		["the same title, opened by someone else", { author: "stranger" }],
	])("ignores an open issue with %s", (_n, fields) => {
		const a = alert({ runs: [run(1)], others: [issue(41, "open", fields)] });
		expect(a.log).toMatch(/^ALERT opened: #99/m);
		expect(a.calls).not.toContain("issues/41");
	});

	it("doesn't count a run linked only in someone else's comment, or another repo's run", () => {
		const a = alert({
			runs: [run(1), run(2)],
			open: [issue(40, "open")],
			bodies: { 40: "https://github.com/x/y/actions/runs/2" },
			comments: { 40: [["stranger", "https://github.com/o/r/actions/runs/1"]] },
		});
		expect(a.log).toMatch(/^ALERT commented: #40, 2 run\(s\)$/m);
	});

	it("reads open issues of any age, and closed ones only from the window", () => {
		const a = alert({ runs: [run(1)] });
		expect(a.calls).toMatch(
			/^api -X GET --paginate repos\/o\/r\/issues -f per_page=100 -f state=open --jq/m,
		);
		expect(a.calls).toContain(`-f state=closed -f since=${SINCE} --jq`);
	});

	it.each([
		["a first failure", {}, /^ALERT dry run: would open "Reviewer stopped/m],
		[
			"a repeat failure",
			{ open: [issue(40, "open")] },
			/^ALERT dry run: would comment on #40 with 1 run\(s\)$/m,
		],
	])("writes nothing in a dry run, on %s", (_n, fixture, line) => {
		const a = alert({ runs: [run(7)], ...fixture, env: { DRY_RUN: "true" } });
		expect(a.code).toBe(0);
		expect(a.log).toMatch(line);
		expect(a.log).toContain("actions/runs/7");
		expect(a.writes).toEqual([]);
	});

	it.each([
		["SINCE is missing", { SINCE: "" }],
		["SINCE isn't a UTC time", { SINCE: "2026-11-22 10:00&x=1" }],
		["DRY_RUN is neither true nor false", { DRY_RUN: "yes" }],
	])("refuses before calling gh when %s", (_n, env) => {
		const a = alert({ runs: [run(1)], env });
		expect(a.code).not.toBe(0);
		expect(a.calls).toBe("");
	});
});
