import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { countLoads } from "../skill-proof.mjs";

const SCRIPT = fileURLToPath(new URL("../skill-proof.mjs", import.meta.url));
const SKILL = "code-review-and-quality";
const LINE = "# Code Review and Quality";
const SESSION = "9e4d4625-19ce-41f2-a20f-ebb7e710c97f";
const BASE = `/home/runner/.claude/skills/${SKILL}`;

// The records below copy the shapes CLI 2.1.319 wrote for a typed `/code-review-and-quality`
// with `Skill` denied (#381, run by hand on 21 Nov 2026): the typed line as a plain user record,
// then the skill's text as an `isMeta` user record whose content is an array of text blocks.
const typed = {
	type: "user",
	sessionId: SESSION,
	message: {
		role: "user",
		content: `<command-message>${SKILL}</command-message>\n<command-name>/${SKILL}</command-name>`,
	},
};
const expanded = (text = `Base directory for this skill: ${BASE}\n\n${LINE}\n\n## Overview\n`) => ({
	type: "user",
	isMeta: true,
	sessionId: SESSION,
	message: { role: "user", content: [{ type: "text", text }] },
});
// The model reading SKILL.md with its Read tool: the text arrives as a tool result, which is not
// the skill loading.
const readByTool = {
	type: "user",
	sessionId: SESSION,
	message: {
		role: "user",
		content: [{ type: "tool_result", tool_use_id: "t1", content: `1\t---\n6\t${LINE}\n` }],
	},
};
const assistant = { type: "assistant", sessionId: SESSION, message: { content: [] } };
const init = (slash = [SKILL]) => ({
	type: "system",
	subtype: "init",
	session_id: SESSION,
	claude_code_version: "2.1.319",
	slash_commands: slash,
});

describe("countLoads", () => {
	it("counts the skill's text when the CLI expanded it into the conversation", () => {
		expect(countLoads([typed, expanded(), assistant], SKILL, LINE)).toEqual({
			count: 1,
			from: BASE,
		});
	});

	it("accepts the text as a plain string, and CRLF line ends", () => {
		const record = expanded();
		record.message.content = `Base directory for this skill: ${BASE}\r\n\r\n${LINE}\r\n`;
		expect(countLoads([record], SKILL, LINE).count).toBe(1);
	});

	it("doesn't count the line read through a tool", () => {
		expect(countLoads([typed, readByTool], SKILL, LINE).count).toBe(0);
	});

	it("doesn't count another skill's text, or the line quoted mid-line", () => {
		const other = expanded(
			`Base directory for this skill: /home/runner/.claude/skills/x\n\n${LINE}\n`,
		);
		const quoted = expanded(`Base directory for this skill: ${BASE}\n\nsee ${LINE}\n`);
		expect(countLoads([other, quoted], SKILL, LINE).count).toBe(0);
	});

	it("doesn't count a meta record without the skill's base directory header", () => {
		expect(countLoads([expanded(`${LINE}\n`)], SKILL, LINE).count).toBe(0);
	});
});

describe("skill-proof (CLI)", () => {
	let dir;
	afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

	// An execution file and a projects folder holding one transcript, as the runner has them.
	const setUp = ({ messages = [init()], transcript = [typed, expanded(), assistant] } = {}) => {
		dir = mkdtempSync(join(tmpdir(), "skill-proof-"));
		const exec = join(dir, "claude-execution-output.json");
		writeFileSync(exec, JSON.stringify(messages));
		const projects = join(dir, "projects");
		mkdirSync(join(projects, "-home-runner-work-repo-repo"), { recursive: true });
		if (transcript)
			writeFileSync(
				join(projects, "-home-runner-work-repo-repo", `${SESSION}.jsonl`),
				transcript.map((r) => JSON.stringify(r)).join("\n") + "\n",
			);
		return { exec, projects };
	};
	const run = ({ exec, projects }) => {
		const r = spawnSync("node", [SCRIPT, exec, projects, SKILL, LINE], { encoding: "utf8" });
		return { code: r.status, out: r.stdout, err: r.stderr };
	};

	it("prints the proof and exits 0 when the skill's text reached the model", () => {
		const { code, out } = run(setUp());
		expect(code).toBe(0);
		expect(out).toContain(
			`RESULT skill=${SKILL} registered=true loaded=1 cli=2.1.319 from=${BASE}`,
		);
		expect(out).not.toContain("::error");
	});

	it("fails with an error annotation when the transcript has no skill text", () => {
		const { code, out } = run(setUp({ transcript: [typed, readByTool, assistant] }));
		expect(code).toBe(1);
		expect(out).toContain(`RESULT skill=${SKILL} registered=true loaded=0`);
		expect(out).toMatch(/^::error title=Review skill not loaded::/m);
	});

	it("fails when the skill wasn't registered, and says so", () => {
		const { code, out } = run(setUp({ messages: [init([])], transcript: [typed, assistant] }));
		expect(code).toBe(1);
		expect(out).toContain("registered=false loaded=0");
		expect(out).toMatch(/^::error title=Review skill not loaded::/m);
	});

	it("fails when the run's transcript can't be found: no proof is not a pass", () => {
		const { code, out } = run(setUp({ transcript: null }));
		expect(code).toBe(1);
		expect(out).toMatch(/^::error title=Review skill not loaded::.*no transcript/m);
	});

	it("fails when the execution file has no init message", () => {
		const { code, out } = run(setUp({ messages: [{ type: "result" }] }));
		expect(code).toBe(1);
		expect(out).toMatch(/^::error title=Review skill not loaded::.*no init message/m);
	});

	it("exits 2 on wrong arguments", () => {
		const r = spawnSync("node", [SCRIPT, "only-one"], { encoding: "utf8" });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("usage:");
	});
});
