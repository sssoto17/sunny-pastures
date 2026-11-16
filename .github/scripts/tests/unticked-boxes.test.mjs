import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { commentFor, findUnticked } from "../unticked-boxes.mjs";

const SCRIPT = fileURLToPath(new URL("../unticked-boxes.mjs", import.meta.url));

// #270's own criteria, the shape every issue body uses: a box, and its text wrapped and indented.
const ISSUE_270 = `## Acceptance criteria

- [ ] A PR job fails when a body that says \`Part of #N\` also has a closing keyword (close,
  closes, closed, fix, fixes, fixed, resolve, resolves, resolved) followed by \`#N\`, anywhere
  in the body, and names the line.
- [x] An \`issues: closed\` job comments the issue's unticked boxes, if any, and changes nothing
  else.
- [ ] \`CONSTRAINTS.md\` "Split size" says to describe later parts without the keyword.
- [X] Tests with fixture bodies, including #131's table and #245's body.
`;

describe("findUnticked", () => {
	it("lists the unticked boxes, each with its wrapped lines, and skips ticked ones", () => {
		expect(findUnticked(ISSUE_270)).toEqual([
			"A PR job fails when a body that says `Part of #N` also has a closing keyword (close, closes, closed, fix, fixes, fixed, resolve, resolves, resolved) followed by `#N`, anywhere in the body, and names the line.",
			'`CONSTRAINTS.md` "Split size" says to describe later parts without the keyword.',
		]);
	});

	it("reads a body typed with CRLF line ends, as the web editor saves them", () => {
		expect(findUnticked("- [ ] a\r\n  wrapped\r\n- [x] b\r\n- [ ] c")).toEqual(["a wrapped", "c"]);
	});

	it("reads every list marker and nested boxes", () => {
		const body = "* [ ] star\n+ [ ] plus\n1. [ ] one\n2) [ ] two\n  - [ ] nested";
		expect(findUnticked(body)).toEqual(["star", "plus", "one", "two", "nested"]);
	});

	it("skips boxes in HTML comments and fenced code, which don't render as boxes", () => {
		const body = [
			"<!-- - [ ] a template hint",
			"- [ ] still in the comment -->",
			"```md",
			"- [ ] an example",
			"```",
			"~~~",
			"- [ ] another example",
			"~~~",
			"- [ ] real",
		].join("\n");
		expect(findUnticked(body)).toEqual(["real"]);
	});

	it.each([
		["no boxes", "Just prose."],
		["only ticked boxes", "- [x] done\n- [X] done too"],
		["an empty body", ""],
		["brackets that aren't a box", "- [ ]no space\n- [  ] two spaces\nText - [ ] mid-line"],
	])("finds nothing in %s", (_, body) => {
		expect(findUnticked(body)).toEqual([]);
	});
});

describe("commentFor", () => {
	it("quotes the boxes in a code block, so no mention or reference in them fires again", () => {
		const comment = commentFor(["Ask @someone", "Link #12"]);
		expect(comment).toContain("2 unticked boxes");
		expect(comment).toContain("```\n- [ ] Ask @someone\n- [ ] Link #12\n```");
	});

	it("uses a fence longer than any backtick run in the boxes", () => {
		expect(commentFor(["A ```` fence"])).toContain("`````\n- [ ] A ```` fence\n`````");
	});

	it("references no issue of its own, so it cross-links nothing", () => {
		expect(commentFor(["one"]).replace(/```[\s\S]*```/, "")).not.toMatch(/#\d/);
	});

	it("says box for one", () => {
		expect(commentFor(["one"])).toContain("1 unticked box ");
	});
});

describe("unticked-boxes.mjs", () => {
	let dir;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	const run = (event) => {
		dir = mkdtempSync(join(tmpdir(), "unticked-"));
		const path = join(dir, "event.json");
		const out = join(dir, "comment.md");
		if (event !== undefined) writeFileSync(path, JSON.stringify(event));
		const r = spawnSync(process.execPath, [SCRIPT, "--out", out], {
			encoding: "utf8",
			env: { PATH: process.env.PATH, GITHUB_EVENT_PATH: path },
		});
		return {
			code: r.status,
			out: r.stdout + r.stderr,
			comment: existsSync(out) ? readFileSync(out, "utf8") : null,
		};
	};

	it("writes the comment for an issue closed with unticked boxes", () => {
		const r = run({ issue: { number: 270, body: ISSUE_270 } });
		expect(r.code).toBe(0);
		expect(r.out).toContain("#270 closed with 2 unticked boxes");
		expect(r.comment).toContain("Split size");
	});

	it("writes nothing for an issue with every box ticked", () => {
		const r = run({ issue: { number: 7, body: "- [x] done" } });
		expect(r).toMatchObject({ code: 0, comment: null });
		expect(r.out).toContain("#7 closed with no unticked boxes");
	});

	it("writes nothing for an issue with no body", () => {
		expect(run({ issue: { number: 7, body: null } })).toMatchObject({ code: 0, comment: null });
	});

	it("can't run without the event file", () => {
		const r = run(undefined);
		expect(r.code).toBe(2);
		expect(r.out).toContain("cannot run");
	});
});
