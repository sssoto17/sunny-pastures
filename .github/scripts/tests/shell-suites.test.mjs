import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../shell-suites.sh", import.meta.url));

let dir;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

// A repo folder holding the given files ({ path: body }), each written without the executable bit:
// the runner starts every suite with bash, as the suites' headers say to.
function run(files, env = {}, input = "") {
	dir = mkdtempSync(join(tmpdir(), "shell-suites-"));
	for (const [path, body] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), body);
	}
	const res = spawnSync("bash", [SCRIPT], {
		cwd: dir,
		encoding: "utf8",
		input,
		env: { PATH: process.env.PATH, TMPDIR: dir, ...env },
	});
	return { code: res.status, out: res.stdout + res.stderr };
}

const passes = (name) => `echo "${name} ran"\n`;

describe("shell-suites.sh", () => {
	it("runs every suite under scripts/ and .claude/hooks/, and passes when they all pass", () => {
		const r = run({
			"scripts/a.test.sh": passes("a"),
			"scripts/setup/b.test.sh": passes("b"),
			".claude/hooks/c.test.sh": passes("c"),
			"scripts/a.sh": passes("not a suite"),
			"apps/d.test.sh": passes("outside the scope"),
		});
		expect(r.code).toBe(0);
		expect(r.out).toContain("a ran");
		expect(r.out).toContain("b ran");
		expect(r.out).toContain("c ran");
		expect(r.out).not.toContain("not a suite");
		expect(r.out).not.toContain("outside the scope");
		expect(r.out).toContain("3 suites: 3 passed, 0 failed");
	});

	it("runs every suite even after one fails, then fails and names each failed suite", () => {
		const r = run({
			"scripts/a.test.sh": "echo 'a broke'; exit 1\n",
			"scripts/b.test.sh": passes("b"),
			"scripts/setup/c.test.sh": "exit 3\n",
			".claude/hooks/h.test.sh": passes("h"),
		});
		expect(r.code).toBe(1);
		expect(r.out).toContain("b ran");
		expect(r.out).toContain("4 suites: 2 passed, 2 failed");
		expect(r.out).toMatch(/Failed:\n {2}scripts\/a\.test\.sh\n {2}scripts\/setup\/c\.test\.sh/);
	});

	it("ends with each suite's result and wall time, so a slow suite shows", () => {
		const r = run({
			"scripts/a.test.sh": "exit 1\n",
			"scripts/slow.test.sh": "sleep 1.2\n",
			".claude/hooks/h.test.sh": passes("h"),
		});
		expect(r.out).toMatch(/^FAIL +\d+s +scripts\/a\.test\.sh$/m);
		expect(r.out).toMatch(/^ok +[12]s +scripts\/slow\.test\.sh$/m);
	});

	it("folds each suite's log and annotates each failure on Actions, and only there", () => {
		const files = {
			"scripts/a.test.sh": "exit 1\n",
			"scripts/b.test.sh": passes("b"),
			".claude/hooks/h.test.sh": passes("h"),
		};
		const ci = run(files, { GITHUB_ACTIONS: "true" });
		expect(ci.out).toContain("::group::scripts/a.test.sh\n");
		expect(ci.out).toContain("::group::scripts/b.test.sh\nb ran\n::endgroup::");
		expect(ci.out).toContain("::error title=ci / scripts::scripts/a.test.sh failed");
		expect(ci.out).not.toContain("::error title=ci / scripts::scripts/b.test.sh");
		expect(run(files).out).not.toContain("::");
	});

	it("fails when a folder holds no suite, so a moved folder can't drop its suites quietly", () => {
		const r = run({ "scripts/a.test.sh": passes("a"), ".claude/hooks/h.sh": passes("h") });
		expect(r.code).toBe(1);
		expect(r.out).toContain("no *.test.sh suite found under .claude/hooks/");
		expect(r.out).not.toContain("a ran");
		const empty = run({ "scripts/a.sh": passes("a") });
		expect(empty.code).toBe(1);
		expect(empty.out).toContain("no *.test.sh suite found under scripts/");
	});

	it("keeps the real gh and its token out of reach of a suite that forgets its fake", () => {
		// Stands in for the runner's real gh: it would answer, so reaching it must not be possible.
		const real = mkdtempSync(join(tmpdir(), "shell-suites-real-"));
		writeFileSync(join(real, "gh"), "#!/usr/bin/env bash\necho 'real gh answered'\n", {
			mode: 0o755,
		});
		try {
			const r = run(
				{
					"scripts/forgot.test.sh":
						'echo "token:${GH_TOKEN-}${GITHUB_TOKEN-}:"; read -r x; echo "stdin:${x-}:"\n' +
						'echo "config:$GH_CONFIG_DIR:$(ls -A "$GH_CONFIG_DIR" | wc -l)"; gh api user\n',
					"scripts/faked.test.sh":
						'mkdir -p "$TMPDIR/bin"; printf "#!/bin/sh\\necho fake gh\\n" >"$TMPDIR/bin/gh"\n' +
						'chmod +x "$TMPDIR/bin/gh"; PATH="$TMPDIR/bin:$PATH" gh api user\n',
					".claude/hooks/h.test.sh": passes("h"),
				},
				{ PATH: `${real}:${process.env.PATH}`, GH_TOKEN: "t0k", GITHUB_TOKEN: "t0k" },
				"typed by a person\n",
			);
			expect(r.code).toBe(1);
			expect(r.out).not.toContain("real gh answered");
			expect(r.out).not.toContain("t0k");
			expect(r.out).toContain("token::");
			expect(r.out).toContain("stdin::"); // the input below never reaches a suite
			expect(r.out).toMatch(/config:[^:]*shell-suites\.[^:]*\/gh-config: *0\n/);
			expect(r.out).toContain("a suite reached the real gh");
			expect(r.out).toContain("fake gh");
			expect(r.out).toContain("Failed:\n  scripts/forgot.test.sh");
			expect(r.out).toMatch(/^ok +\d+s +scripts\/faked\.test\.sh$/m);
		} finally {
			rmSync(real, { recursive: true, force: true });
		}
	});
});
