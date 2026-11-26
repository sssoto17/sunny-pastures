import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { runBlock } from "./workflow-step.mjs";

const WORKFLOW = fileURLToPath(new URL("../../workflows/factory.yml", import.meta.url));
const yml = readFileSync(WORKFLOW, "utf8");

let dir;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

// GitHub's default shell for run: (`bash --noprofile --norc -eo pipefail {0}`).
const bash = (script, env, cwd) =>
	spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
		cwd,
		encoding: "utf8",
		env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", ...env },
	});

const git = (cwd, ...args) => {
	const res = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			PATH: process.env.PATH,
			HOME: dir,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_AUTHOR_NAME: "sunny-factory[bot]",
			GIT_AUTHOR_EMAIL: "355564973+sunny-factory[bot]@users.noreply.github.com",
			GIT_COMMITTER_NAME: "sunny-factory[bot]",
			GIT_COMMITTER_EMAIL: "355564973+sunny-factory[bot]@users.noreply.github.com",
		},
	});
	if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
	return res.stdout.trim();
};

// #646: the "Pack the hand-off" step, run as the workflow has it, on a checkout of main where
// Claude may or may not have made the branch its hand-off names. Run 45279925105 (#596) crashed in
// `git bundle` with "unknown revision" on a branch the checkout didn't have, and logged no reason.
describe("factory.yml, the hand-off (#646)", () => {
	const script = runBlock(yml, "Pack the hand-off");

	// A repo on main, then what Claude left: `setup(repo)` runs in it after main's commit, and
	// `files` are the hand-off files in OUT.
	function pack({ setup, files = {}, env = {} } = {}) {
		dir = mkdtempSync(join(tmpdir(), "factory-handoff-"));
		const repo = join(dir, "repo");
		const out = join(dir, "out");
		const temp = join(dir, "temp");
		mkdirSync(repo);
		mkdirSync(out);
		mkdirSync(temp);
		git(repo, "init", "-q", "-b", "main");
		writeFileSync(join(repo, "README"), "base\n");
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "base");
		const sha = git(repo, "rev-parse", "HEAD");
		setup?.(repo);
		for (const [name, text] of Object.entries(files)) writeFileSync(join(out, name), text);
		const output = join(temp, "output");
		writeFileSync(output, "");
		const res = bash(
			script,
			{
				OUT: out,
				ISSUE: "596",
				GITHUB_SHA: sha,
				RUNNER_TEMP: temp,
				GITHUB_OUTPUT: output,
				FIX_PR: "",
				FIX_BRANCH: "",
				FIX_HEAD: "",
				...env,
			},
			repo,
		);
		return {
			code: res.status,
			result: res.stdout.split("\n").filter((l) => l.startsWith("RESULT ")),
			errors: res.stdout.split("\n").filter((l) => l.startsWith("::error")),
			stderr: res.stderr,
			output: readFileSync(output, "utf8"),
		};
	}

	const commitOn =
		(branch, { from = "main" } = {}) =>
		(repo) => {
			git(repo, "switch", "-q", "-c", branch, from);
			writeFileSync(join(repo, "client.ts"), "export {};\n");
			git(repo, "add", ".");
			git(repo, "commit", "-q", "-m", "feat(web): client (#596)");
		};
	const handoff = {
		branch: "596-session-api-client\n",
		"pr-body.md": "feat: x (#596)\n\nCloses #596\n",
	};

	it("packs a branch with commits past main", () => {
		const r = pack({ setup: commitOn("596-session-api-client"), files: handoff });
		expect(r.code).toBe(0);
		expect(r.result).toEqual([
			expect.stringMatching(/^RESULT handoff=596-session-api-client commits=1 bytes=\d+$/),
		]);
		expect(r.output).toMatch(/^handoff=\S+\n$/);
	});

	it("fails with a clear RESULT line, not a git bundle crash, when the branch doesn't exist", () => {
		// Run 45279925105's shape: Claude's commits are on another branch than the one it named.
		const r = pack({ setup: commitOn("596-session-client"), files: handoff });
		expect(r.code).toBe(1);
		expect(r.result).toEqual([
			"RESULT handoff=none: branch 596-session-api-client doesn't exist (HEAD: 596-session-client; other branches: 596-session-client+1)",
		]);
		expect(r.errors).toEqual([
			"::error title=Factory hand-off::branch 596-session-api-client doesn't exist",
		]);
		expect(r.stderr).not.toMatch(/fatal|unknown revision/);
		expect(r.output).toBe("");
	});

	it("names a detached HEAD and no other branches", () => {
		const r = pack({ setup: (repo) => git(repo, "switch", "-q", "--detach"), files: handoff });
		expect(r.code).toBe(1);
		expect(r.result).toEqual([
			expect.stringMatching(
				/^RESULT handoff=none: branch 596-session-api-client doesn't exist \(HEAD: detached at [0-9a-f]+; other branches: none\)$/,
			),
		]);
	});

	it("fails when the branch has no commits past main", () => {
		const r = pack({
			setup: (repo) => git(repo, "switch", "-q", "-c", "596-session-api-client"),
			files: handoff,
		});
		expect(r.code).toBe(1);
		expect(r.result).toEqual([
			"RESULT handoff=none: branch 596-session-api-client has no commits (HEAD: 596-session-api-client; other branches: none)",
		]);
		expect(r.output).toBe("");
	});

	it("fails when Claude wrote no PR body, instead of crashing in cp", () => {
		const r = pack({
			setup: commitOn("596-session-api-client"),
			files: { branch: handoff.branch },
		});
		expect(r.code).toBe(1);
		expect(r.result).toEqual([
			expect.stringMatching(
				/^RESULT handoff=none: Claude wrote no PR body for 596-session-api-client /,
			),
		]);
	});

	it("still ends green with handoff=none when Claude wrote no branch (a stop)", () => {
		const r = pack({});
		expect(r.code).toBe(0);
		expect(r.result).toEqual(["RESULT handoff=none: Claude wrote no branch"]);
	});

	it("fails in fix mode when the PR's branch is gone", () => {
		const r = pack({
			setup: (repo) => git(repo, "switch", "-q", "--detach"),
			env: { FIX_PR: "639", FIX_BRANCH: "598-sprite-manifest", FIX_HEAD: "0".repeat(40) },
		});
		expect(r.code).toBe(1);
		expect(r.result).toEqual([
			expect.stringMatching(
				/^RESULT handoff=none: branch 598-sprite-manifest doesn't exist \(HEAD: detached at /,
			),
		]);
	});
});

// #646: "Claude's last turns" prints a digest of the execution file for the public log.
describe("factory.yml, Claude's last turns (#646)", () => {
	const script = runBlock(yml, "Claude's last turns");

	function turns(exec) {
		dir = mkdtempSync(join(tmpdir(), "factory-turns-"));
		const env = { RUNNER_TEMP: dir };
		if (exec !== undefined) {
			env.EXEC_FILE = join(dir, "exec.json");
			writeFileSync(env.EXEC_FILE, typeof exec === "string" ? exec : JSON.stringify(exec));
		}
		const res = bash(script, env, dir);
		return { code: res.status, lines: res.stdout.split("\n").filter(Boolean) };
	}

	const call = (id, name, input) => ({
		type: "assistant",
		message: { content: [{ type: "tool_use", id, name, input }] },
	});
	const answer = (id, content, is_error = false) => ({
		type: "user",
		message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] },
	});
	const result = (text, denials = []) => ({
		type: "result",
		subtype: "success",
		result: text,
		permission_denials: denials,
	});

	it("lists the calls with their gist, errors, denials and the final message's last lines", () => {
		const r = turns([
			{ type: "system", subtype: "init" },
			call("t1", "Bash", { command: "git switch -c 596-session-client", description: "branch" }),
			answer("t1", "Switched to a new branch"),
			call("t2", "Write", { file_path: "/w/client.ts", content: "SECRET FILE TEXT" }),
			answer("t2", [{ type: "text", text: "File created" }]),
			call("t3", "Bash", { command: "git commit -m x" }),
			answer("t3", [{ type: "text", text: "Blocked: fallow audit failed" }], true),
			call("t4", "Task", { description: "review the branch", prompt: "long prompt" }),
			result("All done.\nFACTORY ready: 596-session-api-client", [
				{ tool_name: "Bash", tool_use_id: "t9", tool_input: { command: "git push" } },
			]),
		]);
		expect(r.code).toBe(0);
		expect(r.lines).toEqual([
			"TURNS call Bash git switch -c 596-session-client",
			"TURNS call Write /w/client.ts",
			"TURNS call Bash git commit -m x -> error: Blocked: fallow audit failed",
			"TURNS call Task review the branch -> no result",
			"TURNS denied Bash git push",
			"TURNS said All done.",
			"TURNS said FACTORY ready: 596-session-api-client",
		]);
		expect(r.lines.join("\n")).not.toMatch(/SECRET FILE TEXT|Switched to|long prompt/);
	});

	it("keeps only the last 25 calls", () => {
		const calls = Array.from({ length: 30 }, (_, i) =>
			call(`t${i}`, "Read", { file_path: `/f${i}` }),
		);
		const r = turns([...calls, result("")]);
		const listed = r.lines.filter((l) => l.startsWith("TURNS call"));
		expect(listed).toHaveLength(25);
		expect(listed[0]).toBe("TURNS call Read /f5 -> no result");
	});

	it("runs no workflow command, keeps one line per entry and redacts token shapes", () => {
		const r = turns([
			call("t1", "Bash", {
				command: "echo ghp_abcdefghijklmnopqrstuvwxyz0123456789\n::add-mask::x",
			}),
			answer("t1", "::error::y \u001b[31m##[group]z sk-ant-oat01-abc_DEF", true),
			result("::warning::w\nok ::stop-commands::t"),
		]);
		expect(r.lines).toEqual([
			"TURNS call Bash echo [redacted] :add-mask:x -> error: :error:y  [31m[group]z [redacted]",
			"TURNS said :warning:w",
			"TURNS said ok :stop-commands:t",
		]);
		for (const l of r.lines) expect(l).toMatch(/^TURNS [^\r\n]{0,220}$/);
	});

	it("caps each entry at 200 characters", () => {
		const r = turns([call("t1", "Bash", { command: "x".repeat(500) }), result("")]);
		expect(r.lines[0]).toBe(`TURNS call Bash ${"x".repeat(200)} -> no result`);
	});

	it.each([
		["no execution file", undefined, "TURNS none: no execution file"],
		["a file that isn't JSON", "not json", "TURNS none: the execution file isn't readable JSON"],
	])("prints one line and stays green for %s", (_name, exec, line) => {
		const r = turns(exec);
		expect(r.code).toBe(0);
		expect(r.lines).toEqual([line]);
	});

	it("runs whatever happened, after Claude's result", () => {
		const step = yml.slice(yml.indexOf("name: Claude's last turns"));
		expect(step).toMatch(/^name: Claude's last turns\n {8}if: always\(\)\n/);
		expect(yml.indexOf("name: Claude's last turns")).toBeGreaterThan(
			yml.indexOf("name: Claude's result"),
		);
		expect(yml.indexOf("name: Claude's last turns")).toBeLessThan(yml.indexOf("\n  publish:"));
	});
});
