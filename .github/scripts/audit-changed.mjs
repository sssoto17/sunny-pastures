#!/usr/bin/env node
// audit-changed.mjs: the changed-code gate (CONSTRAINTS.md, the Duplication, Complexity and Dead
// code rows; #503). `pnpm audit:changed` runs it in `check:task`, `check:full` and `ci / lint`.
//
// It runs `fallow audit` once, as JSON, saves the report to a temporary file and renders it from
// there: annotations and the job summary under Actions, the same summary on stdout otherwise. Fallow
// 3.43.1 fails the audit on an introduced dead-code or complexity finding, but its verdict treats a
// clone group as a warning only, with no rule to raise it. So this script also fails on a clone
// group the change introduced (`introduced: true` under the `new-only` gate, every group under
// `--gate all`), and on any clone in a changed packages/sim file, as the Duplication row asks.
//
// Usage: node .github/scripts/audit-changed.mjs [fallow audit options, e.g. --base origin/main]
// Exit codes: Fallow's own when it isn't 0 (1 for a failed verdict, 2 when it couldn't run); 1 when
// a clone group fails the Duplication row; 0 otherwise. A report that isn't JSON exits 2.
import { spawnSync } from "node:child_process";
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FALLOW = fileURLToPath(new URL("../../node_modules/.bin/fallow", import.meta.url));
// Outside the checkout, so Prettier and git never see it; removed once rendered.
const REPORT = join(tmpdir(), `audit-changed-${String(process.pid)}.json`);

const fallow = (args) =>
	spawnSync(FALLOW, args, {
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
		// The base snapshot logs WARN lines about the base revision; `pnpm boundaries` does the same.
		env: { ...process.env, RUST_LOG: "error" },
	});

const audit = fallow(["audit", "--format", "json", "--quiet", ...process.argv.slice(2)]);
let report;
try {
	report = JSON.parse(audit.stdout);
} catch {
	process.stderr.write(audit.stderr);
	console.error(`audit-changed: fallow audit gave no JSON report (exit ${String(audit.status)})`);
	process.exit(2);
}
writeFileSync(REPORT, audit.stdout);
try {
	render();
} finally {
	rmSync(REPORT, { force: true });
}
const clones = failingClones(report);
for (const group of clones) {
	const where = group.instances.map(
		(i) => `${i.file}:${String(i.start_line)}-${String(i.end_line)}`,
	);
	const first = group.instances[0];
	const line = `A clone group in this change (CONSTRAINTS.md, Duplication): ${where.join(", ")}`;
	if (process.env["GITHUB_ACTIONS"] === "true")
		console.log(`::error file=${first.file},line=${String(first.start_line)}::${line}`);
	else console.error(line);
}
console.log(
	`fallow audit: verdict ${String(report.verdict)}, exit ${String(audit.status)}, ${String(report.elapsed_ms)} ms; ${String(clones.length)} clone group(s) failing`,
);
if (audit.status !== 0) process.exit(audit.status ?? 2);
process.exit(clones.length > 0 ? 1 : 0);

// Fallow's own rendering of the saved report: annotations and the job summary under Actions (they
// need no write permission), the same summary on stdout otherwise.
function render() {
	const as = (format) => {
		const r = fallow(["report", "--from", REPORT, "--format", format, "--quiet"]);
		if (r.status !== 0) {
			process.stderr.write(r.stderr);
			throw new Error(`audit-changed: fallow report --format ${format} failed`);
		}
		return r.stdout;
	};
	if (process.env["GITHUB_ACTIONS"] !== "true") {
		process.stdout.write(as("github-summary"));
		return;
	}
	process.stdout.write(as("github-annotations"));
	const summary = process.env["GITHUB_STEP_SUMMARY"];
	if (summary) appendFileSync(summary, as("github-summary"));
}

// The clone groups that fail the change: those it introduced, and under `new-only` also any group
// with a copy in packages/sim that the report lists (it touches a changed file), since the
// Duplication row kept the sim's bar from before #503: 0 clones in its changed files.
function failingClones(r) {
	const groups = r.duplication?.clone_groups ?? [];
	if (r.attribution?.gate !== "new-only") return groups;

	return groups.filter(
		(g) => g.introduced === true || g.instances.some((i) => i.file.startsWith("packages/sim/")),
	);
}
