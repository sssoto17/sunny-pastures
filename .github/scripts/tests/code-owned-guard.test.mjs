import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
	ACTIONS_APP,
	checkCodeOwned,
	fromMain,
	isAdminRemoval,
	isOwned,
	parseCodeOwners,
	WORKFLOW,
	writeVerdict,
} from "../code-owned-guard.mjs";

const SCRIPT = fileURLToPath(new URL("../code-owned-guard.mjs", import.meta.url));
// The real list, so a pattern style added there is matched the way GitHub matches it.
const RULES = parseCodeOwners(
	readFileSync(fileURLToPath(new URL("../../CODEOWNERS", import.meta.url)), "utf8"),
);
const HEAD = "b".repeat(40);
const OLD = "a".repeat(40);

const ADMIN = { login: "sssoto17", type: "User" };
const FACTORY = { login: "sunny-factory[bot]", type: "Bot" };
const ACTIONS_BOT = { login: "github-actions[bot]", type: "Bot" };
const SOMEONE = { login: "someone", type: "User" };

// An issue event on the PR's label, as `GET issues/<n>/events` lists it.
let nextId = 100;
const labelEvent = (event, actor, more = {}) => ({
	id: nextId++,
	event,
	actor,
	label: { name: "review:admin" },
	created_at: "2026-11-23T12:00:00Z",
	performed_via_github_app: null,
	...more,
});
const added = (actor = FACTORY) => labelEvent("labeled", actor);
const removed = (actor = ADMIN, more) => labelEvent("unlabeled", actor, more);

// The workflow runs a check suite can belong to, as `GET actions/runs?check_suite_id=` lists them.
const MAIN_RUN = { event: "pull_request_target", path: WORKFLOW };
const BRANCH_RUN = { event: "pull_request", path: ".github/workflows/fake.yml" };

// The run's event: by default a push (`synchronize`) of HEAD.
const event = (more = {}, head = HEAD) => ({
	action: "synchronize",
	repository: { full_name: "sssoto17/sunny-pastures" },
	pull_request: { number: 337, head: { sha: head } },
	...more,
});
// The `unlabeled` event a removal fires, sent by `actor`, raised while `head` was the PR's head.
const unlabeled = (actor = ADMIN, head = HEAD) =>
	event({ action: "unlabeled", label: { name: "review:admin" }, sender: actor }, head);

// Stands in for REST, so each case sets only the PR state it's about. `labels` is live: escalate,
// rearm and writeRecord change it as GitHub would, and `log` records each write.
const github = ({
	files = ["CONSTRAINTS.md"],
	labels = [],
	events = [],
	head = HEAD,
	changed = files.length,
	records = [],
	runs = {},
	lag = 0,
}) => {
	const log = [];
	const state = { labels: [...labels], records: [...records], runs: { ...runs }, slept: 0 };
	let reads = 0;
	const deps = {
		rules: RULES,
		getPull: async () => ({
			head: { sha: head },
			changed_files: changed,
			labels: state.labels.map((name) => ({ name })),
		}),
		listFiles: async () => files.map((f) => (typeof f === "string" ? { filename: f } : f)),
		// The first `lag` reads miss the last event, as a lagging REST list would.
		listEvents: async () => (reads++ < lag ? events.slice(0, -1) : events),
		listRecords: async (sha) => state.records.filter((r) => r.head_sha === sha),
		runOfSuite: async (id) => state.runs[id] ?? null,
		escalate: async () => {
			state.labels.push("review:admin");
			log.push("escalate");
		},
		rearm: async (why) => {
			state.labels.push("review:admin");
			log.push(`rearm: ${why}`);
		},
		writeRecord: async (sha, output) => {
			// What this run's own record looks like: Actions' App, in the suite of main's run.
			state.records.push({
				id: 900,
				head_sha: sha,
				app: { id: ACTIONS_APP },
				check_suite: { id: 9 },
			});
			state.runs[9] = { ...MAIN_RUN, check_suite_id: 9 };
			log.push(`record on ${sha.slice(0, 7)}: ${output.summary}`);
		},
		sleep: async () => {
			state.slept += 1;
		},
	};
	return { log, state, deps };
};
const check = (gh, ev = event()) => checkCodeOwned(ev, gh.deps);
// A run that must fail and write no sign-off record; returns the verdict.
const refused = async (gh, ev) => {
	const r = await check(gh, ev);
	expect(r.ok).toBe(false);
	expect(gh.state.records).toEqual([]);
	return r;
};

// A `code-owned / sign-off` record on `sha` in check suite `suite`, by Actions' App unless `app`.
const record = (id, suite, sha = HEAD, app = ACTIONS_APP) => ({
	id,
	head_sha: sha,
	app: { id: app },
	check_suite: { id: suite },
});

describe("isOwned", () => {
	// One path per pattern style in .github/CODEOWNERS.
	it.each([
		["/dir/, nested", ".github/workflows/ci.yml"],
		["/dir/ at more than one level", "docs/adr/0002-github-platform.md"],
		["/file", "CONSTRAINTS.md"],
		["/file with a dot first", ".mcp.json"],
		["/dir/file", "docs/diagrams/workflow.md"],
		["**/package.json at the root", "package.json"],
		["**/package.json in a package", "packages/sim/package.json"],
		["eslint.config.* at the root", "eslint.config.mjs"],
		["eslint.config.* in any directory", "apps/web/eslint.config.js"],
		["tsconfig*.json in any directory", "packages/sim/tsconfig.build.json"],
		[".gitattributes in any directory", "apps/web/.gitattributes"],
		["/path/name.* with a wildcard", "packages/sim/src/sim/tests/determinismScript.json"],
	])("owns a path matched by %s", (_, path) => {
		expect(isOwned(RULES, path)).toBe(true);
	});

	it.each([
		["a source file", "packages/sim/src/index.ts"],
		["an anchored /file outside the root", "docs/CONSTRAINTS.md"],
		["an anchored /dir/ deeper down", "packages/docs/adr/x.md"],
		["a * that would have to cross a /", "packages/sim/src/sim/tests/determinismScript/x/y.ts"],
		["a name that only starts like eslint.config.*", "eslint.configs/x.js"],
		["a sibling of an owned file", "packages/sim/src/sim/tests/recordScript.ts"],
		["a docs folder that isn't listed", "docs/plans/m4.md"],
	])("owns nothing for %s", (_, path) => {
		expect(isOwned(RULES, path)).toBe(false);
	});

	// GitHub keeps a final single `*` to one folder level; no pattern in CODEOWNERS uses it yet.
	it("owns only the top level of a folder under a /dir/* pattern", () => {
		const rules = parseCodeOwners("/docs/*  @sssoto17\n");
		expect(isOwned(rules, "docs/a.md")).toBe(true);
		expect(isOwned(rules, "docs/a/b.md")).toBe(false);
	});

	// GitHub: the last matching pattern wins, and a pattern with no owners leaves a path unowned.
	it("takes the last matching line, so a later line without owners un-owns a path", () => {
		const rules = parseCodeOwners("/docs/  @sssoto17\n/docs/plans/\n");
		expect(isOwned(rules, "docs/adr/x.md")).toBe(true);
		expect(isOwned(rules, "docs/plans/x.md")).toBe(false);
	});

	// Fails closed: a path owned only by a team or an email is still owned.
	it("keeps a path owned only by a team owned", () => {
		expect(isOwned(parseCodeOwners("/x  @org/team\n"), "x")).toBe(true);
	});
});

describe("isAdminRemoval", () => {
	it("is the admin's User account removing review:admin itself", () => {
		expect(isAdminRemoval(removed(ADMIN))).toBe(true);
		expect(isAdminRemoval(removed({ login: "SSSoto17", type: "User" }))).toBe(true);
	});

	it.each([
		["an App", FACTORY],
		["github-actions", ACTIONS_BOT],
		["another user", SOMEONE],
		["a bot with the admin's login", { login: "sssoto17", type: "Bot" }],
		["an actor with no type", { login: "sssoto17" }],
	])("isn't a removal by %s", (_, actor) => {
		expect(isAdminRemoval(removed(actor))).toBe(false);
	});

	it("isn't the admin's removal made through a GitHub App", () => {
		const viaApp = removed(ADMIN, { performed_via_github_app: { slug: "claude" } });
		expect(isAdminRemoval(viaApp)).toBe(false);
	});

	it("isn't an addition, or a removal of another label", () => {
		expect(isAdminRemoval(added(ADMIN))).toBe(false);
		expect(isAdminRemoval(removed(ADMIN, { label: { name: "area:ci-cd" } }))).toBe(false);
	});
});

describe("fromMain", () => {
	const run = (more) => ({ ...MAIN_RUN, check_suite_id: 7, ...more });

	it("counts a record from main's code-owned.yml on pull_request_target", () => {
		expect(fromMain(record(1, 7), run())).toBe(true);
	});

	it.each([
		["a workflow on the PR's branch (pull_request)", run({ event: "pull_request" })],
		["another workflow on pull_request_target", run({ path: ".github/workflows/review.yml" })],
		["a push run of code-owned.yml", run({ event: "push" })],
		["a run of another check suite", run({ check_suite_id: 8 })],
		["no workflow run", null],
	])("doesn't count a record from %s", (_, r) => {
		expect(fromMain(record(1, 7), r)).toBe(false);
	});

	it("doesn't count a record another App wrote", () => {
		expect(fromMain(record(1, 7, HEAD, 999), run())).toBe(false);
	});
});

describe("checkCodeOwned", () => {
	it("passes a PR that isn't held: no code-owned path, never labelled", async () => {
		const gh = github({ files: ["packages/sim/src/index.ts", "docs/plans/m4.md"] });
		const r = await check(gh);
		expect(r.ok).toBe(true);
		expect(r.owned).toEqual([]);
		expect(gh.log).toEqual([]);
	});

	it("holds a code-owned PR that never carried the label, and adds it", async () => {
		const gh = github({ files: ["packages/sim/src/index.ts", ".github/CODEOWNERS"] });
		const r = await check(gh);
		expect(r.ok).toBe(false);
		expect(r.owned).toEqual([".github/CODEOWNERS"]);
		expect(r.head).toBe(HEAD);
		expect(gh.log).toEqual(["escalate"]);
	});

	it("holds a held PR while the label is on, adding nothing", async () => {
		const gh = github({ labels: ["review:admin"], events: [added()] });
		const r = await check(gh);
		expect(r.ok).toBe(false);
		expect(r.message).toContain("review:admin is on");
		expect(r.message).toContain(HEAD.slice(0, 7));
		expect(gh.log).toEqual([]);
	});

	// The bot escalated a PR that touches no code-owned path: the label, not the reason, holds it.
	it("holds a PR the bot labelled that touches no code-owned path", async () => {
		const gh = github({ files: ["README.md"], labels: ["review:admin"], events: [added()] });
		expect((await check(gh)).ok).toBe(false);
	});

	it("passes once the admin's User account removes the label on the head, writing the record", async () => {
		const gh = github({ events: [added(), removed(ADMIN)] });
		const r = await check(gh, unlabeled());
		expect(r.ok).toBe(true);
		expect(r.message).toContain("signed off");
		expect(gh.log).toHaveLength(1);
		expect(gh.log[0]).toMatch(/^record on bbbbbbb: Sign-off: `sssoto17` \(User\)/);
	});

	it("names the removal's event id and actor in the record", async () => {
		const removal = removed(ADMIN);
		const gh = github({ events: [added(), removal] });
		await check(gh, unlabeled());
		expect(gh.log[0]).toContain(`in event ${removal.id}`);
		expect(gh.log[0]).toContain("`sssoto17`");
		expect(gh.log[0]).toContain(HEAD);
	});

	it("fails a removal on an older head, writes no record and puts the label back", async () => {
		const gh = github({ events: [added(), removed(ADMIN)] });
		const r = await refused(gh, unlabeled(ADMIN, OLD));
		expect(gh.state.labels).toEqual(["review:admin"]);
		expect(r.message).toContain("older head");
	});

	it.each([
		["the factory App", FACTORY],
		["github-actions", ACTIONS_BOT],
		["another user", SOMEONE],
		["a bot with the admin's login", { login: "sssoto17", type: "Bot" }],
	])("fails a removal by %s, writes no record and puts the label back", async (_, actor) => {
		const gh = github({ events: [added(), removed(actor)] });
		await refused(gh, unlabeled(actor));
		expect(gh.state.labels).toEqual(["review:admin"]);
		expect(gh.log).toEqual([expect.stringContaining(`removed by ${actor.login}`)]);
	});

	it("fails the admin's removal made through a GitHub App", async () => {
		const viaApp = removed(ADMIN, { performed_via_github_app: { slug: "claude" } });
		const gh = github({ events: [added(), viaApp] });
		const r = await check(gh, unlabeled());
		expect(r.ok).toBe(false);
		expect(r.message).toContain("through the App claude");
		expect(gh.state.labels).toEqual(["review:admin"]);
	});

	it("fails a push after the sign-off and puts the label back", async () => {
		// The sign-off's record is on OLD; HEAD, the push, has none.
		const gh = github({
			events: [added(), removed(ADMIN)],
			records: [record(1, 7, OLD)],
			runs: { 7: { ...MAIN_RUN, check_suite_id: 7 } },
		});
		const r = await check(gh, event());
		expect(r.ok).toBe(false);
		expect(gh.state.labels).toEqual(["review:admin"]);
		expect(r.message).toContain("pushed after the sign-off");
	});

	it("keeps a PR that once carried the label held after a push, though no path is code-owned", async () => {
		const gh = github({ files: ["README.md"], events: [added(), removed(ADMIN)] });
		const r = await check(gh, event());
		expect(r.ok).toBe(false);
		expect(gh.state.labels).toEqual(["review:admin"]);
	});

	it("passes a later run on the signed-off head, from the record alone", async () => {
		const gh = github({
			events: [added(), removed(ADMIN)],
			records: [record(1, 7)],
			runs: { 7: { ...MAIN_RUN, check_suite_id: 7 } },
		});
		const r = await check(gh, event({ action: "labeled", label: { name: "area:ci-cd" } }));
		expect(r.ok).toBe(true);
		expect(gh.log).toEqual([]);
	});

	it("doesn't count a record a workflow on the PR's branch wrote", async () => {
		const gh = github({
			events: [added(), removed(FACTORY)],
			records: [record(1, 7)],
			runs: { 7: { ...BRANCH_RUN, check_suite_id: 7 } },
		});
		const r = await check(gh);
		expect(r.ok).toBe(false);
		expect(gh.state.labels).toEqual(["review:admin"]);
	});

	// An `unlabeled` run for another label, or a replayed one after the label came back, writes nothing.
	it("writes no record when the last review:admin event is an addition", async () => {
		const gh = github({ labels: ["review:admin"], events: [added(), removed(ADMIN), added()] });
		expect((await refused(gh, unlabeled())).message).toContain("held");
	});

	it("writes no record on a run another label's removal fired", async () => {
		const gh = github({ events: [added(), removed(ADMIN)] });
		const ev = event({ action: "unlabeled", label: { name: "area:ci-cd" }, sender: ADMIN });
		expect((await refused(gh, ev)).message).toContain("held");
	});

	it("re-reads the events while REST hasn't listed the removal yet", async () => {
		const gh = github({ events: [added(), removed(ADMIN)], lag: 2 });
		expect((await check(gh, unlabeled())).ok).toBe(true);
		expect(gh.state.slept).toBe(2);
	});

	it("writes no record when the removal the event reports never shows in the events", async () => {
		const gh = github({ events: [added(), removed(ADMIN)], lag: 99 });
		expect((await refused(gh, unlabeled())).message).toContain("held");
	});

	// The sender on the payload must be the removal the events list: a spoofed or stale payload
	// can't borrow another actor's removal.
	it("writes no record when the event's sender isn't the removal's actor", async () => {
		const gh = github({ events: [added(), removed(ADMIN)] });
		expect((await refused(gh, unlabeled(SOMEONE))).message).toContain("held");
	});

	it("reads a rename's old path", async () => {
		const gh = github({
			files: [{ filename: "docs/plans/x.md", previous_filename: "docs/adr/x.md" }],
		});
		expect((await check(gh)).owned).toEqual(["docs/adr/x.md"]);
	});

	it("judges the PR's live head, not the event's", async () => {
		const gh = github({ files: ["README.md"] });
		expect((await check(gh, event({}, OLD))).head).toBe(HEAD);
	});

	it("can't run on a file list GitHub cut short", async () => {
		await expect(check(github({ files: ["README.md"], changed: 3001 }))).rejects.toThrow("3001");
	});

	it("can't run without a list of code-owned paths", async () => {
		const gh = github({ files: ["README.md"] });
		await expect(
			checkCodeOwned(event(), { ...gh.deps, rules: parseCodeOwners("# none\n") }),
		).rejects.toThrow("CODEOWNERS");
	});

	it("can't run without a pull_request head", async () => {
		await expect(check(github({}), { action: "opened" })).rejects.toThrow("pull_request head");
	});
});

describe("writeVerdict", () => {
	const verdict = { ok: false, owned: [".github/x.yml"], head: HEAD, message: "held: x" };
	const deps = (checks, runs) => {
		const log = [];
		return {
			log,
			listChecks: async () => checks,
			runOfSuite: async (id) => runs[id] ?? null,
			createCheck: async (body) => log.push(["create", body]),
			updateCheck: async (id, body) => log.push(["update", id, body]),
		};
	};

	it("creates guard / code-owned on the head when main's guard hasn't written one", async () => {
		const d = deps([record(5, 7)], { 7: { ...BRANCH_RUN, check_suite_id: 7 } });
		await writeVerdict(verdict, d);
		expect(d.log).toHaveLength(1);
		const [kind, body] = d.log[0];
		expect(kind).toBe("create");
		expect(body).toMatchObject({
			name: "guard / code-owned",
			head_sha: HEAD,
			status: "completed",
			conclusion: "failure",
		});
		expect(body.output.summary).toContain('- ".github/x.yml"');
	});

	it("updates the newest one main's guard wrote, in place", async () => {
		const main = (id) => ({ ...MAIN_RUN, check_suite_id: id });
		const d = deps([record(6, 8), record(5, 7)], { 7: main(7), 8: main(8) });
		await writeVerdict({ ...verdict, ok: true }, d);
		expect(d.log).toEqual([["update", 6, expect.objectContaining({ conclusion: "success" })]]);
	});
});

describe("code-owned-guard.mjs", () => {
	let dir;
	let server;
	afterEach(async () => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		if (server) await new Promise((done) => server.close(done));
		dir = server = undefined;
	});

	// A fake REST API on localhost: GITHUB_API_URL points the script at it, as Actions sets it.
	const serve = async (routes) => {
		const seen = [];
		server = createServer((req, res) => {
			let body = "";
			req.on("data", (c) => (body += c));
			req.on("end", () => {
				seen.push(
					`${req.method} ${req.url.replace(/[?&]per_page=100&page=1$/, "")}${body ? ` ${body}` : ""}`,
				);
				const answer = routes[`${req.method} ${req.url.replace(/\?.*/, "")}`];
				res.writeHead(answer ? 200 : 404, { "content-type": "application/json" });
				res.end(JSON.stringify(answer ?? {}));
			});
		});
		await new Promise((done) => server.listen(0, "127.0.0.1", done));
		return { seen, url: `http://127.0.0.1:${server.address().port}` };
	};
	const P = "/repos/sssoto17/sunny-pastures";
	const routes = (files, { labels = [], events = [] } = {}) => ({
		[`GET ${P}/pulls/337`]: {
			head: { sha: HEAD },
			changed_files: files.length,
			labels: labels.map((name) => ({ name })),
		},
		[`GET ${P}/pulls/337/files`]: files.map((filename) => ({ filename })),
		[`GET ${P}/issues/337/events`]: events,
		[`GET ${P}/commits/${HEAD}/check-runs`]: { total_count: 0, check_runs: [] },
		[`POST ${P}/issues/337/labels`]: [],
		[`POST ${P}/issues/337/comments`]: {},
		[`POST ${P}/check-runs`]: { id: 1 },
	});

	// An async child: spawnSync would block the event loop the fake server answers on.
	const run = async (ev, api = "http://127.0.0.1:9") => {
		dir = mkdtempSync(join(tmpdir(), "code-owned-"));
		const path = join(dir, "event.json");
		if (ev !== undefined) writeFileSync(path, JSON.stringify(ev));
		const child = spawn(process.execPath, [SCRIPT], {
			env: {
				PATH: process.env.PATH,
				GITHUB_EVENT_PATH: path,
				GITHUB_API_URL: api,
				GITHUB_TOKEN: "test",
			},
		});
		let out = "";
		child.stdout.on("data", (c) => (out += c));
		child.stderr.on("data", (c) => (out += c));
		const status = await new Promise((done) => child.on("close", done));
		return { status, out };
	};
	const checkRunPost = (seen) =>
		JSON.parse(seen.find((s) => s.startsWith(`POST ${P}/check-runs `)).replace(/^\S+ \S+ /, ""));

	it("exits 0 and writes a passing guard / code-owned for a PR that isn't held", async () => {
		const api = await serve(routes(["README.md"]));
		const r = await run(event(), api.url);
		expect(r.status).toBe(0);
		expect(r.out).toContain("code-owned: pass");
		expect(checkRunPost(api.seen)).toMatchObject({
			name: "guard / code-owned",
			head_sha: HEAD,
			conclusion: "success",
		});
	});

	// The required check run carries the verdict; the job stays green (scripts/board-status.sh).
	it("exits 0, adds review:admin and writes a failing check run for a code-owned PR", async () => {
		const api = await serve(routes([".github/workflows/code-owned.yml"]));
		const r = await run(event(), api.url);
		expect(r.status).toBe(0);
		expect(r.out).toContain("code-owned: held");
		expect(r.out).toContain('".github/workflows/code-owned.yml"');
		expect(api.seen).toContain(`POST ${P}/issues/337/labels {"labels":["review:admin"]}`);
		expect(api.seen.find((s) => s.startsWith(`POST ${P}/issues/337/comments`))).toContain(
			"escalated: Code-owned path",
		);
		expect(checkRunPost(api.seen)).toMatchObject({
			name: "guard / code-owned",
			conclusion: "failure",
		});
	});

	it("writes the sign-off record on the admin's removal of the label on the head", async () => {
		const api = await serve(routes(["CONSTRAINTS.md"], { events: [added(), removed(ADMIN)] }));
		await run(unlabeled(), api.url);
		const posts = api.seen.filter((s) => s.startsWith(`POST ${P}/check-runs `));
		expect(posts[0]).toContain('"name":"code-owned / sign-off"');
		expect(posts[0]).toContain('"conclusion":"success"');
	});

	it("exits 2, never a pass, and writes a failing check run when GitHub can't be read", async () => {
		const api = await serve({
			[`GET ${P}/commits/${HEAD}/check-runs`]: { check_runs: [] },
			[`POST ${P}/check-runs`]: { id: 1 },
		});
		const r = await run(event(), api.url);
		expect(r.status).toBe(2);
		expect(r.out).toContain("cannot run");
		expect(checkRunPost(api.seen)).toMatchObject({ conclusion: "failure" });
	});

	it("exits 2, never a pass, without an event", async () => {
		const r = await run(undefined);
		expect(r.status).toBe(2);
		expect(r.out).toContain("cannot run");
	});
});

// ADR-0002, area 2, "Solo-admin approvals", decisions 4 and 7.
describe("code-owned.yml", () => {
	const yml = readFileSync(
		fileURLToPath(new URL("../../workflows/code-owned.yml", import.meta.url)),
		"utf8",
	);
	const code = yml.replace(/^\s*#.*$/gm, "");
	const block = (key) => code.match(new RegExp(`^${key}:\\n((?:[ \\t]+.*\\n|\\n)*)`, "m"))?.[1];

	it("runs on pull_request_target only, for the PR's label and head changes", () => {
		const on = block("on");
		expect(on.match(/^ {2}[\w_]+:/gm)).toEqual(["  pull_request_target:"]);
		expect(on).toMatch(/types: \[opened, synchronize, reopened, labeled, unlabeled\]/);
		expect(code).not.toContain("pull_request_review");
	});

	// A skipped required check reads as passing (ADR-0002, #312).
	it("never skips the job", () => {
		expect(block("jobs")).not.toMatch(/^\s+if:/m);
	});

	// A newer pending run replaces an older pending one; a running one finishes.
	it("runs one at a time per PR, never cancelling a running one", () => {
		const group = block("concurrency");
		expect(group).toMatch(/group: .*github\.event\.pull_request\.number/);
		expect(code).not.toContain("cancel-in-progress");
	});

	it("names the job code-owned (run), neither check run's name", () => {
		expect(block("jobs")).toMatch(/^ {4}name: code-owned \(run\)$/m);
		expect(code).not.toMatch(/name: guard \/ code-owned/);
	});

	// pull_request_target checks out the default branch; nothing may point it at the PR.
	it("never checks out or runs the PR's code", () => {
		expect(code).not.toMatch(/ref:/);
		expect(code).not.toMatch(/head\.(sha|ref)|head_ref|merge_commit_sha|refs\/pull/);
		expect(code).toContain(
			"node .github/scripts/code-owned-guard.mjs --codeowners .github/CODEOWNERS",
		);
	});

	it("can write check runs and read the workflow runs behind them", () => {
		expect(block("jobs")).toMatch(/checks: write/);
		expect(block("jobs")).toMatch(/actions: read/);
	});
});
