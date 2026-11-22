#!/usr/bin/env node
// PermissionRequest (#574): in a cloud session, answers every would-be permission prompt with a deny.
// Nobody watches an unattended cloud run, so a prompt stalls it at "requires action" for hours
// (#388's load run twice and #513 once on 22 Nov), while a deny costs one retry: the agent
// rewrites the command and carries on.
// Local sessions get no output, so they prompt as before. It never grants anything, so it can
// only narrow what a run may do. A cloud environment someone works in by hand sets
// `CLAUDE_ATTENDED=1` and gets its prompts back; without it, the deny stays, so a forgotten
// variable can't stall an unattended run.
// Tests: .claude/hooks/deny-prompts-when-remote.test.sh
import { readFileSync } from "node:fs";

const REASON =
	"No one can answer a permission prompt in this unattended cloud session, so it was denied. " +
	"Retry as simpler, separate commands: split chained or piped commands, and avoid quoting, " +
	"heredocs or substitutions the permission check can't parse. If the step still can't run, " +
	"skip it and report it in your final message.";

try {
	readFileSync(0);
} catch {
	// stdin is only drained; the decision does not depend on it
}

if (process.env.CLAUDE_CODE_REMOTE === "true" && process.env.CLAUDE_ATTENDED !== "1") {
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PermissionRequest",
				decision: { behavior: "deny", message: REASON },
			},
		}),
	);
}
