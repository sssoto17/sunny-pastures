import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { checkCodeOwned, isOwned, ownersOf, parseCodeOwners } from "../code-owned-guard.mjs";

const SCRIPT = fileURLToPath(new URL("../code-owned-guard.mjs", import.meta.url));
// The real list, so a pattern style added there is matched the way GitHub matches it.
const RULES = parseCodeOwners(
	readFileSync(fileURLToPath(new URL("../../CODEOWNERS", import.meta.url)), "utf8"),
);
const HEAD = "b".repeat(40);
const OLD = "a".repeat(40);

const event = () => ({
	repository: { full_name: "sssoto17/sunny-pastures" },
	pull_request: { number: 337, head: { sha: HEAD } },
});
const review = (id, state, commit_id = HEAD, login = "sssoto17") => ({
	id,
	state,
	commit_id,
	user: { login },
});

// Stands in for REST, so each case sets only the PR state it's about; `added` records each
// escalation (the label and its comment). A file is a name, or an entry as REST lists it.
// The PR's author defaults to the factory App (#336), the PR today's rule was written for.
const APP = { login: "sunny-factory[bot]", type: "Bot" };
const ADMIN = { login: "sssoto17", type: "User" };
const github = ({
	files,
	reviews = [],
	labels = [],
	head = HEAD,
	changed = files.length,
	author = APP,
}) => {
	const added = [];
	return {
		added,
		deps: {
			getPull: async () => ({
				head: { sha: head },
				changed_files: changed,
				labels: labels.map((name) => ({ name })),
				user: author,
			}),
			listFiles: async () => files.map((f) => (typeof f === "string" ? { filename: f } : f)),
			listReviews: async () => reviews,
			escalate: async () => added.push("review:admin"),
		},
	};
};
const check = (gh) => checkCodeOwned(event(), { rules: RULES, ...gh.deps });

describe("isOwned and ownersOf", () => {
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

	// Only a user can approve: never a bot or App (CODEOWNERS header), and a team can't be resolved.
	it("lets only user logins approve", () => {
		const rules = parseCodeOwners("/x  @sssoto17 @sunny-factory[bot] @org/team me@example.com\n");
		expect(ownersOf(rules, "x")).toEqual(["sssoto17"]);
	});

	// Fails closed: a path owned only by a team is still owned, and nobody here can approve it.
	it("keeps a path owned only by a team owned, with no one to approve it", () => {
		const rules = parseCodeOwners("/x  @org/team\n");
		expect(isOwned(rules, "x")).toBe(true);
		expect(ownersOf(rules, "x")).toEqual([]);
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

	it("holds a PR with a team-owned path that a user's approval can't clear", async () => {
		const rules = parseCodeOwners("/CONSTRAINTS.md  @sssoto17\n/x  @org/team\n");
		const gh = github({ files: ["x"], reviews: [review(1, "APPROVED")] });
		expect((await checkCodeOwned(event(), { rules, ...gh.deps })).ok).toBe(false);
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
		const gh = github({
			files: [{ filename: "docs/plans/x.md", previous_filename: "docs/adr/x.md" }],
		});
		expect((await check(gh)).owned).toEqual(["docs/adr/x.md"]);
	});

	// What a PR could do to have the bot, or a stale review, stand in for the admin.
	it.each([
		// REST shows a dismissed review in place, with its state changed.
		["the approval is dismissed", [review(1, "DISMISSED")]],
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
	// Runs come from reviews only (#379), so the new head waits for a review of it.
	it("holds a run whose head has moved, leaving the new head to a review of it", async () => {
		const gh = github({ files: ["README.md"], head: OLD });
		const r = await check(gh);
		expect(r.ok).toBe(false);
		expect(r.message).toContain("moved");
		expect(r.message).toContain("a review of it");
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

// #494 (admin, 22 Nov: option A): GitHub refuses a self-approval, so on a PR whose author is a code
// owner of every code-owned path in it, the author's own latest review on the head that isn't
// dismissed, APPROVED or COMMENTED, is the code owner's sign-off. Every other PR keeps the rule above.
describe("checkCodeOwned on a PR a code owner opened", () => {
	const owned = (reviews, more = {}) =>
		github({ files: ["CONSTRAINTS.md"], author: ADMIN, reviews, ...more });

	it("holds it until the author has reviewed the head", async () => {
		const gh = owned([]);
		const r = await check(gh);
		expect(r.ok).toBe(false);
		expect(gh.added).toEqual(["review:admin"]);
	});

	it.each(["COMMENTED", "APPROVED"])(
		"passes it once the author's %s review is on the head",
		async (state) => {
			const r = await check(owned([review(1, state)]));
			expect(r.ok).toBe(true);
			expect(r.message).toContain("the author");
			expect(r.message).toContain(HEAD.slice(0, 7));
		},
	);

	it("holds it again after a new push, until the author reviews the new head", async () => {
		expect((await check(owned([review(1, "COMMENTED", OLD)]))).ok).toBe(false);
		expect((await check(owned([review(1, "COMMENTED", OLD), review(2, "COMMENTED")]))).ok).toBe(
			true,
		);
	});

	it("matches the author to the code owner without regard to case", async () => {
		const gh = owned([review(1, "COMMENTED", HEAD, "SSSoto17")], {
			author: { login: "SSSoto17", type: "User" },
		});
		expect((await check(gh)).ok).toBe(true);
	});

	it.each([
		// The author's latest review decides, so an older one on the head can't outlast a newer one.
		[
			"the author's latest review is of an older head",
			[review(2, "COMMENTED", OLD), review(1, "COMMENTED")],
		],
		[
			"the author's latest review requests changes",
			[review(1, "COMMENTED"), review(2, "CHANGES_REQUESTED")],
		],
		[
			"the author's only review of the head was dismissed",
			[review(1, "COMMENTED", OLD), review(2, "DISMISSED")],
		],
		["only the bot commented", [review(1, "COMMENTED", HEAD, "sunny-reviewer[bot]")]],
		["only someone who isn't a code owner commented", [review(1, "COMMENTED", HEAD, "someone")]],
	])("holds it when %s", async (_, reviews) => {
		expect((await check(owned(reviews))).ok).toBe(false);
	});

	// The author must own every code-owned path: a path someone else, or a team, owns needs them.
	it.each([
		["someone else", "/CONSTRAINTS.md  @sssoto17\n/x  @someone\n"],
		["a team", "/CONSTRAINTS.md  @sssoto17\n/x  @org/team\n"],
	])("holds it when another code-owned path belongs to %s", async (_, text) => {
		const gh = github({
			files: ["CONSTRAINTS.md", "x"],
			author: ADMIN,
			reviews: [review(1, "COMMENTED")],
		});
		expect((await checkCodeOwned(event(), { rules: parseCodeOwners(text), ...gh.deps })).ok).toBe(
			false,
		);
	});

	// The author is read from the PR as REST returns it, and only a User account can be an author
	// whose own review counts (CODEOWNERS header: never a bot or an App).
	it.each([
		["the PR has no author", null],
		["the author is a bot with the owner's login", { login: "sssoto17", type: "Bot" }],
	])("holds it when %s", async (_, author) => {
		expect((await check(owned([review(1, "COMMENTED")], { author }))).ok).toBe(false);
	});
});

// #494, unchanged: on a PR the factory App opened, only a code owner's APPROVED review counts.
describe("checkCodeOwned on a PR an App opened", () => {
	it.each([
		["the admin only commented on the head", [review(1, "COMMENTED")]],
		[
			"the bot approved and commented",
			[
				review(1, "APPROVED", HEAD, "sunny-factory[bot]"),
				review(2, "COMMENTED", HEAD, "sunny-factory[bot]"),
			],
		],
		["someone who isn't a code owner commented", [review(1, "COMMENTED", HEAD, "someone")]],
	])("holds it when %s", async (_, reviews) => {
		expect((await check(github({ files: ["CONSTRAINTS.md"], reviews }))).ok).toBe(false);
	});

	it("passes it on the admin's APPROVED review of the head", async () => {
		expect(
			(await check(github({ files: ["CONSTRAINTS.md"], reviews: [review(1, "APPROVED")] }))).ok,
		).toBe(true);
	});
});

// #379: the check runs on `pull_request_review` only. The review that fired the run is not the
// verdict: the PR's reviews as REST lists them are, so every review ends in a pass or a fail.
describe("checkCodeOwned on a review event", () => {
	const onReview = (state, login = "sssoto17") => ({
		...event(),
		action: state === "dismissed" ? "dismissed" : "submitted",
		review: { id: 1, state, commit_id: HEAD, user: { login } },
	});

	it("fails a code-owned PR on a COMMENTED review with no approval, rather than skipping", async () => {
		const gh = github({ files: ["CONSTRAINTS.md"], reviews: [review(1, "COMMENTED")] });
		const r = await checkCodeOwned(onReview("commented"), { rules: RULES, ...gh.deps });
		expect(r.ok).toBe(false);
	});

	// An event delivered late, or replayed, can say "approved" after the approval was dismissed.
	it("trusts the PR's reviews over the event's own review", async () => {
		const gh = github({ files: ["CONSTRAINTS.md"], reviews: [review(1, "DISMISSED")] });
		const r = await checkCodeOwned(onReview("approved"), { rules: RULES, ...gh.deps });
		expect(r.ok).toBe(false);
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
	const P = "/repos/sssoto17/sunny-pastures";
	const routes = (files, reviews, user = APP) => ({
		[`GET ${P}/pulls/337`]: { head: { sha: HEAD }, changed_files: files.length, labels: [], user },
		[`GET ${P}/pulls/337/files`]: files.map((filename) => ({ filename })),
		[`GET ${P}/pulls/337/reviews`]: reviews,
		[`POST ${P}/issues/337/labels`]: [],
		[`POST ${P}/issues/337/comments`]: {},
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

	it("exits 0 for a PR with no code-owned path", async () => {
		const api = await serve(routes(["README.md"], []));
		const r = await run(event(), api.url);
		expect(r.status).toBe(0);
		expect(r.out).toContain("code-owned: pass");
		expect(api.seen.some((s) => s.startsWith("POST"))).toBe(false);
	});

	it("exits 1 and adds review:admin for a code-owned PR the admin hasn't approved", async () => {
		const api = await serve(routes([".github/workflows/code-owned.yml"], []));
		const r = await run(event(), api.url);
		expect(r.status).toBe(1);
		expect(r.out).toContain("::error title=guard / code-owned::");
		expect(r.out).toContain('".github/workflows/code-owned.yml"');
		expect(api.seen).toContain(`POST ${P}/issues/337/labels {"labels":["review:admin"]}`);
		expect(api.seen.find((s) => s.startsWith(`POST ${P}/issues/337/comments`))).toContain(
			"escalated: Code-owned path",
		);
	});

	it("exits 0 once the admin approves the head", async () => {
		const api = await serve(routes(["CONSTRAINTS.md"], [review(1, "APPROVED")]));
		expect((await run(event(), api.url)).status).toBe(0);
	});

	it("exits 0 once the admin, as the PR's author, comments on the head (#494)", async () => {
		const api = await serve(routes(["CONSTRAINTS.md"], [review(1, "COMMENTED")], ADMIN));
		expect((await run(event(), api.url)).status).toBe(0);
	});

	it("exits 1 on the admin's comment when the factory App opened the PR", async () => {
		const api = await serve(routes(["CONSTRAINTS.md"], [review(1, "COMMENTED")]));
		expect((await run(event(), api.url)).status).toBe(1);
	});

	it("exits 2, never a pass, when GitHub can't be read", async () => {
		const api = await serve({});
		const r = await run(event(), api.url);
		expect(r.status).toBe(2);
		expect(r.out).toContain("cannot run");
	});

	it("exits 2, never a pass, without an event", async () => {
		const r = await run(undefined);
		expect(r.status).toBe(2);
		expect(r.out).toContain("cannot run");
	});
});

// #379: a required check that a `pull_request` run and a review run both report on reads the
// `pull_request` suite (PR #377), so the check runs on reviews only, once per review.
describe("code-owned.yml", () => {
	const yml = readFileSync(
		fileURLToPath(new URL("../../workflows/code-owned.yml", import.meta.url)),
		"utf8",
	);
	const code = yml.replace(/^\s*#.*$/gm, "");
	const block = (key) => code.match(new RegExp(`^${key}:\\n((?:[ \\t]+.*\\n|\\n)*)`, "m"))?.[1];

	it("runs on a submitted or dismissed review only", () => {
		const on = block("on");
		expect(on).toBeDefined();
		expect(on.match(/^ {2}[\w_]+:/gm)).toEqual(["  pull_request_review:"]);
		expect(on).toMatch(/types: \[submitted, dismissed\]/);
	});

	// A skipped required check reads as passing (ADR-0002, #312), so a COMMENTED review would pass.
	it("never skips the job", () => {
		expect(block("jobs")).not.toMatch(/^\s+if:/m);
	});

	it("keeps one run per PR, cancelling an older one", () => {
		const group = block("concurrency");
		expect(group).toMatch(/group: .*github\.event\.pull_request\.number/);
		expect(group).toMatch(/cancel-in-progress: true/);
	});

	// #337: a PR can't switch off the check that judges it or drop a path from its list.
	it("runs the default branch's script and CODEOWNERS", () => {
		expect(code).toContain("ref: ${{ github.event.repository.default_branch }}");
		expect(code).toContain(
			'node "$RUNNER_TEMP/code-owned/code-owned-guard.mjs" --codeowners "$RUNNER_TEMP/code-owned/CODEOWNERS"',
		);
	});
});
