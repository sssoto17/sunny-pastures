#!/usr/bin/env node
// Stop hook (#705, check 7): a factory run can't end its turn on a false `FACTORY ready`. Three runs
// stopped on that class (#646, #659, and #605's run 45928803367 on 27 Nov): the Fallow gate denied
// the chained `git switch -c 605-…; git commit`, the branch was never made, the commits landed on
// main, the turn still ended `FACTORY ready: 605-chicken-pen-feed-eggs`, and only a later step on
// the runner found the branch missing. This checks the claim where the agent can still act on it.
// When the last line of the final message that starts with `FACTORY ` (the line factory.yml logs as
// `RESULT factory=`) starts with `FACTORY ready`, the turn is refused, with the reason, unless the
// named branch exists, has commits beyond origin/main and the tree is clean. Claude Code then
// carries the turn on with the reason (https://code.claude.com/docs/en/hooks, "Stop decision
// control"); its own cap (8 blocks in a row with no tool call between) bounds the loop, so this
// keeps no count.
// It acts only in a factory run: today's factory.yml (GITHUB_ACTIONS=true and GITHUB_WORKFLOW=factory,
// which the scrubbed environment keeps: only credentials are scrubbed), or the routine's environment,
// which sets FACTORY_RUN=1 (#705, the admin's setup checklist). Every other session, attended or
// lane, local or cloud, gets no output. Input it can't read, or a folder that isn't a git work tree,
// gets no output either, as in the other hooks: the hand-off and publish steps still check the
// branch after the run.
// Git runs with argument lists, never a shell, and the branch name is checked before any git call.
// Tests: .claude/hooks/factory-stop-check.test.sh
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BASE = "origin/main";
// <N>-<slug>: the issue number, then lowercase words joined by hyphens (factory-prompt.md).
const FACTORY_BRANCH = /^[1-9][0-9]*-[a-z0-9]+(-[a-z0-9]+)*$/;
// factory.yml's split: CRLF, LF, CR, NEL and the two Unicode separators, written as escapes.
const LINE_BREAK = /\r\n|[\n\r\u0085\u2028\u2029]/;

main();

function main() {
	if (!isFactoryRun(process.env)) return;

	let input;
	try {
		input = JSON.parse(readFileSync(0, "utf8"));
	} catch {
		return;
	}

	const message =
		typeof input.last_assistant_message === "string"
			? input.last_assistant_message
			: lastAssistantText(input.transcript_path);
	const claim = lastFactoryLine(message);
	if (claim === null || !claim.startsWith("FACTORY ready")) return;

	const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : process.cwd();
	if (git(["rev-parse", "--is-inside-work-tree"], cwd) !== "true") return;

	const problems = checkClaim(claim, cwd);
	if (problems.length === 0) return;

	process.stdout.write(JSON.stringify({ decision: "block", reason: reasonFor(problems) }));
}

function isFactoryRun(env) {
	const factoryWorkflow = env.GITHUB_ACTIONS === "true" && env.GITHUB_WORKFLOW === "factory";
	return factoryWorkflow || env.FACTORY_RUN === "1";
}

/** The last line starting `FACTORY `, split as factory.yml splits the message; null when none. */
function lastFactoryLine(message) {
	if (typeof message !== "string") return null;

	const lines = message.split(LINE_BREAK).filter((l) => l.startsWith("FACTORY "));
	return lines.length === 0 ? null : lines[lines.length - 1];
}

/** What is wrong with a `FACTORY ready` claim, one sentence each; empty when it holds. */
function checkClaim(claim, cwd) {
	const branch = /^FACTORY ready:\s*(\S+)\s*$/.exec(claim)?.[1] ?? null;
	if (branch === null || !isBranchName(branch, cwd)) {
		return [`\`${claim.slice(0, 120)}\` names no branch: the line is \`FACTORY ready: <N>-<slug>\``];
	}

	const problems = [];
	if (!commitExists(`refs/heads/${branch}`, cwd)) {
		problems.push(`branch ${branch} doesn't exist (${whereHeadIs(cwd)})`);
	} else if (!commitExists(`refs/remotes/${BASE}`, cwd)) {
		problems.push(`${BASE} is missing, so the commits can't be counted: run \`git fetch origin main\``);
	} else if (countPast(branch, cwd) === 0) {
		problems.push(`branch ${branch} has no commits beyond ${BASE} (${whereHeadIs(cwd)})`);
	}

	const changed = git(["status", "--porcelain"], cwd);
	const paths = changed === null ? [] : changed.split("\n").filter(Boolean);
	if (paths.length > 0) {
		const shown = paths.slice(0, 5).map((p) => p.slice(3));
		problems.push(`the tree is not clean: ${String(paths.length)} paths changed or untracked (${shown.join(", ")})`);
	}
	return problems;
}

function reasonFor(problems) {
	return [
		"Your last message ends with `FACTORY ready`, but the claim doesn't hold:",
		...problems.map((p) => `- ${p}.`),
		"Uncommitted work and a branch that doesn't exist are lost when the run ends (#605, run 45928803367).",
		"Fix it: create the branch where your commits are (`git branch <N>-<slug>` when they landed on HEAD),",
		"commit or remove what is left, check `git log origin/main..<N>-<slug>`, then end with the FACTORY line again.",
		"A command a hook denied didn't run, any part of it: rerun its steps as separate commands.",
		"If you can't, end with `FACTORY stopped: <reason>` instead.",
	].join("\n");
}

/**
 * A factory branch: `<N>-<slug>` as factory-prompt.md names it (factory.yml's hand-off refuses any
 * other, so `main` holding the commits is refused here, while the agent can still fix it), and a
 * name git accepts.
 */
function isBranchName(name, cwd) {
	if (!FACTORY_BRANCH.test(name)) return false;

	return git(["check-ref-format", "--branch", name], cwd) !== null;
}

function commitExists(ref, cwd) {
	return git(["rev-parse", "-q", "--verify", `${ref}^{commit}`], cwd) !== null;
}

function countPast(rev, cwd) {
	return Number(git(["rev-list", "--count", `${BASE}..${rev}`], cwd) ?? "0");
}

/** Where HEAD is and how far past origin/main, so the reason says where the commits went. */
function whereHeadIs(cwd) {
	const head = git(["symbolic-ref", "-q", "--short", "HEAD"], cwd) ?? "detached";
	if (!commitExists(`refs/remotes/${BASE}`, cwd)) return `HEAD is ${head}`;

	return `HEAD is ${head}, ${String(countPast("HEAD", cwd))} commits past ${BASE}`;
}

/** stdout of a git command without its trailing newline (status lines start with a space); null when it fails. */
function git(args, cwd) {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trimEnd();
	} catch {
		return null;
	}
}

/** The text of the last assistant entry in a transcript (JSONL); null when there is none. */
function lastAssistantText(path) {
	if (typeof path !== "string" || path === "") return null;

	let lines;
	try {
		lines = readFileSync(path, "utf8").split("\n");
	} catch {
		return null;
	}
	for (const line of lines.reverse()) {
		const text = assistantText(line);
		if (text !== null) return text;
	}
	return null;
}

function assistantText(line) {
	let entry;
	try {
		entry = JSON.parse(line);
	} catch {
		return null;
	}
	const content = entry?.type === "assistant" ? entry.message?.content : null;
	if (!Array.isArray(content)) return null;

	const texts = content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text);
	return texts.length === 0 ? null : texts.join("\n");
}
