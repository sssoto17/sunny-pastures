#!/usr/bin/env node
// skill-proof.mjs: the review job's proof that the code-review-and-quality skill's text reached
// the model (#381), not only that the CLI registered it. The Report step runs it after Claude.
//
// Where the proof lives: a typed `/skill` is expanded by the CLI into a user message marked
// `isMeta`, "Base directory for this skill: <dir>" followed by SKILL.md's body. The SDK's message
// stream, which the action saves as the execution file, never carries that message, with or
// without replayed user messages; the session transcript, `~/.claude/projects/<cwd>/<session>.jsonl`,
// does (CLI 2.1.319 and 2.1.330, `--setting-sources user`, `Skill` denied; run by hand, 21 Nov
// 2026). So this script takes the session id from the execution file's init message and counts,
// in that session's transcript, the meta records from the skill's own folder that hold `line` as a
// whole line. The model reading SKILL.md through its Read tool is a tool result, which doesn't
// count.
//
// Usage: node .github/scripts/skill-proof.mjs <execution-file> <projects-dir> <skill> <line>
// Prints `RESULT skill=<skill> registered=<bool> loaded=<n> cli=<version> from=<dir>`.
// Exit codes: 0 the skill's text reached the model; 1 no proof, with an `::error::` annotation
// (a missing transcript is no proof); 2 could not run (wrong arguments).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { CannotRun, isMain } from "./diff.mjs";

const HEADER = /^Base directory for this skill: (.+)$/m;

// The text blocks of a record's message, joined; a plain string counts as one block. Tool results
// are left out.
const textOf = (content) =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content
					.filter((b) => b?.type === "text")
					.map((b) => b.text ?? "")
					.join("\n")
			: "";

/**
 * How many times the CLI put `skill`'s text into the conversation: `isMeta` user records whose
 * "Base directory" header names a folder called `skill` and that hold `line` as a whole line.
 * `from` is the folder the last of them came from.
 * @param {object[]} records the transcript's records
 * @param {string} skill
 * @param {string} line
 * @returns {{count: number, from: string | null}}
 */
export const countLoads = (records, skill, line) => {
	let count = 0;
	let from = null;
	for (const r of records) {
		if (r?.type !== "user" || r.isMeta !== true) continue;

		const text = textOf(r.message?.content).replace(/\r\n/g, "\n");
		const dir = HEADER.exec(text)?.[1]?.trim();
		if (!dir || basename(dir) !== skill) continue;
		if (!text.split("\n").includes(line)) continue;

		count += 1;
		from = dir;
	}
	return { count, from };
};

// `<projects>/<any folder>/<session>.jsonl`: the folder is the CLI's name for the working
// directory, so it is looked up rather than rebuilt.
const findTranscript = (projects, session) => {
	if (!existsSync(projects)) return null;
	for (const d of readdirSync(projects, { withFileTypes: true })) {
		const f = join(projects, d.name, `${session}.jsonl`);
		if (d.isDirectory() && existsSync(f)) return f;
	}
	return null;
};

const readJsonl = (file) =>
	readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.flatMap((l) => {
			try {
				return [JSON.parse(l)];
			} catch {
				return [];
			}
		});

const main = () => {
	const [exec, projects, skill, line] = process.argv.slice(2);
	if (!exec || !projects || !skill || !line)
		throw new CannotRun("usage: skill-proof.mjs <execution-file> <projects-dir> <skill> <line>");

	const messages = (() => {
		try {
			return JSON.parse(readFileSync(exec, "utf8"));
		} catch {
			return []; // an unreadable file reads as no init message, so the proof fails
		}
	})();
	const init = Array.isArray(messages)
		? messages.find((m) => m?.type === "system" && m.subtype === "init")
		: undefined;
	const registered = (init?.slash_commands ?? []).includes(skill);
	const cli = init?.claude_code_version ?? "unknown";

	let why = null;
	let loads = { count: 0, from: null };
	if (!init?.session_id) why = "the execution file has no init message with a session id";
	else {
		const transcript = findTranscript(projects, init.session_id);
		if (!transcript) why = `no transcript for session ${init.session_id} under ${projects}`;
		else loads = countLoads(readJsonl(transcript), skill, line);
	}
	console.log(
		`RESULT skill=${skill} registered=${registered} loaded=${loads.count} cli=${cli}` +
			` from=${loads.from ?? "none"}`,
	);
	if (loads.count > 0) return 0;

	why ??= `the transcript has no "${line}" from the skill's folder (registered=${registered})`;
	console.log(
		`::error title=Review skill not loaded::${skill} did not reach the model: ${why}. ` +
			"The review ran without it (#381).",
	);
	return 1;
};

if (isMain(import.meta.url)) {
	try {
		process.exitCode = main();
	} catch (e) {
		console.error(
			`skill-proof: cannot run: ${e instanceof CannotRun ? e.message : (e?.stack ?? e)}`,
		);
		process.exitCode = 2;
	}
}
