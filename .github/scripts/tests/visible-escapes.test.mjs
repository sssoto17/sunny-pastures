import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { runBlock } from "./workflow-step.mjs";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../visible-escapes.mjs", import.meta.url));
const yml = readFileSync(join(ROOT, ".github/workflows/review.yml"), "utf8");

// A diff as #645's (review.yml run 45871690829): a captured Actions log whose lines carry ANSI
// colour codes, plus the other control characters the script makes visible and the bytes it keeps.
const ESC = "\x1b";
const DIFF = Buffer.concat([
	Buffer.from(
		[
			"diff --git a/log.txt b/log.txt",
			"+++ b/log.txt",
			`+${ESC}[36;1mecho "hi"${ESC}[0m`,
			"+bell\x07 and C1 CSI \u009b and DEL \x7f",
			"+tab\tand CRLF\r",
			"+æøå ✓",
			"",
		].join("\n"),
		"utf8",
	),
	Buffer.from([0x2b, 0xff, 0xfe, 0x0a]), // a line that isn't UTF-8 at all
]);
const SHOWN = Buffer.concat([
	Buffer.from(
		[
			"diff --git a/log.txt b/log.txt",
			"+++ b/log.txt",
			'+<ESC>[36;1mecho "hi"<ESC>[0m',
			"+bell<U+0007> and C1 CSI <U+009B> and DEL <U+007F>",
			"+tab\tand CRLF\r",
			"+æøå ✓",
			"",
		].join("\n"),
		"utf8",
	),
	Buffer.from([0x2b, 0xff, 0xfe, 0x0a]),
]);
const SUMMARY =
	"diff.patch: the workflow replaced 2 ESC bytes with <ESC> and 3 other control characters " +
	"with <U+XXXX>; each marker stands for the control character the PR's diff holds there.";

let dir;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

describe("visible-escapes.mjs", () => {
	const show = (input) => {
		dir = mkdtempSync(join(tmpdir(), "visible-escapes-"));
		const res = spawnSync("node", [SCRIPT, join(dir, "diff.patch")], { input });
		return {
			code: res.status,
			out: res.stdout.toString(),
			err: res.stderr.toString(),
			file: () => readFileSync(join(dir, "diff.patch")),
		};
	};

	it("shows each ESC as <ESC> and every other control character as <U+XXXX>", () => {
		const r = show(DIFF);
		expect(r.err).toBe("");
		expect(r.code).toBe(0);
		expect(r.file().equals(SHOWN)).toBe(true);
		expect(r.out.trim()).toBe(SUMMARY);
	});

	it("leaves a diff with no control characters byte for byte", () => {
		const plain = Buffer.from("diff --git a/x b/x\n+tab\there\r\n+æ\n", "utf8");
		const r = show(plain);
		expect(r.code).toBe(0);
		expect(r.file().equals(plain)).toBe(true);
		expect(r.out.trim()).toBe(
			"diff.patch: no control characters; the workflow changed nothing in the PR's diff.",
		);
	});

	it("counts a single ESC in the singular", () => {
		const r = show(Buffer.from(`+${ESC}[0m\n`));
		expect(r.file().toString()).toBe("+<ESC>[0m\n");
		expect(r.out).toMatch(/replaced 1 ESC byte with <ESC> and 0 other control characters with/);
	});

	it("refuses to run without an output file", () => {
		const res = spawnSync("node", [SCRIPT], { input: DIFF });
		expect(res.status).toBe(2);
		expect(res.stderr.toString()).toMatch(/^visible-escapes: usage:/);
	});
});

// The gather step's own shell, run with a fake gh that answers as GitHub did for #645 (#648).
// Its diff call answers with DIFF; `fails` names the call that fails instead, and `ref` the run's ref.
function gather({ fails = "", ref = "refs/heads/main" } = {}) {
	dir = mkdtempSync(join(tmpdir(), "review-gather-"));
	const bin = join(dir, "bin");
	const temp = join(dir, "temp");
	mkdirSync(bin);
	mkdirSync(temp);
	writeFileSync(join(dir, "diff"), DIFF);
	const pr = {
		number: 7,
		title: "t",
		body: "",
		author: "a",
		base: "main",
		base_sha: "b".repeat(40),
		head_sha: "a".repeat(40),
		stack: null,
		labels: [],
		additions: 1,
		deletions: 0,
	};
	writeFileSync(join(dir, "pr.json"), JSON.stringify(pr));
	writeFileSync(
		join(bin, "gh"),
		`#!/usr/bin/env bash
echo "gh $*" >>"${dir}/calls"
case "$*" in
  *graphql*) echo '[]' ;;
  *vnd.github.diff*)
    ${fails === "diff" ? 'echo "gh: HTTP 406: diff too large" >&2; exit 1' : `cat "${dir}/diff"`} ;;
  *pulls/7/reviews*) ;;
  *pulls/7/files*)
    ${fails === "files" ? 'echo "gh: HTTP 502" >&2; exit 1' : `echo '{"filename":"log.txt","status":"added","additions":1,"deletions":0}'`} ;;
  *"pulls/7 "*) cat "${dir}/pr.json" ;;
  *) echo "fake gh: unexpected call: gh $*" >&2; exit 9 ;;
esac
`,
	);
	chmodSync(join(bin, "gh"), 0o755);
	for (const f of ["out", "env"]) writeFileSync(join(dir, f), "");
	const res = spawnSync("bash", ["-c", runBlock(yml, "Gather the PR (read-only token)")], {
		cwd: ROOT,
		encoding: "utf8",
		env: {
			PATH: `${bin}:${process.env.PATH}`,
			GH_TOKEN: "dummy",
			PR: "7",
			GITHUB_REPOSITORY: "o/r",
			GITHUB_REF: ref,
			DEFAULT_BRANCH: "main",
			ACTION: "synchronize",
			BOT: "sunny-reviewer",
			ADMIN: "sssoto17",
			THREADS_QUERY: "query",
			RUNNER_TEMP: temp,
			GITHUB_OUTPUT: join(dir, "out"),
			GITHUB_ENV: join(dir, "env"),
		},
	});
	const ctx = join(temp, "review-context");
	return {
		code: res.status,
		log: res.stdout + res.stderr,
		output: readFileSync(join(dir, "out"), "utf8"),
		ctx: (f) => readFileSync(join(ctx, f)),
	};
}

// The Report step's own shell, after a gather step that ended with `outcome`.
function report({ outcome, failure = "", gate = "true" }) {
	dir = mkdtempSync(join(tmpdir(), "review-report-"));
	writeFileSync(join(dir, "summary"), "");
	const res = spawnSync("bash", ["-c", runBlock(yml, "Report")], {
		cwd: ROOT,
		encoding: "utf8",
		env: {
			PATH: process.env.PATH,
			HOME: dir,
			RUNNER_TEMP: dir,
			GATE: gate,
			GATHER: outcome,
			GATHER_FAILURE: failure,
			EXEC_FILE: "",
			GITHUB_STEP_SUMMARY: join(dir, "summary"),
		},
	});
	return {
		code: res.status,
		log: res.stdout + res.stderr,
		summary: readFileSync(join(dir, "summary"), "utf8"),
	};
}

describe("review.yml (#648)", () => {
	it("gathers a diff that holds escape sequences, with each one visible", () => {
		const g = gather();
		expect(g.log).not.toMatch(/fake gh: unexpected call/);
		expect(g.code).toBe(0);
		expect(g.output).toMatch(/^run=true$/m);
		expect(g.ctx("diff.patch").equals(SHOWN)).toBe(true);
		expect(g.ctx("diff-escapes.txt").toString().trim()).toBe(SUMMARY);
		expect(g.log).toContain(SUMMARY);
		expect(g.output).not.toMatch(/^failure=/m);
	});

	it("records why gather failed, naming the command and its line", () => {
		const g = gather({ fails: "diff" });
		expect(g.code).toBe(1);
		const failure = g.output.match(/^failure=(.*)$/m)?.[1];
		expect(failure).toMatch(
			/^gather stopped at line \d+ \(exit 1\): gh api -H "Accept: application\/vnd\.github\.diff" /,
		);
	});

	// bash names a pipeline's last command, here `jq -s .`, so the reason gives every status.
	it("names a failed pipeline with each command's status", () => {
		const g = gather({ fails: "files" });
		expect(g.code).toBe(1);
		expect(g.output.match(/^failure=(.*)$/m)?.[1]).toMatch(
			/^gather stopped at line \d+ \(exit 1\): a pipeline \(statuses 1 0\) ending in jq -s \. > "\$CTX\/files\.json"$/,
		);
	});

	it("records why gather stopped on a run that isn't the default branch's", () => {
		const g = gather({ ref: "refs/heads/other" });
		expect(g.code).toBe(1);
		expect(g.output.match(/^failure=(.*)$/m)?.[1]).toBe(
			"this run's ref is not the default branch: nothing reviewed",
		);
	});

	it("reports gather's own reason, not a missing execution file", () => {
		const reason = "gather stopped at line 40 (exit 1): gh api -H x 100%";
		const r = report({ outcome: "failure", failure: reason });
		expect(r.code).toBe(1);
		expect(r.log).toContain(
			"::error title=Gather failed::gather stopped at line 40 (exit 1): gh api -H x 100%25",
		);
		expect(r.log).not.toContain("no execution file");
		expect(r.summary).toContain(reason);
	});

	it("still names a gather failure that left no reason", () => {
		const r = report({ outcome: "failure", gate: "" });
		expect(r.code).toBe(1);
		expect(r.log).toMatch(/::error title=Gather failed::.*its log says why/);
	});

	it("keeps #381's error when gather passed but Claude left no execution file", () => {
		const r = report({ outcome: "success" });
		expect(r.code).toBe(1);
		expect(r.log).toContain("no execution file (#381)");
	});

	it("tells the reviewer about the markers", () => {
		const prompt = readFileSync(join(ROOT, ".github/review-prompt.md"), "utf8");
		expect(prompt).toContain("`diff-escapes.txt`");
		expect(prompt).toContain("`<ESC>`");
	});
});
