import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../factory-gate.sh", import.meta.url));
const WORKFLOW = fileURLToPath(new URL("../../workflows/factory.yml", import.meta.url));
const BOARD = "https://github.com/users/sssoto17/projects/3";

// The issue as `GET /repos/{o}/{r}/issues/{n}` returns it, trimmed to what the gate reads.
const issue = ({ number = 42, state = "open", labels = ["factory:ready", "chore"], pr } = {}) => ({
	number,
	state,
	labels: labels.map((name) => ({ name })),
	...(pr ? { pull_request: { url: "x" } } : {}),
});

// The GraphQL answer for the issue's Project items, as factory.yml's board step writes it.
const item = ({ url = BOARD, status = "Ready", mode = "Factory" } = {}) => ({
	project: { url },
	status: status === null ? null : { name: status },
	mode: mode === null ? null : { name: mode },
});
const board = (...items) => ({
	data: { repository: { issue: { projectItems: { nodes: items } } } },
});

let dir;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

function gate({ input = "42", turns, issueJson = issue(), boardJson, raw } = {}) {
	dir = mkdtempSync(join(tmpdir(), "factory-gate-"));
	writeFileSync(join(dir, "issue.json"), JSON.stringify(issueJson));
	writeFileSync(join(dir, "out"), "");
	writeFileSync(join(dir, "summary"), "");
	const env = {
		PATH: process.env.PATH,
		ISSUE: input,
		ISSUE_JSON: join(dir, "issue.json"),
		PROJECT_URL: BOARD,
		GITHUB_OUTPUT: join(dir, "out"),
		GITHUB_STEP_SUMMARY: join(dir, "summary"),
	};
	if (turns !== undefined) env.MAX_TURNS = turns;
	if (boardJson !== undefined || raw !== undefined) {
		writeFileSync(join(dir, "board.json"), raw ?? JSON.stringify(boardJson));
		env.BOARD_JSON = join(dir, "board.json");
	}
	const res = spawnSync("bash", [SCRIPT], { cwd: dir, encoding: "utf8", env });
	const out = readFileSync(join(dir, "out"), "utf8");
	const field = (k) => out.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1];
	return {
		code: res.status,
		log: res.stdout + res.stderr,
		outFile: out,
		run: field("run"),
		issueOk: field("issue_ok"),
		issue: field("issue"),
		turns: field("turns"),
	};
}

describe("factory-gate.sh, the issue phase (no BOARD_JSON)", () => {
	it("passes an open issue that carries factory:ready, but never says run=true", () => {
		const g = gate();
		expect(g.code).toBe(0);
		expect(g.issueOk).toBe("true");
		expect(g.run).toBe("false");
		expect(g.issue).toBe("42");
		expect(g.log).toMatch(/^GATE issue ok: #42 is open and carries factory:ready/m);
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
		expect(g.issueOk).toBe("false");
		expect(g.run).toBe("false");
		expect(g.log).toMatch(/^GATE refused: the issue input .* isn't an issue number/m);
		expect(g.outFile).not.toMatch(/^run=true$/m);
	});

	it("refuses an issue without factory:ready", () => {
		const g = gate({ issueJson: issue({ labels: ["chore"] }) });
		expect(g.issueOk).toBe("false");
		expect(g.log).toMatch(/^GATE refused: #42 doesn't carry factory:ready/m);
	});

	it("refuses a closed issue", () => {
		const g = gate({ issueJson: issue({ state: "closed" }) });
		expect(g.issueOk).toBe("false");
		expect(g.log).toMatch(/^GATE refused: #42 is closed/m);
	});

	it("refuses a pull request (the issues endpoint returns those too)", () => {
		const g = gate({ issueJson: issue({ pr: true }) });
		expect(g.issueOk).toBe("false");
		expect(g.log).toMatch(/^GATE refused: #42 is a pull request/m);
	});

	it("refuses when the JSON describes another issue", () => {
		const g = gate({ issueJson: issue({ number: 7 }) });
		expect(g.issueOk).toBe("false");
		expect(g.log).toMatch(/^GATE refused: .*#7.*not #42/m);
	});

	it("fails the step on an unreadable issue file rather than guess", () => {
		dir = mkdtempSync(join(tmpdir(), "factory-gate-"));
		writeFileSync(join(dir, "out"), "");
		const res = spawnSync("bash", [SCRIPT], {
			encoding: "utf8",
			env: {
				PATH: process.env.PATH,
				ISSUE: "42",
				ISSUE_JSON: join(dir, "missing.json"),
				PROJECT_URL: BOARD,
				GITHUB_OUTPUT: join(dir, "out"),
			},
		});
		expect(res.status).not.toBe(0);
		expect(readFileSync(join(dir, "out"), "utf8")).not.toMatch(/^(run|issue_ok)=true$/m);
	});

	it("writes a refusal to the step summary as well as the log", () => {
		gate({ issueJson: issue({ labels: [] }) });
		expect(readFileSync(join(dir, "summary"), "utf8")).toMatch(/Refused: #42 doesn't carry/);
	});
});

describe("factory-gate.sh, the board phase (BOARD_JSON set)", () => {
	it("says run=true for Ready, Mode Factory and factory:ready, with the 100-turn cap", () => {
		const g = gate({ boardJson: board(item()) });
		expect(g.code).toBe(0);
		expect(g.run).toBe("true");
		expect(g.turns).toBe("100");
		expect(g.log).toMatch(
			/^GATE run: #42 is Ready, Mode Factory and carries factory:ready \(max-turns 100\)/m,
		);
	});

	it("still refuses on the issue alone: the board can't make up for a missing label", () => {
		const g = gate({ issueJson: issue({ labels: [] }), boardJson: board(item()) });
		expect(g.run).toBe("false");
		expect(g.log).toMatch(/doesn't carry factory:ready/);
	});

	it.each([
		["Backlog", "Factory", /Status is Backlog, not Ready/],
		["In progress", "Factory", /Status is In progress, not Ready/],
		["Ready", "Manual", /Mode is Manual, not Factory/],
		[null, "Factory", /Status is unset, not Ready/],
		["Ready", null, /Mode is unset, not Factory/],
	])("refuses Status %s with Mode %s", (status, mode, why) => {
		const g = gate({ boardJson: board(item({ status, mode })) });
		expect(g.run).toBe("false");
		expect(g.log).toMatch(why);
	});

	it("reads only the Sunny Pastures board, never another Project's item", () => {
		const g = gate({
			boardJson: board(item({ url: "https://github.com/users/someone/projects/1" })),
		});
		expect(g.run).toBe("false");
		expect(g.log).toMatch(/^GATE refused: #42 isn't on the board .* or the App can't read it/m);
	});

	it("finds the board's item among others", () => {
		const other = item({ url: "https://github.com/users/x/projects/9", status: "Done" });
		expect(gate({ boardJson: board(other, item()) }).run).toBe("true");
	});

	// #102: the App's token couldn't resolve user Project 3. Fail closed, and say so.
	it("refuses, failing closed, when GraphQL answers with errors", () => {
		const g = gate({
			boardJson: {
				data: null,
				errors: [{ message: "Could not resolve to a ProjectV2 with the number 3." }],
			},
		});
		expect(g.run).toBe("false");
		expect(g.log).toMatch(/^GATE refused: BOARD unreadable: Could not resolve to a ProjectV2/m);
	});

	it("refuses when the board file isn't JSON (the read itself failed)", () => {
		const g = gate({ raw: "gh: HTTP 502" });
		expect(g.code).toBe(0);
		expect(g.run).toBe("false");
		expect(g.log).toMatch(/^GATE refused: BOARD unreadable/m);
	});

	it("keeps a multi-line error on one log line, so it can't start a workflow command", () => {
		const g = gate({ boardJson: { errors: [{ message: "bad\n::add-mask::x" }] } });
		expect(g.log).not.toMatch(/^::add-mask::/m);
		expect(g.log).toMatch(/bad%0A::add-mask::x/);
	});

	it.each([
		["5", "5"],
		["100", "100"],
		["", "100"],
	])("takes max_turns %j as %s", (turns, want) => {
		const g = gate({ turns, boardJson: board(item()) });
		expect(g.run).toBe("true");
		expect(g.turns).toBe(want);
	});

	it.each(["0", "101", "1000", "-1", "5 --dangerously-skip-permissions", "ten"])(
		"refuses max_turns %j: the input may only lower the cap",
		(turns) => {
			const g = gate({ turns, boardJson: board(item()) });
			expect(g.run).toBe("false");
			expect(g.log).toMatch(/^GATE refused: max_turns .* must be a whole number from 1 to 100/m);
		},
	);
});

// The script only answers; the workflow makes that answer stop the run before a token or Claude.
// Read as text, as factory-enabled.test.mjs reads the switch: the repo has no YAML parser, and
// adding one needs the admin. Comments are dropped, since the header quotes snippets.
describe("factory.yml", () => {
	const text = readFileSync(WORKFLOW, "utf8");
	const yml = text
		.split("\n")
		.filter((l) => !l.trimStart().startsWith("#"))
		.join("\n");
	// One job's lines: from its two-space key to the next one.
	const job = (name) =>
		yml.match(new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  \\S|(?![\\s\\S]))`, "m"))[0];
	const gate = job("gate");
	const factory = job("factory");

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
		expect(gate).toMatch(/^ {4}needs: switch\n {4}if: needs\.switch\.outputs\.run == 'true'\n/m);
		expect(factory).toMatch(
			/^ {4}needs: \[switch, gate\]\n {4}if: needs\.switch\.outputs\.run == 'true' && needs\.gate\.outputs\.run == 'true'\n/m,
		);
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

	it("checks the issue before the App's key mints a token, and that token only reads", () => {
		expect(gate.indexOf("id: issue")).toBeLessThan(gate.indexOf("id: app"));
		expect(gate).toMatch(/id: app\n {8}if: steps\.issue\.outputs\.issue_ok == 'true'\n/);
		const perms = [...gate.matchAll(/permission-([a-z-]+): (\w+)/g)];
		expect(perms.map((m) => m[0])).toEqual(["permission-issues: read"]);
		// The factory job's writes are contents only: no workflows, issues or administration.
		const writes = [...factory.matchAll(/permission-([a-z-]+): write/g)].map((m) => m[1]);
		expect(writes).toEqual(["contents"]);
	});

	it("caps the factory job at 60 minutes and Claude at the gate's turns (at most 100)", () => {
		expect(factory).toMatch(/^ {4}timeout-minutes: 60$/m);
		expect(factory).toContain("--max-turns ${{ needs.gate.outputs.turns }}");
	});

	it("runs Claude on the setup-token as sunny-factory, never on an API key", () => {
		expect(factory).toContain("claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}");
		expect(factory).toContain("github_token: ${{ steps.app.outputs.token }}");
		expect(factory).toMatch(/ANTHROPIC_API_KEY: ''/);
		expect(gate).toMatch(/^ {4}environment: factory$/m);
		expect(factory).toMatch(/^ {4}environment: factory$/m);
		expect(factory).toContain("/implement #${{ needs.gate.outputs.issue }}");
	});

	it("reuses main's pins of the actions, by full SHA, and adds no other action", () => {
		const pins = new Set([...yml.matchAll(/uses: ([^@\s]+)@(\S+)/g)].map((m) => `${m[1]}@${m[2]}`));
		expect(pins).toEqual(
			new Set([
				"actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
				"actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510",
				"anthropics/claude-code-action@61a9c274fa7110a66dfafc1bbbced03833eb25fe",
			]),
		);
	});

	it("never expands an input inside run:, and later steps use the gate's checked values", () => {
		// A run: block holds no expression at all; inputs reach the gate only through env:.
		for (const [, body] of yml.matchAll(/^ {8}run: \|\n((?: {10}.*\n|\n)+)/gm))
			expect(body).not.toContain("${{");
		const uses = [...yml.matchAll(/\$\{\{\s*inputs\.(\w+)\s*\}\}/g)].map((m) => m[0]);
		expect(uses.sort()).toEqual([
			"${{ inputs.issue }}",
			"${{ inputs.issue }}",
			"${{ inputs.max_turns }}",
		]);
		expect(yml).toMatch(/^run-name: 'factory #\$\{\{ inputs\.issue \}\}'$/m);
		expect(gate).toMatch(/^ {6}ISSUE: \$\{\{ inputs\.issue \}\}$/m);
		expect(gate).toMatch(/^ {6}MAX_TURNS: \$\{\{ inputs\.max_turns \}\}$/m);
	});

	it("logs total_cost_usd and the job's minutes, whatever happened", () => {
		const report = factory.slice(factory.indexOf("name: Report"));
		expect(report).toMatch(/^ {8}if: always\(\)$/m);
		expect(report).toContain("total_cost_usd");
		expect(report).toContain("job_minutes");
	});
});
