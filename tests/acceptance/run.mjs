// `pnpm test:acceptance` (ADR-0007 section 6, "Acceptance tests"; #386): builds the app with
// `next build`, starts it with `next start` (never `next dev`), waits until `/api/health` answers
// 200, runs the suite (./vitest.config.mts) against it, and stops the app, pass or fail.
//
// With ACCEPTANCE_BASE_URL set in the shell, the app is someone else's (M4's preview): the suite
// runs against it with the shell's variables, building and starting nothing. Otherwise the app and
// the suite run against the local stack, with ./.env's variables (`pnpm db:env` writes them from the
// running stack) over the shell's: a SUPABASE_URL left in the shell for another stack would
// otherwise sign players up on one Auth and verify them on another. Nothing here prints a value.
//
// Exit codes: the suite's own, or 1 when the app can't be built, started or reached.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { parseEnv } from "node:util";

// Away from Next's default 3000, so a `next dev` left running can't answer for the built app.
const port = 3100;
const host = "127.0.0.1";
// `next start` answers within seconds; a minute means it won't.
const healthTimeoutMs = 60_000;
// How long the app gets to exit on SIGTERM before SIGKILL.
const stopTimeoutMs = 10_000;

if (process.env.ACCEPTANCE_BASE_URL) {
	console.log("ACCEPTANCE_BASE_URL is set: running the suite against it, with no local build.");
	process.exit(await runSuite(process.env));
}

const env = { ...process.env, ...readEnvFile(".env"), NEXT_TELEMETRY_DISABLED: "1" };

await runStep("next build", "pnpm", ["--dir", "apps/web", "build"]);

const baseUrl = `http://${host}:${String(port)}`;
const healthUrl = `${baseUrl}/api/health`;
// A server already on the port (one a killed run left behind) would answer the health check for a
// stale build while the new `next start` fails to bind, so the run stops instead.
if ((await readStatus(healthUrl)) !== "no answer") {
	console.error(`Something already answers on ${baseUrl}: stop it, then run this again.`);
	process.exit(1);
}

// Its own process group, so stopping it stops pnpm and the Next server under it.
const app = spawn(
	"pnpm",
	["--dir", "apps/web", "exec", "next", "start", "--port", String(port), "--hostname", host],
	{ env, stdio: "inherit", detached: true },
);
const exited = once(app, "exit");
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.once(signal, () => {
		signalApp("SIGKILL");
		process.exit(1);
	});
}

let code = 1;
try {
	await waitForHealth(healthUrl);
	code = await runSuite({ ...env, ACCEPTANCE_BASE_URL: baseUrl });
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
} finally {
	await stopApp();
}
process.exit(code);

// Runs the suite and resolves with its exit code. This script's own arguments go on to Vitest
// (`pnpm test:acceptance --reporter=verbose`, or a file filter).
async function runSuite(suiteEnv) {
	const args = ["exec", "vitest", "run", "--config", "tests/acceptance/vitest.config.mts"];
	const suite = spawn("pnpm", [...args, ...process.argv.slice(2)], {
		env: suiteEnv,
		stdio: "inherit",
	});
	return await new Promise((resolve) => suite.once("exit", (status) => resolve(status ?? 1)));
}

// Runs one command to the end; a non-zero exit stops the run.
async function runStep(name, command, args) {
	const child = spawn(command, args, { env, stdio: "inherit" });
	const status = await new Promise((resolve) => child.once("exit", resolve));
	if (status !== 0) {
		console.error(`${name} failed (exit ${String(status)}).`);
		process.exit(1);
	}
}

// Polls the health route until it answers 200. It throws if the app exits first or the time runs
// out. A 500 means a variable is missing (#470): health reads the config, as the game routes do.
async function waitForHealth(url) {
	const deadline = Date.now() + healthTimeoutMs;
	let last = "no answer";
	while (Date.now() < deadline) {
		if (hasExited()) throw new Error("next start exited before /api/health answered.");

		last = await readStatus(url);
		if (last === "status 200") return;

		await sleep(250);
	}
	throw new Error(
		`/api/health didn't answer 200 within ${String(healthTimeoutMs / 1000)} s (last: ${last}). Did pnpm db:env write .env?`,
	);
}

// The health route's status, or "no answer" when nothing listens.
async function readStatus(url) {
	try {
		const response = await globalThis.fetch(url);
		return `status ${String(response.status)}`;
	} catch {
		return "no answer";
	}
}

// `.env` is optional: CI sets the variables itself. Any other read error stops the run.
function readEnvFile(path) {
	try {
		return parseEnv(readFileSync(path, "utf8"));
	} catch (error) {
		if (error.code === "ENOENT") return {};

		throw error;
	}
}

// SIGTERM, then SIGKILL if the app hasn't exited within stopTimeoutMs, so a stop can't hang.
async function stopApp() {
	if (hasExited()) return;

	signalApp("SIGTERM");
	await Promise.race([exited, sleep(stopTimeoutMs)]);
	if (!hasExited()) {
		signalApp("SIGKILL");
		await exited;
	}
}

function hasExited() {
	return app.exitCode !== null || app.signalCode !== null;
}

function signalApp(signal) {
	try {
		process.kill(-app.pid, signal);
	} catch (error) {
		// ESRCH: the group is already gone, which is what stopping wants.
		if (error.code !== "ESRCH") throw error;
	}
}
