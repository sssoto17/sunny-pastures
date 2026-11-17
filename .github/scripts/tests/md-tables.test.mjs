// The table check in `format:md` (#344; ADR-0005, section 6, Prettier): every top-level table
// keeps `<!-- prettier-ignore -->` on the line before it, because Prettier pads every row of a
// table to its widest row (#231, section 2).
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { bareTables } from "../md-tables.mjs";
import { makeRepo } from "./test-repo.mjs";

const SCRIPT = new URL("../md-tables.mjs", import.meta.url).pathname;
const IGNORE = "<!-- prettier-ignore -->";
const TABLE = "| a | b |\n|---|---|\n| 1 | 2 |";

describe("bareTables", () => {
	it("finds a table with no comment before it, by its first line", () => {
		expect(bareTables(`# Title\n\n${TABLE}\n`)).toEqual([3]);
	});

	it("passes a table with the comment on the line before it", () => {
		expect(bareTables(`# Title\n\n${IGNORE}\n${TABLE}\n`)).toEqual([]);
	});

	it("finds a table whose comment is separated from it by a blank line", () => {
		expect(bareTables(`${IGNORE}\n\n${TABLE}\n`)).toEqual([3]);
	});

	it("finds a table on the file's first line, and each bare table in a file", () => {
		expect(bareTables(`${TABLE}\n\ntext\n\n${IGNORE}\n${TABLE}\n\n${TABLE}\n`)).toEqual([1, 12]);
	});

	it("finds a table whose line before is another comment", () => {
		expect(bareTables(`<!-- a note -->\n${TABLE}\n`)).toEqual([2]);
	});

	it("skips table-looking lines in a fenced code block", () => {
		expect(bareTables("```md\n" + TABLE + "\n```\n")).toEqual([]);
	});

	it("skips a table nested in a list item or a block quote", () => {
		const nested = TABLE.replace(/^/gm, "  ");
		const quoted = TABLE.replace(/^/gm, "> ");
		expect(bareTables(`- item\n\n${nested}\n\n${quoted}\n`)).toEqual([]);
	});
});

describe("md-tables.mjs", () => {
	let repo;
	afterEach(() => repo?.cleanup());

	const run = (args = []) => {
		const r = spawnSync("node", [SCRIPT, ...args], { cwd: repo.dir, encoding: "utf8" });
		return { code: r.status, out: r.stdout + r.stderr };
	};

	it("lists each bare table in tracked Markdown as file:line and exits 1", () => {
		repo = makeRepo({
			"README.md": `# Readme\n\n${TABLE}\n`,
			"docs/ok.md": `${IGNORE}\n${TABLE}\n`,
			"docs/deep/bad.md": `text\n\n${TABLE}\n`,
		});

		const { code, out } = run();

		expect(code).toBe(1);
		expect(out).toContain("README.md:3");
		expect(out).toContain("docs/deep/bad.md:3");
		expect(out).not.toContain("docs/ok.md");
	});

	it("exits 0 when every table keeps its comment", () => {
		repo = makeRepo({ "README.md": `${IGNORE}\n${TABLE}\n`, "a.ts": "export {};\n" });

		expect(run()).toEqual({ code: 0, out: "" });
	});

	it("skips what Prettier skips: .prettierignore, .gitignore and untracked files", () => {
		repo = makeRepo({
			".prettierignore": ".claude/\n",
			".gitignore": ".scratch/\n",
			".claude/skill.md": `${TABLE}\n`,
			"README.md": `${IGNORE}\n${TABLE}\n`,
		});
		repo.write({ ".scratch/brief.md": `${TABLE}\n`, "new.md": `${TABLE}\n` });

		expect(run()).toEqual({ code: 0, out: "" });
	});

	it("checks only the files it's given, when given some", () => {
		repo = makeRepo({ "a.md": `${TABLE}\n`, "b.md": `${TABLE}\n` });

		const { code, out } = run(["b.md"]);

		expect(code).toBe(1);
		expect(out).toContain("b.md:1");
		expect(out).not.toContain("a.md");
	});

	it("exits 2 on a file it can't read", () => {
		repo = makeRepo({ "a.md": "text\n" });

		expect(run(["missing.md"]).code).toBe(2);
	});

	it("exits 2 outside a git work tree, rather than reading no files as clean", () => {
		repo = makeRepo({ "a.md": `${TABLE}\n` });
		rmSync(join(repo.dir, ".git"), { recursive: true });

		const { code, out } = run();

		expect(code).toBe(2);
		expect(out).toContain("not in a git work tree");
	});
});
