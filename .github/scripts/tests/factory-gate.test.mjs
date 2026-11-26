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

const SCRIPT = fileURLToPath(new URL("../factory-gate.sh", import.meta.url));
const GATHER = fileURLToPath(new URL("../factory-gather.sh", import.meta.url));
const WORKFLOW = fileURLToPath(new URL("../../workflows/factory.yml", import.meta.url));

// The issue as `GET /repos/{o}/{r}/issues/{n}` returns it, trimmed to what the gate reads.
const issue = ({
	number = 42,
	state = "open",
	labels = ["factory:ready", "chore"],
	author = "OWNER",
	pr,
} = {}) => ({
	number,
	state,
	author_association: author,
	labels: labels.map((name) => ({ name })),
	...(pr ? { pull_request: { url: "x" } } : {}),
});

let dir;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

function gate({
	input = "42",
	turns,
	issueJson = issue(),
	blockers = [],
	pulls = [],
	refs = [],
} = {}) {
	dir = mkdtempSync(join(tmpdir(), "factory-gate-"));
	writeFileSync(join(dir, "issue.json"), JSON.stringify(issueJson));
	writeFileSync(join(dir, "blockers.json"), JSON.stringify(blockers));
	writeFileSync(join(dir, "pulls.json"), JSON.stringify(pulls));
	writeFileSync(join(dir, "refs.json"), JSON.stringify(refs));
	writeFileSync(join(dir, "out"), "");
	writeFileSync(join(dir, "summary"), "");
	const env = {
		PATH: process.env.PATH,
		ISSUE: input,
		ISSUE_JSON: join(dir, "issue.json"),
		BLOCKERS_JSON: join(dir, "blockers.json"),
		PULLS_JSON: join(dir, "pulls.json"),
		REFS_JSON: join(dir, "refs.json"),
		GITHUB_OUTPUT: join(dir, "out"),
		GITHUB_STEP_SUMMARY: join(dir, "summary"),
	};
	if (turns !== undefined) env.MAX_TURNS = turns;
	const res = spawnSync("bash", [SCRIPT], { cwd: dir, encoding: "utf8", env });
	const out = readFileSync(join(dir, "out"), "utf8");
	const field = (k) => out.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1];
	return {
		code: res.status,
		log: res.stdout + res.stderr,
		outFile: out,
		run: field("run"),
		issue: field("issue"),
		turns: field("turns"),
		why: field("why"),
	};
}

describe("factory-gate.sh", () => {
	it("says run=true for an open factory:ready issue the owner opened, with the 100-turn cap", () => {
		const g = gate();
		expect(g.code).toBe(0);
		expect(g.run).toBe("true");
		expect(g.issue).toBe("42");
		expect(g.turns).toBe("100");
		expect(g.log).toMatch(
			/^GATE run: #42 is open, opened by a OWNER, carries factory:ready, isn't blocked and has no PR or branch \(max-turns 100\)/m,
		);
	});

	// #619: the sweep moves an issue to factory:working before it dispatches it.
	it("passes an issue the sweep moved to factory:working", () => {
		const g = gate({ issueJson: issue({ labels: ["factory:working"] }) });
		expect(g.run).toBe("true");
		expect(g.log).toMatch(/^GATE run: #42 .* carries factory:working,/m);
	});

	it.each([["factory:review"], ["factory:failed"]])("refuses an issue at %s", (label) => {
		const g = gate({ issueJson: issue({ labels: [label] }) });
		expect(g.run).toBe("false");
		expect(g.log).toMatch(/^GATE refused: #42 doesn't carry factory:ready/m);
	});

	// #619: blockers gate pickup, the native ones and the blocked:* labels.
	it("refuses an issue with an open native blocker, and names them in why=", () => {
		const g = gate({ blockers: [594, 600] });
		expect(g.run).toBe("false");
		expect(g.log).toMatch(/^GATE refused: #42 is blocked by #594, #600$/m);
		expect(g.why).toBe("#42 is blocked by #594, #600");
	});

	it("refuses an issue carrying a blocked:* label", () => {
		const g = gate({ issueJson: issue({ labels: ["factory:ready", "blocked:decision"] }) });
		expect(g.run).toBe("false");
		expect(g.log).toMatch(/^GATE refused: #42 carries blocked:decision$/m);
	});

	it("fails the step on a blocker list that isn't a JSON array, rather than guess", () => {
		const g = gate({ blockers: "gh: HTTP 502" });
		expect(g.code).not.toBe(0);
		expect(g.outFile).not.toMatch(/^run=/m);
	});

	it.each(["MEMBER", "COLLABORATOR"])("passes an issue opened by a %s", (author) => {
		expect(gate({ issueJson: issue({ author }) }).run).toBe("true");
	});

	it.each([
		["empty", ""],
		["zero", "0"],
		["negative", "-3"],
		["a leading zero", "042"],
		["text", "abc"],
		["a decimal", "4.2"],
		["a shell injection", "42; echo hi"],
		["a newline forging an output", "42\nrun=true"],
		["too long", "12345678"],
	])("refuses an issue input that is %s, before reading anything", (_n, input) => {
		const g = gate({ input });
		expect(g.code).toBe(0);
		expect(g.run).toBe("false");
		expect(g.log).toMatch(/^GATE refused: the issue input .* isn't an issue number/m);
		expect(g.outFile).not.toMatch(/^run=true$/m);
		expect(g.outFile).not.toMatch(/^issue=/m);
	});

	// The repo is public: a stranger's issue text must never reach a Claude.
	it.each(["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER"])(
		"refuses an issue opened by a %s",
		(author) => {
			const g = gate({ issueJson: issue({ author }) });
			expect(g.run).toBe("false");
			expect(g.log).toMatch(
				new RegExp(
					`^GATE refused: #42 was opened by a ${author}, not the owner or a collaborator`,
					"m",
				),
			);
		},
	);

	it("refuses an issue that doesn't say who opened it", () => {
		const bare = issue();
		delete bare.author_association;
		const g = gate({ issueJson: bare });
		expect(g.run).toBe("false");
		expect(g.log).toMatch(/opened by a NONE/);
	});

	it("refuses an issue without factory:ready", () => {
		const g = gate({ issueJson: issue({ labels: ["chore"] }) });
		expect(g.run).toBe("false");
		expect(g.log).toMatch(/^GATE refused: #42 doesn't carry factory:ready/m);
	});

	it("refuses a closed issue", () => {
		const g = gate({ issueJson: issue({ state: "closed" }) });
		expect(g.run).toBe("false");
		expect(g.log).toMatch(/^GATE refused: #42 is closed/m);
	});

	it("refuses a pull request (the issues endpoint returns those too)", () => {
		const g = gate({ issueJson: issue({ pr: true }) });
		expect(g.run).toBe("false");
		expect(g.log).toMatch(/^GATE refused: #42 is a pull request/m);
	});

	it("refuses when the JSON describes another issue", () => {
		const g = gate({ issueJson: issue({ number: 7 }) });
		expect(g.run).toBe("false");
		expect(g.log).toMatch(/^GATE refused: .*#7.*not #42/m);
	});

	it("refuses an issue that doesn't exist (the read left {}), rather than fail the step", () => {
		const g = gate({ issueJson: {} });
		expect(g.code).toBe(0);
		expect(g.run).toBe("false");
		expect(g.log).toMatch(/^GATE refused: #42 doesn't exist or can't be read/m);
	});

	// The duplicate guard (admin, 21 Nov 2026, decision 10).
	it("refuses an issue that already has an open PR from a <n>- branch", () => {
		const g = gate({ pulls: [{ number: 7, head: { ref: "42-earlier-try" } }] });
		expect(g.run).toBe("false");
		expect(g.log).toMatch(/^GATE refused: #42 already has PR #7 from a 42- branch/m);
	});

	it("refuses an issue that already has a <n>- branch", () => {
		const g = gate({ refs: [{ ref: "refs/heads/42-half-done" }] });
		expect(g.run).toBe("false");
		expect(g.log).toMatch(/^GATE refused: #42 already has the branch 42-half-done/m);
	});

	it("ignores other issues' PRs and branches, 420- included", () => {
		const g = gate({
			pulls: [
				{ number: 8, head: { ref: "420-other" } },
				{ number: 9, head: { ref: "claude/42-x" } },
			],
			refs: [{ ref: "refs/heads/420-other" }],
		});
		expect(g.run).toBe("true");
	});

	it("fails the step on a PR list that isn't JSON, rather than guess", () => {
		dir = mkdtempSync(join(tmpdir(), "factory-gate-"));
		for (const [f, c] of [
			["issue.json", JSON.stringify(issue())],
			["blockers.json", "[]"],
			["pulls.json", "gh: HTTP 502"],
			["refs.json", "[]"],
			["out", ""],
		])
			writeFileSync(join(dir, f), c);
		const res = spawnSync("bash", [SCRIPT], {
			encoding: "utf8",
			env: {
				PATH: process.env.PATH,
				ISSUE: "42",
				ISSUE_JSON: join(dir, "issue.json"),
				BLOCKERS_JSON: join(dir, "blockers.json"),
				PULLS_JSON: join(dir, "pulls.json"),
				REFS_JSON: join(dir, "refs.json"),
				GITHUB_OUTPUT: join(dir, "out"),
			},
		});
		expect(res.status).not.toBe(0);
		expect(readFileSync(join(dir, "out"), "utf8")).not.toMatch(/^run=true$/m);
	});

	it("writes a refusal to the step summary as well as the log", () => {
		gate({ issueJson: issue({ labels: [] }) });
		expect(readFileSync(join(dir, "summary"), "utf8")).toMatch(/Refused: #42 doesn't carry/);
	});

	it.each([
		["5", "5"],
		["100", "100"],
		["", "100"],
	])("takes max_turns %j as %s", (turns, want) => {
		const g = gate({ turns });
		expect(g.run).toBe("true");
		expect(g.turns).toBe(want);
	});

	it.each(["0", "101", "1000", "-1", "5 --dangerously-skip-permissions", "ten"])(
		"refuses max_turns %j: the input may only lower the cap",
		(turns) => {
			const g = gate({ turns });
			expect(g.run).toBe("false");
			expect(g.log).toMatch(/^GATE refused: max_turns .* must be a whole number from 1 to 100/m);
		},
	);
});

// The reads, with a fake gh that answers from files and logs each call. It answers as gh would
// after its --jq: the blocked_by read prints the open blockers' numbers, #8 when `blocked`.
function gather({ input = "42", issueStatus = 0, blocked = false } = {}) {
	dir = mkdtempSync(join(tmpdir(), "factory-gather-"));
	mkdirSync(join(dir, "bin"));
	writeFileSync(join(dir, "issue.json"), JSON.stringify(issue()));
	writeFileSync(
		join(dir, "bin", "gh"),
		`#!/usr/bin/env bash
printf '%s\\n' "$*" >>"${dir}/calls"
case "$*" in
  */dependencies/blocked_by*) [ "${blocked}" = false ] || echo 8 ;;
  */issues/*) [ "${issueStatus}" = 0 ] || { echo 'gh: Not Found (HTTP 404)' >&2; exit 1; }; cat "${dir}/issue.json" ;;
  *pulls*) echo '{"number":3,"head":{"ref":"5-x"}}' ;;
  *matching-refs*) echo '[]' ;;
  *) exit 99 ;;
esac
`,
	);
	chmodSync(join(dir, "bin", "gh"), 0o755);
	writeFileSync(join(dir, "out"), "");
	const res = spawnSync("bash", [GATHER], {
		encoding: "utf8",
		env: {
			PATH: `${join(dir, "bin")}:${process.env.PATH}`,
			ISSUE: input,
			GITHUB_REPOSITORY: "o/r",
			RUNNER_TEMP: dir,
			GITHUB_OUTPUT: join(dir, "out"),
		},
	});
	const calls = existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8") : "";
	return {
		code: res.status,
		log: res.stdout + res.stderr,
		out: readFileSync(join(dir, "out"), "utf8"),
		calls,
	};
}

describe("factory-gather.sh", () => {
	it("reads the issue, the open PRs and the issue's branches, then gates", () => {
		const g = gather();
		expect(g.code).toBe(0);
		expect(g.out).toMatch(/^run=true$/m);
		expect(g.calls).toContain("api repos/o/r/issues/42");
		expect(g.calls).toContain("repos/o/r/issues/42/dependencies/blocked_by?per_page=100");
		expect(g.calls).toContain("repos/o/r/pulls?state=open&per_page=100");
		expect(g.calls).toContain("api repos/o/r/git/matching-refs/heads/42-");
	});

	it("refuses an issue whose open native blocker it read (#619)", () => {
		const g = gather({ blocked: true });
		expect(g.code).toBe(0);
		expect(g.log).toMatch(/^GATE refused: #42 is blocked by #8$/m);
	});

	it("logs a missing issue as a GATE refusal, not a failed step", () => {
		const g = gather({ issueStatus: 1 });
		expect(g.code).toBe(0);
		expect(g.calls).not.toContain("blocked_by");
		expect(g.log).toMatch(/^GATE refused: #42 doesn't exist or can't be read/m);
	});

	it("puts nothing but a number in a URL", () => {
		const g = gather({ input: "../../x" });
		expect(g.code).toBe(0);
		expect(g.calls).toBe("");
		expect(g.log).toMatch(/^GATE refused: the issue input/m);
	});
});

// The scripts only answer; the workflow makes those answers stop the run before a token or Claude.
// Read as text, as factory-enabled.test.mjs reads the switch: the repo has no YAML parser, and
// adding one needs the admin. Comments are dropped, since the header quotes snippets.
describe("factory.yml", () => {
	const yml = readFileSync(WORKFLOW, "utf8")
		.split("\n")
		.filter((l) => !l.trimStart().startsWith("#"))
		.join("\n");
	// One job's lines: from its two-space key to the next one.
	const job = (name) =>
		yml.match(new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  \\S|(?![\\s\\S]))`, "m"))[0];
	const gateJob = job("gate");
	const factory = job("factory");
	const publish = job("publish");
	const labels = job("labels");
	const report = job("report");

	it("starts only from workflow_dispatch, with an issue number", () => {
		expect(yml).toMatch(/^on:\n {2}workflow_dispatch:\n {4}inputs:\n {6}issue:\n/m);
		expect(yml).not.toMatch(
			/^ {2}(push|pull_request\w*|schedule|repository_dispatch|workflow_run):/m,
		);
	});

	it("calls the kill switch first, as factory-switch.yml's header says, holding no secret", () => {
		expect(job("switch")).toBe(
			"  switch:\n    uses: ./.github/workflows/factory-switch.yml\n    permissions:\n      contents: read\n\n",
		);
		expect(gateJob).toMatch(/^ {4}needs: switch\n {4}if: needs\.switch\.outputs\.run == 'true'\n/m);
		expect(factory).toMatch(
			/^ {4}needs: \[switch, gate\]\n {4}if: needs\.switch\.outputs\.run == 'true' && needs\.gate\.outputs\.run == 'true'\n/m,
		);
		expect(publish).toMatch(/^ {4}if: needs\.factory\.outputs\.handoff != ''\n/m);
	});

	it("keeps GITHUB_TOKEN read-only in every job", () => {
		expect(yml).toMatch(/^permissions: \{\}$/m);
		const levels = [...yml.matchAll(/^ {6}([a-z-]+): (read|write|none)\b/gm)];
		expect(levels.length).toBeGreaterThan(0);
		for (const [, , level] of levels) expect(level).toBe("read");
	});

	it("runs one factory run at a time and never cancels a running one", () => {
		expect(yml).toMatch(/^concurrency:\n {2}group: factory\n {2}cancel-in-progress: false\n/m);
	});

	it("gates with the read-only token and no environment, so a refusal never reaches a secret", () => {
		expect(gateJob).not.toMatch(/environment:|secrets\.|create-github-app-token/);
		expect(gateJob).toContain("run: bash .github/scripts/factory-gather.sh");
	});

	// Required (review of 39bcd47): the model never shares a runner with a write credential.
	// Decision 12 (admin, 21 Nov 2026): Claude's runner never enters the environment with the key.
	it("runs Claude in claude-seat; only publish and labels, on fresh runners, hold the App's key", () => {
		expect(factory).toMatch(/^ {4}environment: claude-seat$/m);
		expect(publish).toMatch(/^ {4}environment: factory$/m);
		expect(labels).toMatch(/^ {4}environment: factory$/m);
		const withKey = ["switch", "gate", "factory", "publish", "labels", "report"].filter((j) =>
			job(j).includes("FACTORY_APP_PRIVATE_KEY"),
		);
		expect(withKey).toEqual(["publish", "labels"]);
		expect(yml.match(/environment: factory$/gm)).toHaveLength(2);
		expect(labels).not.toMatch(/claude-code-action|needs\.factory\.outputs\.handoff/);
	});

	// #107's live test: Claude Code refuses to start with the scrub on and no bubblewrap.
	it("installs bubblewrap and smoke-tests it before Claude, keeping the env scrub on", () => {
		const install = factory.indexOf("name: Install bubblewrap for the env scrub");
		expect(install).toBeGreaterThan(-1);
		expect(install).toBeLessThan(factory.indexOf("id: claude"));
		const step = factory.slice(install, factory.indexOf("id: claude"));
		expect(step).toMatch(/sudo apt-get install -y .*bubblewrap/);
		expect(step).toContain("bwrap --ro-bind / / --dev /dev --proc /proc --unshare-pid true");
		expect(step).not.toMatch(/uses:/);
		// A broken bwrap must stop the job: no continue-on-error, and the error line exits 1.
		expect(step).not.toMatch(/continue-on-error/);
		expect(step).toMatch(/::error::bwrap can't create its namespaces[^\n]*\n\s*exit 1/);
		expect(factory).toMatch(/CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1'/);
		expect(yml).not.toMatch(/CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '?0/);
	});

	// #635: the broker does the one write the admin allowed (pnpm-lock.yaml, node_modules), started
	// after bubblewrap and before Claude, holding nothing secret, its answers where Claude can't write.
	it("starts the dependency broker before Claude, with no secret, answering from /srv", () => {
		const start = factory.indexOf("name: Start the dependency broker");
		expect(start).toBeGreaterThan(factory.indexOf("name: Install bubblewrap for the env scrub"));
		expect(start).toBeLessThan(factory.indexOf("id: claude"));
		const step = factory.slice(start, factory.indexOf("id: claude"));
		// Root runs a root-owned copy of the script, never the checkout's, which the file tools can
		// rewrite while bash is still reading it (#645's delta review, N2).
		expect(step).toContain(
			'sudo install -o root -g root -m 0555 .github/scripts/factory-deps.sh "$FACTORY_DEPS_OUT/factory-deps.sh"',
		);
		expect(step).toContain('bash "$FACTORY_DEPS_OUT/factory-deps.sh" serve');
		expect(step).not.toContain("bash .github/scripts/factory-deps.sh serve");
		expect(step).toContain("FACTORY_DEPS_OUT: /srv/factory-deps");
		expect(step).not.toMatch(/secrets\.|github\.token|GH_TOKEN|uses:/);
		expect(step).toMatch(/::error::the dependency broker didn't start"; exit 1/);
		// Root's, so the runner user Claude runs as can't change what it trusts (#645's review);
		// started with a fixed environment, pnpm run as the runner user.
		expect(step).toContain('sudo install -d -o root -g root -m 0755 "$FACTORY_DEPS_OUT"');
		expect(step).toMatch(/sudo -n nohup setsid env -i PATH=\/usr\/bin:\/bin /);
		expect(step).toContain('FACTORY_DEPS_USER="$(id -u):$(id -g)"');
		// The file tools run in Claude's own process, outside its Bash sandbox: denied there too.
		const denied = factory.match(/--disallowedTools "([^"]*)"/)[1].split(",");
		for (const tool of ["Edit", "Write", "MultiEdit"]) {
			expect(denied).toContain(`${tool}(//srv/factory-deps/**)`);
		}
		for (const f of ["pnpm-workspace.yaml", "package.json", ".npmrc", "pnpm-lock.yaml"]) {
			for (const tool of ["Edit", "Write", "MultiEdit"]) {
				expect(denied).toContain(`${tool}(/\${{ github.workspace }}/${f})`);
			}
		}
		const claude = factory.slice(factory.indexOf("id: claude"), factory.indexOf("id: handoff"));
		// Requests go in the hand-off folder, which Claude has with --add-dir.
		expect(claude).toContain("FACTORY_DEPS: ${{ env.OUT }}/deps");
		expect(claude).toContain("--add-dir ${{ env.OUT }}");
		expect(claude).toContain("FACTORY_DEPS_OUT: /srv/factory-deps");
	});

	it("pins the App's bot user id once, for Claude's commits and for publish's identity check", () => {
		expect(yml).toMatch(/^ {2}FACTORY_BOT_ID: '355564973'$/m);
		expect(factory).toContain("bot_id: ${{ env.FACTORY_BOT_ID }}");
		expect(publish).toContain("BOT_ID=$FACTORY_BOT_ID bash .github/scripts/factory-publish.sh");
	});

	it("gives Claude only the read-only token: no App token, no GH_TOKEN env, a scrubbed environment", () => {
		expect(factory).not.toMatch(
			/create-github-app-token|FACTORY_APP_PRIVATE_KEY|GH_TOKEN: \$\{\{ steps\.app/,
		);
		const claude = factory.slice(factory.indexOf("id: claude"), factory.indexOf("id: handoff"));
		expect(claude).toContain("github_token: ${{ github.token }}");
		expect(claude).not.toContain("GH_TOKEN");
		expect(claude).toMatch(/CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1'/);
	});

	it("mints the App's token only on the fresh publish runner, after the hand-off is checked", () => {
		expect(publish.indexOf("factory-publish.sh")).toBeLessThan(
			publish.indexOf("create-github-app-token"),
		);
		expect(publish).not.toMatch(/claude-code-action/);
		const writes = [...yml.matchAll(/permission-([a-z-]+): write/g)].map((m) => m[1]);
		expect(writes).toEqual(["contents", "issues"]);
		expect(publish).not.toContain("permission-issues");
		expect(publish).toContain("scripts/open-pr.sh");
		expect(publish).toContain("core.hooksPath=/dev/null");
	});

	it("caps the factory job at 60 minutes, Claude's step at 55, and Claude at the gate's turns", () => {
		expect(factory).toMatch(/^ {4}timeout-minutes: 60$/m);
		expect(factory).toMatch(/id: claude\n {8}timeout-minutes: 55\n/);
		expect(factory).toContain("--max-turns ${{ needs.gate.outputs.turns }}");
	});

	it("runs Claude on the setup-token, never on an API key, with /implement and no web tools", () => {
		expect(factory).toContain("claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}");
		expect(factory).toMatch(/ANTHROPIC_API_KEY: ''/);
		expect(factory).toContain("format('/implement #{0} Read");
		// Fix mode (#588): the fix-mode section of the prompt, on the gate's checked PR and branch.
		expect(factory).toContain(`its "Fix mode" section. You are fixing PR #{0} on the branch {1}`);
		expect(factory).toMatch(/--disallowedTools "WebFetch,WebSearch/);
	});

	// claude-code-action v1.0.273 made auto mode the default for a run with a prompt and no
	// allowed_bots: a safety review would decide what no allow rule covers, the project's `ask`
	// rules included. The factory keeps the default mode, where those calls are denied (#486).
	it("keeps the default permission mode, so an ask rule still denies", () => {
		const args = factory.slice(factory.indexOf("claude_args: >-"));
		expect(args).toMatch(/^ {12}--permission-mode default$/m);
		expect(factory.match(/--permission-mode/g)).toHaveLength(1);
	});

	it("re-checks the gate before Claude reads the issue, and hands it only trusted comments", () => {
		const ctx = factory.slice(factory.indexOf("id: context"), factory.indexOf("id: claude"));
		expect(ctx).toContain("bash .github/scripts/factory-gather.sh");
		// The re-check stops the job; running the gather alone would only log a refusal.
		expect(ctx).toMatch(
			/factory-gather\.sh\n {10}grep -qx 'run=true' "\$GITHUB_OUTPUT" \|\| \{ .*exit 1; \}\n/,
		);
		// Claude reads the very copy the gate checked, not a second fetch.
		expect(ctx).toContain('"$RUNNER_TEMP/factory-gate/issue.json" >"$ctx/issue.json"');
		expect(ctx).not.toMatch(/gh api "\$r" /);
		expect(ctx).toMatch(
			/select\(\.author_association\s*\|\s*IN\("OWNER", "MEMBER", "COLLABORATOR"\)\)/,
		);
		expect(factory).toContain("--add-dir ${{ runner.temp }}/factory-context");
	});

	it("reuses main's pins of the actions, by full SHA, and adds no other action", () => {
		const pins = new Set([...yml.matchAll(/uses: ([^@\s]+)@(\S+)/g)].map((m) => `${m[1]}@${m[2]}`));
		expect(pins).toEqual(
			new Set([
				"actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
				"actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510",
				"anthropics/claude-code-action@f3b070c88125d33dbae5653df5f143101d4ea9dc",
			]),
		);
	});

	it("never expands an input or the hand-off inside run:", () => {
		for (const [, body] of yml.matchAll(/^ {8}run: \|\n((?: {10}.*\n|\n)+)/gm))
			expect(body).not.toContain("${{");
		const uses = [...yml.matchAll(/\$\{\{\s*inputs\.(\w+)\s*\}\}/g)].map((m) => m[0]);
		// The gate's env alone; the run-name (display text) uses them inside format() (#588).
		expect(uses.sort()).toEqual([
			"${{ inputs.head }}",
			"${{ inputs.issue }}",
			"${{ inputs.max_turns }}",
			"${{ inputs.pr }}",
		]);
		expect(yml).toMatch(
			/^run-name: >-\n {2}\$\{\{ inputs\.pr != '' && format\('factory fix #\{0\} at \{1\}'/m,
		);
		expect(yml).toContain("|| format('factory #{0}', inputs.issue) }}");
		expect(publish).toMatch(/^ {10}DATA: \$\{\{ needs\.factory\.outputs\.handoff \}\}$/m);
	});

	// #619: the run's label move, whatever happened, with an App token that can write issues only.
	it("labels the issue once the run is done, with an issues-only App token", () => {
		expect(labels).toMatch(
			/^ {4}needs: \[gate, factory, publish\]\n {4}if: \$\{\{ !cancelled\(\) && needs\.gate\.outputs\.issue != '' \}\}\n/m,
		);
		expect(labels).toMatch(/permission-issues: write\n/);
		expect(labels).not.toMatch(/permission-(contents|pull-requests)/);
		expect(labels).toMatch(/^ {6}actions: read\b/m);
		expect(labels).toContain("GH_TOKEN: ${{ steps.app.outputs.token }}");
		expect(labels).toContain("PR: ${{ needs.publish.outputs.pr }}");
		expect(labels).toContain("GATE_WHY: ${{ needs.gate.outputs.why }}");
		expect(labels).toContain("run: bash .github/scripts/factory-outcome.sh");
		expect(gateJob).toContain("why: ${{ steps.gate.outputs.why }}");
		// The claude_ran rule is gone (#619): nothing reads a "Claude ran" step.
		expect(factory).not.toContain("name: Claude ran");
	});

	it("reports cost and every job's minutes, whatever happened", () => {
		expect(report).toMatch(/^ {4}if: always\(\)$/m);
		expect(report).toMatch(/needs: \[switch, gate, factory, publish\]/);
		expect(report).toContain("job_minutes");
		expect(factory).toContain("total_cost_usd");
	});
});

// #615: the "Claude's result" step logs Claude's last `FACTORY …` line, so a run that publishes
// nothing still says why. The step's own run block is executed, as the workflow has it, against an
// execution file shaped like claude-code-action's (a JSON array of messages, the `result` last).
describe("factory.yml, Claude's result (#615)", () => {
	const yml = readFileSync(WORKFLOW, "utf8");
	const step = yml.slice(yml.indexOf("name: Claude's result"));
	const script = step
		.slice(step.indexOf("run: |\n") + "run: |\n".length)
		.split("\n")
		.filter((l, i, all) =>
			all.slice(0, i + 1).every((x) => x === "" || x.startsWith(" ".repeat(10))),
		)
		.map((l) => l.slice(10))
		.join("\n");

	const execution = (...results) => [
		{ type: "system", subtype: "init" },
		{
			type: "assistant",
			message: { content: [{ type: "text", text: "FACTORY ready: 1-not-this" }] },
		},
		...results.map((result) => ({
			type: "result",
			subtype: "success",
			is_error: false,
			num_turns: 18,
			total_cost_usd: 0.43,
			duration_ms: 1000,
			result,
		})),
	];

	function run(exec) {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = mkdtempSync(join(tmpdir(), "factory-result-"));
		const env = { PATH: process.env.PATH, RUNNER_TEMP: dir, OUTCOME: "success" };
		env.GITHUB_OUTPUT = join(dir, "out");
		writeFileSync(env.GITHUB_OUTPUT, "");
		if (exec !== undefined) {
			env.EXEC_FILE = join(dir, "exec.json");
			writeFileSync(env.EXEC_FILE, typeof exec === "string" ? exec : JSON.stringify(exec));
		}
		// GitHub's default shell for run: (`bash --noprofile --norc -eo pipefail {0}`): -e stays on
		// under the step's own `set -uo pipefail`, so a failing command ends the step.
		const res = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
			encoding: "utf8",
			env,
		});
		const lines = res.stdout.split("\n").filter((l) => l.startsWith("RESULT factory"));
		return { code: res.status, lines, out: res.stdout + res.stderr };
	}

	it("prints the final result's last line that starts with FACTORY", () => {
		const r = run(execution("Done.\nThe PR body is written.\nFACTORY ready: 543-boundary-zone\n"));
		expect(r.code).toBe(0);
		expect(r.lines).toEqual(["RESULT factory=FACTORY ready: 543-boundary-zone"]);
	});

	it("takes the last FACTORY line of the last result, and only lines that start with it", () => {
		const r = run(
			execution(
				"FACTORY stopped: an older result",
				"FACTORY stopped: first try\nthen  FACTORY ready: mid-line\n  FACTORY fixed: indented\nFACTORY fixed: PR #612\nThanks.",
			),
		);
		expect(r.lines).toEqual(["RESULT factory=FACTORY fixed: PR #612"]);
	});

	it.each([
		["no FACTORY line", execution("I could not finish.")],
		["a result without text", execution(null)],
		["no result message", execution().slice(0, 2)],
		["an execution file that isn't JSON", "not json"],
	])("prints factory=none for %s", (_name, exec) => {
		const r = run(exec);
		expect(r.code).toBe(0);
		expect(r.lines).toEqual(["RESULT factory=none"]);
	});

	it("prints factory=none when there is no execution file", () => {
		const r = run(undefined);
		expect(r.lines).toEqual(["RESULT factory=none"]);
	});

	it("strips control characters, so the line stays one line and runs no workflow command", () => {
		const r = run(
			execution(
				"FACTORY stopped: a\u001b[31m red\u0007 \tword\u0085\n::add-mask::x\u2028::error::y\rFACTORY stopped: b\u202e\u0000 end",
			),
		);
		expect(r.lines).toEqual(["RESULT factory=FACTORY stopped: b end"]);
		expect(r.out).not.toMatch(/^::/m);
		expect(r.lines[0]).not.toMatch(/\p{Cc}|\p{Cf}/u);
	});

	it("treats every Unicode line break as a line end", () => {
		for (const br of ["\r\n", "\r", "\u0085", "\u2028", "\u2029"]) {
			const r = run(execution(`FACTORY stopped: one${br}FACTORY stopped: two${br}tail`));
			expect(r.lines).toEqual(["RESULT factory=FACTORY stopped: two"]);
		}
	});

	it("leaves no workflow command in the line: no `::` run, no legacy `##[`", () => {
		const r = run(
			execution("FACTORY stopped: ##[set-output name=ran;]true, ::error::x, ###[a] :::b # [c] #x"),
		);
		expect(r.lines).toEqual([
			"RESULT factory=FACTORY stopped: [set-output name=ran;]true, :error:x, [a] :b # [c] #x",
		]);
	});

	it("caps the line at 300 characters", () => {
		const r = run(execution(`FACTORY stopped: ${"é".repeat(400)}`));
		expect(r.lines).toHaveLength(1);
		const line = r.lines[0].slice("RESULT factory=".length);
		expect([...line]).toHaveLength(300);
		expect(line).toBe(`FACTORY stopped: ${"é".repeat(283)}`);
	});

	it("still logs the run's other fields and the cost output", () => {
		const r = run(execution("FACTORY ready: 9-x"));
		expect(r.out).toMatch(/^RESULT claude=success subtype=success is_error=false num_turns=18 /m);
		expect(readFileSync(join(dir, "out"), "utf8")).toMatch(/^cost=subtype=success /m);
	});
});
