import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const LABEL = fileURLToPath(new URL("../factory-label.sh", import.meta.url));
const OUTCOME = fileURLToPath(new URL("../factory-outcome.sh", import.meta.url));
const RUN = "https://github.com/o/r/actions/runs/77";
// The tail of factory run 45249182872's factory job log (#594), as the jobs/{id}/logs endpoint
// returned it: a byte-order mark, a timestamp on every line and the run scripts echoed in colour.
const FIXTURE = fileURLToPath(new URL("fixtures/factory-job-594.txt", import.meta.url));
// The tail of factory run 45883747890's factory job log (#597, #659), as the endpoint returned it:
// the `result` step's RESULT lines after its script, echoed with ANSI colour codes. The runner's gh
// refused this log without --allow-escape-sequences, so the comment read no RESULT lines.
const FIXTURE_597 = fileURLToPath(new URL("fixtures/factory-job-597.txt", import.meta.url));

let dir;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

// A fake gh on PATH that logs each call (method, path and token) and answers as gh would after its
// --jq: the issue's factory:* states are HAVE ("ready", "ready failed", or "" for none), the run's
// jobs give the factory job id 5, and its log is LOG. A comment's body file is copied to `comment`.
// GH_ESC picks the gh the log meets: "refuses" is a gh that refuses a response holding an escape
// sequence unless --allow-escape-sequences is passed (the runner's, #659), "old" one that has no
// such flag (2.89); unset, the flag is ignored.
function run(script, env) {
	dir = mkdtempSync(join(tmpdir(), "factory-label-"));
	mkdirSync(join(dir, "bin"));
	writeFileSync(
		join(dir, "bin", "gh"),
		`#!/usr/bin/env bash
m=GET; path=""; esc=""
for a; do case $a in -X) ;; GET|POST|DELETE|PATCH) m=$a ;; repos/*) path=$a ;; body=@*) cp "\${a#body=@}" "${dir}/comment" ;; --allow-escape-sequences) esc=1 ;; esac; done
if [[ \${GH_ESC-} == old && -n $esc ]]; then echo "unknown flag: --allow-escape-sequences" >&2; exit 1; fi
echo "$m $path token=$GH_TOKEN" >>"${dir}/calls"
case "$m $path" in
  "GET repos/o/r/issues/42") echo "$HAVE" ;;
  "GET repos/o/r/actions/runs/77/jobs"*) echo 5 ;;
  "GET repos/o/r/actions/jobs/5/logs")
    n=$(($(cat "${dir}/fetches" 2>/dev/null || echo 0) + 1)); echo "$n" >"${dir}/fetches"
    if ((n <= \${FAILS:-0})); then echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi
    if [[ \${GH_ESC-} == refuses && -z $esc ]] && { [[ -n \${LOG_FILE-} ]] && grep -q $'\\e' "$LOG_FILE" || [[ \${LOG-} == *$'\\e'* ]]; }; then
      echo "the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway" >&2; exit 1
    fi
    if [[ -n \${LOG_FILE-} ]]; then cat "$LOG_FILE"; else printf '%s' "$LOG"; fi ;;
esac
`,
	);
	chmodSync(join(dir, "bin", "gh"), 0o755);
	writeFileSync(join(dir, "calls"), "");
	const res = spawnSync("bash", [script], {
		encoding: "utf8",
		env: {
			PATH: `${join(dir, "bin")}:${process.env.PATH}`,
			GITHUB_REPOSITORY: "o/r",
			GITHUB_SERVER_URL: "https://github.com",
			GITHUB_RUN_ID: "77",
			RUNNER_TEMP: dir,
			GH_TOKEN: "app-token",
			ISSUE: "42",
			HAVE: "",
			LOG_WAIT: "0 0 0 0",
			...env,
		},
	});
	const read = (f) => {
		try {
			return readFileSync(join(dir, f), "utf8");
		} catch {
			return null;
		}
	};
	return {
		code: res.status,
		log: res.stdout + res.stderr,
		calls: read("calls").trim().split("\n").filter(Boolean),
		comment: read("comment"),
	};
}

const label = (env) => run(LABEL, env);
const outcome = (env) => run(OUTCOME, { RUN_TOKEN: "run-token", ...env });

describe("factory-label.sh", () => {
	it("moves factory:ready to factory:working: removes the old label before adding the new", () => {
		const r = label({ HAVE: "ready", TO: "working", WHY: "dispatched" });
		expect(r.code).toBe(0);
		expect(r.calls).toEqual([
			"GET repos/o/r/issues/42 token=app-token",
			"DELETE repos/o/r/issues/42/labels/factory:ready token=app-token",
			"POST repos/o/r/issues/42/labels token=app-token",
		]);
		expect(r.log).toMatch(/^LABEL #42: ready -> working \(dispatched\)$/m);
		expect(r.comment).toBeNull();
	});

	it("leaves at most one factory:* label: every other one goes", () => {
		const r = label({ HAVE: "ready working failed", TO: "failed", WHY: "kept" });
		expect(r.calls.slice(1)).toEqual([
			"DELETE repos/o/r/issues/42/labels/factory:ready token=app-token",
			"DELETE repos/o/r/issues/42/labels/factory:working token=app-token",
		]);
		expect(r.comment).toBeNull(); // it was failed already
	});

	it("moves to factory:failed with one comment: the reason, the detail and how to retry", () => {
		const r = label({ HAVE: "working", TO: "failed", WHY: "run vanished", DETAIL: "" });
		expect(r.calls.at(-1)).toBe("POST repos/o/r/issues/42/comments token=app-token");
		expect(r.comment).toMatch(/^`factory:failed`: run vanished\n\n/);
		expect(r.comment).toContain("To retry, replace `factory:failed` with `factory:ready`");
	});

	it("strips every factory:* label for none, and does nothing when there is nothing to do", () => {
		const none = label({ HAVE: "review", TO: "none", WHY: "the issue is closed" });
		expect(none.calls.slice(1)).toEqual([
			"DELETE repos/o/r/issues/42/labels/factory:review token=app-token",
		]);
		expect(none.log).toMatch(/^LABEL #42: review -> none \(the issue is closed\)$/m);
		for (const [HAVE, TO] of [
			["working", "working"],
			["", "none"],
		]) {
			const same = label({ HAVE, TO, WHY: "x" });
			expect(same.code).toBe(0);
			expect(same.calls).toHaveLength(1);
			expect(same.log).toMatch(/^LABEL #42: already /m);
		}
	});

	it("moves only from a state in FROM", () => {
		const left = label({ HAVE: "ready", TO: "failed", WHY: "gate", FROM: "working" });
		expect(left.calls).toHaveLength(1);
		expect(left.log).toMatch(/^LABEL #42: left at ready, not one of: working \(gate\)$/m);
		const moved = label({ HAVE: "working", TO: "failed", WHY: "gate", FROM: "working" });
		expect(moved.calls).toContain("POST repos/o/r/issues/42/labels token=app-token");
	});

	it.each([
		["an issue that isn't a number", { ISSUE: "42/../1", TO: "working" }],
		["a state that isn't one of the four or none", { TO: "merged" }],
	])("refuses %s before any call", (_n, env) => {
		const r = label(env);
		expect(r.code).toBe(1);
		expect(r.calls).toEqual([]);
	});

	it("keeps WHY on one log line", () => {
		const r = label({ HAVE: "ready", TO: "working", WHY: "a\n::error::forged" });
		expect(r.log).toMatch(/^LABEL #42: ready -> working \(a ::error::forged\)$/m);
		expect(r.log).not.toMatch(/^::error::forged/m);
	});
});

describe("factory-outcome.sh", () => {
	it("sets factory:review when the run opened a PR", () => {
		const r = outcome({ HAVE: "working", PR: "700", GATE_RUN: "true" });
		expect(r.log).toMatch(
			new RegExp(`^LABEL #42: working -> review \\(run ${RUN} opened PR #700\\)$`, "m"),
		);
		expect(r.comment).toBeNull();
	});

	it("sets factory:review after a fix round, whatever it pushed", () => {
		const r = outcome({ HAVE: "working", FIX: "586", GATE_RUN: "true" });
		expect(r.log).toMatch(/^LABEL #42: working -> review \(fix round on PR #586 ended/m);
	});

	it("sets factory:failed on a run without a PR, quoting the factory job's RESULT lines and the run link", () => {
		const log = [
			"2026-11-23T10:00:00.1Z ##[group]Run set -uo pipefail",
			'2026-11-23T10:00:00.2Z   echo "RESULT factory=${factory:-none}"',
			"2026-11-23T10:00:01.0Z RESULT claude=success subtype=success num_turns=40",
			"2026-11-23T10:00:02.0Z RESULT handoff=none: Claude wrote no branch",
			"2026-11-23T10:00:03.0Z RESULT factory=FACTORY stopped: needs `the admin` @sssoto17",
		].join("\n");
		const r = outcome({
			HAVE: "working",
			GATE_RUN: "true",
			FACTORY_RESULT: "success",
			PUBLISH_RESULT: "skipped",
			LOG: log,
		});
		expect(r.code).toBe(0);
		expect(r.calls).toContain("GET repos/o/r/actions/runs/77/jobs?per_page=100 token=run-token");
		expect(r.calls).toContain("GET repos/o/r/actions/jobs/5/logs token=run-token");
		expect(r.calls).toContain("POST repos/o/r/issues/42/labels token=app-token");
		expect(r.comment).toContain(`\`factory:failed\`: run ${RUN} opened no PR`);
		expect(r.comment).toContain("The factory job ended `success` and publish `skipped`.");
		expect(r.comment).toContain(
			"```text\nRESULT claude=success subtype=success num_turns=40\nRESULT handoff=none: Claude wrote no branch\nRESULT factory=FACTORY stopped: needs the admin @sssoto17\n```",
		);
		expect(r.comment).not.toContain("${factory");
	});

	it("quotes the RESULT lines of a captured factory job log (run 45249182872, #594)", () => {
		const r = outcome({ HAVE: "working", GATE_RUN: "true", LOG_FILE: FIXTURE });
		expect(r.comment).toContain(
			"```text\nRESULT claude=success subtype=success is_error=false num_turns=10 total_cost_usd=0.29726440000000004 duration_ms=29674\nRESULT handoff=none: Claude wrote no branch\nRESULT factory=FACTORY stopped: sandbox mounts node_modules and pnpm-lock.yaml read-only, so the pinned dependencies can't be installed or locked\n```",
		);
	});

	it.each([
		["a gh that refuses escape sequences without the flag (the runner's)", "refuses"],
		["a gh without --allow-escape-sequences (2.89)", "old"],
	])("quotes run 45883747890's RESULT lines (#597) from %s", (_name, GH_ESC) => {
		const r = outcome({ HAVE: "working", GATE_RUN: "true", LOG_FILE: FIXTURE_597, GH_ESC });
		expect(r.log).not.toMatch(/^LOG attempt/m);
		expect(r.comment).toContain(
			"```text\nRESULT claude=success subtype=success is_error=false num_turns=36 total_cost_usd=0.8006315999999998 duration_ms=320351\nRESULT handoff=none: Claude wrote no branch\nRESULT factory=none\n```",
		);
		expect(r.comment).not.toContain("\u001b");
	});

	it("drops escape sequences and control characters from a quoted line", () => {
		const log =
			"2026-11-26T19:33:39.1Z RESULT claude=success \u001b[31mred\u001b[0m\u0007 end\u001b[K\n2026-11-26T19:33:39.2Z \u001b[2KRESULT factory=FACTORY stopped: x\n";
		const r = outcome({ HAVE: "working", GATE_RUN: "true", LOG: log, GH_ESC: "refuses" });
		expect(r.comment).toContain(
			"```text\nRESULT claude=success red end\nRESULT factory=FACTORY stopped: x\n```",
		);
	});

	it("retries the log while GitHub hasn't published it yet, and logs each miss", () => {
		const r = outcome({ HAVE: "working", GATE_RUN: "true", LOG_FILE: FIXTURE, FAILS: "2" });
		expect(r.calls.filter((c) => c.includes("/logs"))).toHaveLength(3);
		expect(r.log).toMatch(/^LOG attempt 1: no RESULT lines yet \(gh: Not Found \(HTTP 404\)\)$/m);
		expect(r.comment).toContain("RESULT factory=FACTORY stopped: sandbox mounts");
	});

	it("retries a log that has no RESULT claude= line yet", () => {
		const partial = "2026-11-23T10:00:02.0Z RESULT handoff=none: Claude wrote no branch\n";
		const r = outcome({ HAVE: "working", GATE_RUN: "true", LOG: partial });
		expect(r.calls.filter((c) => c.includes("/logs"))).toHaveLength(5);
		expect(r.comment).toContain("```text\nRESULT handoff=none: Claude wrote no branch\n```");
	});

	it("still sets factory:failed when the log can't be read", () => {
		const r = outcome({ HAVE: "working", GATE_RUN: "true", LOG: "", FAILS: "9" });
		expect(r.calls.filter((c) => c.includes("/logs"))).toHaveLength(5);
		expect(r.comment).toContain("No `RESULT` lines could be read");
	});

	it("sets factory:failed with the gate's reason only on an issue at factory:working", () => {
		const env = { GATE_RUN: "false", GATE_WHY: "#42 is blocked by #594" };
		const working = outcome({ HAVE: "working", ...env });
		expect(working.comment).toContain(`run ${RUN}: the gate refused: #42 is blocked by #594`);
		const ready = outcome({ HAVE: "ready", ...env });
		expect(ready.calls).toHaveLength(1);
		expect(ready.comment).toBeNull();
	});

	it("leaves a label the admin changed during the run", () => {
		const r = outcome({ HAVE: "failed", PR: "700", GATE_RUN: "true" });
		expect(r.calls).toHaveLength(1);
		expect(r.log).toMatch(/^LABEL #42: left at failed, not one of: ready working /m);
		const none = outcome({ HAVE: "", GATE_RUN: "true" });
		expect(none.comment).toBeNull();
	});

	it("moves nothing when the gate checked no issue", () => {
		const r = outcome({ ISSUE: "", GATE_RUN: "false" });
		expect(r.code).toBe(0);
		expect(r.calls).toEqual([]);
		expect(r.log).toMatch(/^LABEL none: the gate checked no issue$/m);
	});
});
