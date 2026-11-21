import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { checkAcceptance, inAcceptance, isBot } from "../acceptance-guard.mjs";

const SCRIPT = fileURLToPath(new URL("../acceptance-guard.mjs", import.meta.url));
const FACTORY = { login: "sunny-factory[bot]", type: "Bot" };
const ADMIN = { login: "sssoto17", type: "User" };
const TEST = "tests/acceptance/a.test.ts";

const event = (user = FACTORY) => ({
	repository: { full_name: "sssoto17/sunny-pastures" },
	pull_request: { number: 384, user },
});

// Stands in for REST. A file is a name, or an entry as REST lists it (`previous_filename` for a
// rename). `calls` records the requests, so a non-bot PR can be shown to need none.
const github = (files, changed = files.length) => {
	const calls = [];
	const listed = files.map((f) => (typeof f === "string" ? { filename: f } : f));
	const answer = (name, value) => async () => (calls.push(name), value);
	const deps = {
		getPull: answer("pull", { changed_files: changed }),
		listFiles: answer("files", listed),
	};
	return { calls, deps };
};

describe("isBot", () => {
	it.each([
		["the factory App", FACTORY],
		["a [bot] login whatever its type says", { login: "dependabot[bot]", type: "User" }],
		["a Bot type whatever its login says", { login: "x", type: "Bot" }],
		["a [BOT] login in another case", { login: "X[BOT]" }],
	])("counts %s as a bot", (_, user) => expect(isBot(user)).toBe(true));

	it.each([
		["the admin", ADMIN],
		["a login that only contains bot", { login: "robot-bot", type: "User" }],
		["a login with [bot] inside it", { login: "a[bot]b", type: "User" }],
	])("doesn't count %s as a bot", (_, user) => expect(isBot(user)).toBe(false));
});

describe("inAcceptance", () => {
	it.each([
		TEST,
		"tests/acceptance/attack/t1.test.ts",
		"tests/acceptance/vitest.config.mts",
		"tests/acceptance",
		"Tests/Acceptance/a.ts", // a case-blind filesystem merges it into the folder
	])("is true for %s", (path) => expect(inAcceptance(path)).toBe(true));

	it.each(["apps/web/src/a.ts", "tests/acceptance-notes/a.md", "apps/web/tests/acceptance/a.ts"])(
		"is false for %s",
		(path) => expect(inAcceptance(path)).toBe(false),
	);
});

describe("checkAcceptance", () => {
	// #384, criterion 3: a bot touching the path, renaming into or out of it (and deleting there).
	it.each([
		["changes a file in", ["README.md", TEST]],
		["renames a file into", [{ filename: TEST, previous_filename: "a.test.ts" }]],
		["renames a file out of", [{ filename: "a.test.ts", previous_filename: TEST }]],
		["deletes a file in", [{ filename: TEST, status: "removed" }]],
	])("fails a bot PR that %s tests/acceptance", async (_, files) => {
		const r = await checkAcceptance(event(), github(files).deps);
		expect(r).toMatchObject({ ok: false, touched: [TEST] });
		expect(r.message).toContain("sunny-factory[bot]");
	});

	it("passes a bot PR that doesn't touch it", async () => {
		const r = await checkAcceptance(event(), github(["README.md", "b.ts"]).deps);
		expect(r).toMatchObject({ ok: true, touched: [] });
	});

	it("passes the admin touching it, without asking GitHub for the files", async () => {
		const gh = github([TEST]);
		expect((await checkAcceptance(event(ADMIN), gh.deps)).ok).toBe(true);
		expect(gh.calls).toEqual([]);
	});

	// REST lists at most 3000 files, so a short list could hide a touched path: never a pass.
	it("can't run when GitHub lists fewer files than the PR changes", async () => {
		const r = checkAcceptance(event(), github(["README.md"], 3001).deps);
		await expect(r).rejects.toThrow("listed 1 of the PR's 3001");
	});

	it.each([
		["no pull request", { repository: {} }],
		["no author", { pull_request: { number: 1 } }],
		["no number", { pull_request: { user: FACTORY } }],
	])("can't run on an event with %s", async (_, ev) => {
		await expect(checkAcceptance(ev, github([]).deps)).rejects.toThrow("no PR number or author");
	});
});

describe("acceptance-guard.mjs", () => {
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
			seen.push(`${req.method} ${req.url}`);
			const answer = routes[`${req.method} ${req.url.replace(/\?.*/, "")}`];
			res.writeHead(answer ? 200 : 404, { "content-type": "application/json" });
			res.end(JSON.stringify(answer ?? {}));
		});
		await new Promise((done) => server.listen(0, "127.0.0.1", done));
		return { seen, url: `http://127.0.0.1:${server.address().port}` };
	};
	const P = "/repos/sssoto17/sunny-pastures";
	const routes = (files) => ({
		[`GET ${P}/pulls/384`]: { changed_files: files.length },
		[`GET ${P}/pulls/384/files`]: files.map((filename) => ({ filename })),
	});

	// An async child: spawnSync would block the event loop the fake server answers on.
	const run = async (ev, api = "http://127.0.0.1:9") => {
		dir = mkdtempSync(join(tmpdir(), "acceptance-guard-"));
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

	it("exits 1 and names the path, JSON-quoted, for a bot PR that touches it", async () => {
		const api = await serve(routes(["tests/acceptance/farm.test.ts"]));
		const r = await run(event(), api.url);
		expect(r.status).toBe(1);
		expect(r.out).toContain("::error title=guard / acceptance::");
		expect(r.out).toContain('"tests/acceptance/farm.test.ts"');
	});

	it("exits 0 for the admin with no request at all", async () => {
		const api = await serve({});
		const r = await run(event(ADMIN), api.url);
		expect(r.status).toBe(0);
		expect(api.seen).toEqual([]);
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

// #384, criterion 2, and ADR-0002 (area 2): a required check reports on every PR, and the PR can't
// switch off the copy of the script that judges it.
describe("acceptance-guard.yml", () => {
	const yml = readFileSync(
		fileURLToPath(new URL("../../workflows/acceptance-guard.yml", import.meta.url)),
		"utf8",
	);
	const code = yml.replace(/^\s*#.*$/gm, "");
	const block = (key) => code.match(new RegExp(`^${key}:\\n((?:[ \\t]+.*\\n|\\n)*)`, "m"))?.[1];

	it("runs on every pull request, with no path filter", () => {
		const on = block("on");
		expect(on).toBeDefined();
		expect(on.match(/^ {2}[\w_]+:/gm)).toEqual(["  pull_request:"]);
		expect(on).not.toMatch(/paths/);
	});

	// A skipped required check reads as passing (ADR-0002, #312).
	it("never skips the job", () => {
		expect(block("jobs")).not.toMatch(/^\s+if:/m);
		expect(code).toMatch(/name: guard \/ acceptance\n/);
	});

	it("asks for read-only scopes and persists no credentials", () => {
		expect(code).not.toMatch(/:\s*write\b/);
		expect(code.match(/uses: actions\/checkout@/g)).toHaveLength(2);
		expect(code.match(/persist-credentials: false/g)).toHaveLength(2);
	});

	it("runs the default branch's script, with the token in env only", () => {
		expect(code).toContain("ref: ${{ github.event.repository.default_branch }}");
		expect(code).toContain('node "$RUNNER_TEMP/acceptance-guard/acceptance-guard.mjs"');
		expect(code).toMatch(/env:\n\s+GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
		for (const run of code.match(/run: [\s\S]*?(?=\n\s+- |\n\s+env:|$)/g) ?? [])
			expect(run).not.toContain("${{");
	});
});
