import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { checkCodeOwned, ownersOf, parseCodeOwners } from "../code-owned-guard.mjs";

const SCRIPT = fileURLToPath(new URL("../code-owned-guard.mjs", import.meta.url));
// The real list, so a pattern style added there is matched the way GitHub matches it.
const RULES = parseCodeOwners(
	readFileSync(fileURLToPath(new URL("../../CODEOWNERS", import.meta.url)), "utf8"),
);
const HEAD = "b".repeat(40);
const OLD = "a".repeat(40);

const event = (head = HEAD) => ({
	repository: { full_name: "sssoto17/sunny-pastures", default_branch: "main" },
	pull_request: { number: 337, head: { sha: head } },
});
const review = (id, state, commit_id = HEAD, login = "sssoto17") => ({
	id,
	state,
	commit_id,
	user: { login },
});

// The REST answers a check reads, and the labels it adds.
const github = ({ files, reviews = [], labels = [], head = HEAD, changed = files.length }) => {
	const added = [];
	return {
		added,
		deps: {
			getPull: async () => ({
				head: { sha: head },
				changed_files: changed,
				labels: labels.map((name) => ({ name })),
			}),
			listFiles: async () => files.map((filename) => ({ filename })),
			listReviews: async () => reviews,
			addLabel: async (name) => added.push(name),
		},
	};
};
const check = (gh) => checkCodeOwned(event(), { rules: RULES, ...gh.deps });

describe("ownersOf", () => {
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
		expect(ownersOf(RULES, path)).toEqual(["sssoto17"]);
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
		expect(ownersOf(RULES, path)).toEqual([]);
	});

	// GitHub: the last matching pattern wins, and a pattern with no owners leaves a path unowned.
	it("takes the last matching line, so a later line without owners un-owns a path", () => {
		const rules = parseCodeOwners("/docs/  @sssoto17\n/docs/plans/\n");
		expect(ownersOf(rules, "docs/adr/x.md")).toEqual(["sssoto17"]);
		expect(ownersOf(rules, "docs/plans/x.md")).toEqual([]);
	});

	// Only a user can approve: never a bot or App (CODEOWNERS header), and a team can't be resolved.
	it("keeps only user logins as owners", () => {
		const rules = parseCodeOwners("/x  @sssoto17 @sunny-factory[bot] @org/team me@example.com\n");
		expect(ownersOf(rules, "x")).toEqual(["sssoto17"]);
	});
});

describe("checkCodeOwned", () => {
	it("passes a PR that touches no code-owned path, without a label or a review", async () => {
		const gh = github({ files: ["packages/sim/src/index.ts", "docs/plans/m4.md"] });
		const r = await check(gh);
		expect(r.ok).toBe(true);
		expect(r.owned).toEqual([]);
		expect(gh.added).toEqual([]);
	});

	it("holds a code-owned PR without the admin's approval, and adds review:admin", async () => {
		const gh = github({ files: ["packages/sim/src/index.ts", ".github/CODEOWNERS"] });
		const r = await check(gh);
		expect(r.ok).toBe(false);
		expect(r.owned).toEqual([".github/CODEOWNERS"]);
		expect(r.message).toContain(HEAD.slice(0, 7));
		expect(gh.added).toEqual(["review:admin"]);
	});

	it("doesn't add review:admin again when the PR has it", async () => {
		const gh = github({ files: ["CONSTRAINTS.md"], labels: ["area:ci-cd", "review:admin"] });
		await check(gh);
		expect(gh.added).toEqual([]);
	});

	it("holds a PR whose only approval is of an older head", async () => {
		const gh = github({ files: ["CONSTRAINTS.md"], reviews: [review(1, "APPROVED", OLD)] });
		expect((await check(gh)).ok).toBe(false);
	});

	it("passes once the admin approves the current head, and still labels the PR", async () => {
		const gh = github({
			files: ["CONSTRAINTS.md"],
			reviews: [review(1, "APPROVED", OLD), review(2, "APPROVED")],
		});
		const r = await check(gh);
		expect(r.ok).toBe(true);
		expect(gh.added).toEqual(["review:admin"]);
	});

	// A rename out of an owned folder changes the owned path too.
	it("reads a rename's old path", async () => {
		const gh = github({ files: [] });
		gh.deps.listFiles = async () => [
			{ filename: "docs/plans/x.md", previous_filename: "docs/adr/x.md" },
		];
		gh.deps.getPull = async () => ({ head: { sha: HEAD }, changed_files: 1, labels: [] });
		expect((await check(gh)).owned).toEqual(["docs/adr/x.md"]);
	});

	// What a PR could do to have the bot, or a stale review, stand in for the admin.
	it.each([
		["the approval is dismissed", [review(1, "APPROVED"), review(1, "DISMISSED")]],
		["a later review requests changes", [review(1, "APPROVED"), review(2, "CHANGES_REQUESTED")]],
		["only the bot approved", [review(1, "APPROVED", HEAD, "sunny-reviewer[bot]")]],
		["only someone who isn't a code owner approved", [review(1, "APPROVED", HEAD, "someone")]],
	])("holds the PR when %s", async (_, reviews) => {
		expect((await check(github({ files: ["CONSTRAINTS.md"], reviews }))).ok).toBe(false);
	});

	it("keeps an approval that a later comment follows, as GitHub does", async () => {
		const reviews = [review(2, "COMMENTED"), review(1, "APPROVED")];
		expect((await check(github({ files: ["CONSTRAINTS.md"], reviews }))).ok).toBe(true);
	});

	it("matches the admin's login without regard to case", async () => {
		const reviews = [review(1, "APPROVED", HEAD, "SSSoto17")];
		expect((await check(github({ files: ["CONSTRAINTS.md"], reviews }))).ok).toBe(true);
	});

	// The check reports on the event's head; files and reviews for a newer head can't judge it.
	it("holds a run whose head has moved", async () => {
		const gh = github({ files: ["README.md"], head: OLD });
		const r = await check(gh);
		expect(r.ok).toBe(false);
		expect(r.message).toContain("moved");
	});

	it("can't run on a file list GitHub cut short", async () => {
		const gh = github({ files: ["README.md"], changed: 3001 });
		await expect(check(gh)).rejects.toThrow("3001");
	});

	it("can't run without a list of code-owned paths", async () => {
		const gh = github({ files: ["README.md"] });
		await expect(
			checkCodeOwned(event(), { rules: parseCodeOwners("# none\n"), ...gh.deps }),
		).rejects.toThrow("CODEOWNERS");
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
				seen.push(`${req.method} ${req.url}${body ? ` ${body}` : ""}`);
				const answer = routes[`${req.method} ${req.url.replace(/\?.*/, "")}`];
				res.writeHead(answer ? 200 : 404, { "content-type": "application/json" });
				res.end(JSON.stringify(answer ?? {}));
			});
		});
		await new Promise((done) => server.listen(0, "127.0.0.1", done));
		return { seen, url: `http://127.0.0.1:${server.address().port}` };
	};
	const run = async (ev, api) => {
		dir = mkdtempSync(join(tmpdir(), "code-owned-"));
		const path = join(dir, "event.json");
		if (ev !== undefined) writeFileSync(path, JSON.stringify(ev));
		const r = spawnSync(process.execPath, [SCRIPT], {
			encoding: "utf8",
			env: {
				PATH: process.env.PATH,
				GITHUB_EVENT_PATH: path,
				GITHUB_API_URL: api ?? "http://127.0.0.1:9",
				GITHUB_TOKEN: "test",
			},
		});
		return r;
	};
	const P = "/repos/sssoto17/sunny-pastures";
	const routes = (files, reviews) => ({
		[`GET ${P}/pulls/337`]: { head: { sha: HEAD }, changed_files: files.length, labels: [] },
		[`GET ${P}/pulls/337/files`]: files.map((filename) => ({ filename })),
		[`GET ${P}/pulls/337/reviews`]: reviews,
		[`POST ${P}/issues/337/labels`]: [],
	});

	// spawnSync blocks the event loop the fake server answers on, so these use an async child.
	const runAsync = async (ev, api) => {
		dir = mkdtempSync(join(tmpdir(), "code-owned-"));
		const path = join(dir, "event.json");
		writeFileSync(path, JSON.stringify(ev));
		const { spawn } = await import("node:child_process");
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

	it("exits 0 for a PR with no code-owned path", async () => {
		const api = await serve(routes(["README.md"], []));
		const r = await runAsync(event(), api.url);
		expect(r.status).toBe(0);
		expect(r.out).toContain("code-owned: pass");
		expect(api.seen.some((s) => s.startsWith("POST"))).toBe(false);
	});

	it("exits 1 and adds review:admin for a code-owned PR the admin hasn't approved", async () => {
		const api = await serve(routes([".github/workflows/code-owned.yml"], []));
		const r = await runAsync(event(), api.url);
		expect(r.status).toBe(1);
		expect(r.out).toContain("::error title=guard / code-owned::");
		expect(r.out).toContain('".github/workflows/code-owned.yml"');
		expect(api.seen).toContain(`POST ${P}/issues/337/labels {"labels":["review:admin"]}`);
	});

	it("exits 0 once the admin approves the head", async () => {
		const api = await serve(routes(["CONSTRAINTS.md"], [review(1, "APPROVED")]));
		expect((await runAsync(event(), api.url)).status).toBe(0);
	});

	it("exits 2, never a pass, when GitHub can't be read", async () => {
		const api = await serve({});
		const r = await runAsync(event(), api.url);
		expect(r.status).toBe(2);
		expect(r.out).toContain("cannot run");
	});

	it("exits 2, never a pass, without an event", async () => {
		const r = await run(undefined);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("cannot run");
	});
});
