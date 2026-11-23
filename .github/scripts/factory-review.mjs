// factory-review.mjs: what the factory's fix rounds read from sunny-reviewer[bot]'s reviews (#588;
// ADR-0002, area 2, "Fix rounds (#588)"). The sweep (factory-sweep.mjs) picks a PR with it, and
// factory.yml's fix gate (factory-fix-gate.mjs) checks the PR again and hands Claude the findings.
// Pure functions over the REST shape of `GET /repos/{o}/{r}/pulls/{n}/reviews`; no I/O.
// Tests: .github/scripts/tests/factory-review.test.mjs

const REVIEWER = "sunny-reviewer[bot]";

// An item of the review's "Findings" list: `1. [Required, confirmed] …` or `- [Optional] …`.
const ITEM = /^\s*(?:\d+[.)]|[-*])\s+\[/;
const REQUIRED = /^\s*(?:\d+[.)]|[-*])\s+\[\s*required\b/i;
const FINDINGS = /^[\s#*]*findings[\s*:]*$/i;

/**
 * The reviewer's newest review that gives a verdict, or null. Dismissed and pending reviews don't
 * count, and neither does a review with an empty body: the reviewer posts its line comments in
 * reviews of their own, with no body, beside the one that holds the verdict (PR #586).
 */
export const newestVerdict = (reviews) => {
	const counted = reviews.filter(
		(r) =>
			r.user?.login === REVIEWER &&
			r.state !== "DISMISSED" &&
			r.state !== "PENDING" &&
			(r.body ?? "").trim() !== "",
	);
	if (counted.length === 0) return null;
	// Ties keep the later one: the API lists reviews oldest first.
	return counted.reduce((a, b) =>
		Date.parse(b.submitted_at) >= Date.parse(a.submitted_at) ? b : a,
	);
};

/** Whether a review sends the PR back for fixes: Request changes, or a "merge after fixes" verdict. */
export const wantsFixes = (review) =>
	review.state === "CHANGES_REQUESTED" ||
	/^merge after fixes\b/i.test((review.body ?? "").trimStart());

/**
 * The review's Required findings, each item with its continuation lines, in order. Only the items
 * of the "Findings" list count; the list ends at the first line of prose after it.
 */
export const requiredFindings = (body) => {
	const lines = (body ?? "").split(/\r?\n/);
	const start = lines.findIndex((l) => FINDINGS.test(l));
	if (start === -1) return [];
	const items = [];
	let current = null;
	for (const line of lines.slice(start + 1)) {
		if (ITEM.test(line)) {
			current = [line.trim()];
			items.push(current);
		} else if (line.trim() === "") current = null;
		else if (current) current.push(line.trim());
		else if (items.length > 0) break;
	}
	return items.filter((it) => REQUIRED.test(it[0])).map((it) => it.join("\n"));
};
