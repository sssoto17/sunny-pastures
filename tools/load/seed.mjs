// Seeds the load run's farms and checks them afterwards, through the admin database connection
// (#388; ADR-0007, "Load and concurrency"). The game API has no clock header and no seed route, so
// a farm's history is written straight into its log, backdated: each farm is a real anonymous
// player (`prepare.py` signs them up), and its rows are built by the real rules, the same
// `createSim(sliceContent)` and `stateHash` the server runs, so the server replays them as its own.
// Run with Node from the repo root, after `pnpm --dir apps/web build` (which builds the sim):
//
//   node tools/load/seed.mjs seed <plan.json>              writes every farm in the plan
//   node tools/load/seed.mjs verify <plan.json> <requests.csv>
//                                                          the lost-update check, as JSON
//
// A plan is `{ "farms": [{ "farmId", "kind": "history" | "pair", "actions", "endAt" }] }`. A
// `history` farm gets `actions` accepted actions (plant, harvest, deliver, discard), its last at
// `endAt` (ms): one ending 8 hours ago is a returning player's. A `pair` farm gets two wheat plots
// planted at `endAt`, ripe by the time `concurrency.py` harvests both at once.
//
// ADMIN_DATABASE_URL comes from the environment or the repo's .env (`pnpm db:env`). No message
// prints it, a token or any other secret.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

// The sim and postgres.js as apps/web resolves them, so this script adds no dependency.
const appRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const load = async (name) => await import(pathToFileURL(appRequire.resolve(name)).href);
const { createSim, sliceContent, stateHash } = await load("@sunny-pastures/sim");
const postgres = (await load("postgres")).default;

/** M3's one rules version (ADR-0006, section 2), stamped on every row as the server does. */
const rulesVersion = 1;
/** B100: a snapshot at every 100th seq (ADR-0001). */
const snapshotEvery = 100;
const wheat = sliceContent.crops.wheat;
const maxYield = wheat.baseYield + wheat.bonusYield;
const sim = createSim(sliceContent);

const [command, ...args] = process.argv.slice(2);
const sql = postgres(readAdminUrl(), { max: 4 });
try {
	if (command === "seed" && args.length === 1) await seed(readJson(args[0]));
	else if (command === "verify" && args.length === 2) await verify(readJson(args[0]), args[1]);
	else throw new Error("usage: seed.mjs seed <plan.json> | verify <plan.json> <requests.csv>");
} finally {
	await sql.end();
}

async function seed({ farms }) {
	const started = Date.now();
	let actions = [];
	let snapshots = [];
	let written = 0;
	for (const farm of farms) {
		const rows = buildRows(farm);
		actions.push(...rows.actions);
		snapshots.push(...rows.snapshots);
		if (actions.length >= 20_000) {
			written += await insert(actions, snapshots);
			actions = [];
			snapshots = [];
		}
	}
	written += await insert(actions, snapshots);
	const seconds = ((Date.now() - started) / 1000).toFixed(1);
	console.log(`seeded ${String(farms.length)} farms, ${String(written)} actions, in ${seconds} s`);
}

/** One farm's log rows and snapshots, as the store's commit would have written them. */
function buildRows({ farmId, kind, actions, endAt }) {
	const script = kind === "pair" ? pairScript() : historyScript(farmId, actions);
	// The rules are the same at any time (a new farm is at time 0 with nothing due), so the script
	// is moved to end at `endAt` and applied again there, which also checks every action still holds.
	const shift = endAt - script.at(-1).at;
	let farm = sim.newFarm(farmId);
	const rows = { actions: [], snapshots: [] };
	for (const [i, step] of script.entries()) {
		const seq = i + 1;
		const at = step.at + shift;
		const result = sim.apply(farm, step.action, at);
		if (!result.ok) throw new Error(`farm ${farmId}: seq ${String(seq)} refused: ${result.reason}`);
		farm = result.state;
		const answer = { seq, hash: stateHash(farm), rebased: false, retries: 0 };
		rows.actions.push([farmId, seq, at, step.action, randomUUID(), answer]);
		if (seq % snapshotEvery === 0) rows.snapshots.push([farmId, seq, at, farm]);
	}
	return rows;
}

/** Two wheat plots planted a second apart: both ripe once the grow time has passed. */
function pairScript() {
	return [0, 1].map((plot) => ({
		action: { type: "plant", plot, crop: "wheat" },
		at: 1_000 * (plot + 1),
	}));
}

/** `count` actions a busy player could have made, from a new farm, one second apart at most. */
function historyScript(farmId, count) {
	const script = [];
	let farm = sim.newFarm(farmId);
	let at = 1_000;
	while (script.length < count) {
		farm = sim.advance(farm, at);
		const action = chooseAction(farm);
		const result = action === null ? null : sim.apply(farm, action, at);
		if (result?.ok) {
			script.push({ action, at });
			farm = result.state;
			at += 1_000;
		} else {
			at += 10_000;
			const idle = at - (script.at(-1)?.at ?? 0);
			if (idle > 86_400_000) throw new Error(`farm ${farmId}: stuck at ${String(script.length)}`);
		}
	}
	return script;
}

/** The first of: harvest, deliver, plant wheat, discard an order for goods it never makes. */
function chooseAction(farm) {
	const stored = Object.values(farm.silo).reduce((sum, n) => sum + n, 0);
	const ready = farm.plots.findIndex((plot) => plot.status === "ready");
	if (ready !== -1 && stored + maxYield <= sliceContent.silo.capacity) {
		return { type: "harvest", plot: ready };
	}

	const have = (good) => (farm.silo[good] ?? 0) + (farm.barn[good] ?? 0);
	const open = (test) =>
		farm.board.findIndex(
			(slot) =>
				slot.status === "open" &&
				slot.order.goods[test]((g) =>
					test === "every" ? have(g.good) >= g.amount : g.good !== "wheat",
				),
		);
	const deliverable = open("every");
	if (deliverable !== -1) return { type: "deliver", slot: deliverable };

	const empty = farm.plots.findIndex((plot) => plot.status === "empty");
	if (empty !== -1 && farm.coins >= wheat.seedPrice)
		return { type: "plant", plot: empty, crop: "wheat" };

	const unfillable = open("some");
	return unfillable === -1 ? null : { type: "discard", slot: unfillable };
}

async function insert(actions, snapshots) {
	const column = (rows, i, map = (x) => x) => rows.map((row) => map(row[i]));
	const json = (value) => JSON.stringify(value);
	await sql.begin(async (tx) => {
		await tx`
			insert into game.actions (farm_id, seq, at, action, idempotency_key, answer, rules_version)
			select farm_id, seq, at, action, key, answer, ${rulesVersion}::integer from unnest(
				${column(actions, 0)}::uuid[], ${column(actions, 1)}::bigint[], ${column(actions, 2)}::bigint[],
				${column(actions, 3, json)}::jsonb[], ${column(actions, 4)}::uuid[], ${column(actions, 5, json)}::jsonb[]
			) as t(farm_id, seq, at, action, key, answer)`;
		if (snapshots.length === 0) return;

		await tx`
			insert into game.snapshots (farm_id, seq, at, state, rules_version)
			select farm_id, seq, at, state, ${rulesVersion}::integer from unnest(
				${column(snapshots, 0)}::uuid[], ${column(snapshots, 1)}::bigint[],
				${column(snapshots, 2)}::bigint[], ${column(snapshots, 3, json)}::jsonb[]
			) as t(farm_id, seq, at, state)`;
	});
	return actions.length;
}

/**
 * The lost-update check (ADR-0001, "Method"): each farm's seq is rebuilt from its log, and must be
 * its seeded seq plus the actions the run saw accepted, with no gap; and every accepted action's
 * key must be in the log at the seq its answer gave. A row the run never saw answered (a reply lost
 * on the way) is counted apart: it is no lost update.
 */
async function verify({ farms }, requestsPath) {
	const seeded = new Map(farms.map((farm) => [farm.farmId, seededSeq(farm)]));
	const accepted = readAccepted(requestsPath);
	const ids = [...seeded.keys()];
	const logs = await sql`
		select farm_id::text as farm, count(*)::int as rows, coalesce(max(seq), 0)::bigint as top
		from game.actions where farm_id = any(${ids}::uuid[]) group by farm_id`;
	const keys = accepted.map((a) => a.key);
	const found = await sql`
		select idempotency_key::text as key, seq::bigint as seq
		from game.actions where idempotency_key = any(${keys}::uuid[])`;
	const seqByKey = new Map(found.map((row) => [row.key, Number(row.seq)]));

	const perFarm = new Map(ids.map((id) => [id, 0]));
	for (const a of accepted) perFarm.set(a.farm, (perFarm.get(a.farm) ?? 0) + 1);
	const report = {
		farms: ids.length,
		accepted: accepted.length,
		lostUpdates: 0,
		gaps: 0,
		unanswered: 0,
		mismatched: 0,
	};
	report.lostUpdates = accepted.filter((a) => seqByKey.get(a.key) !== a.seq).length;
	const byFarm = new Map(logs.map((row) => [row.farm, row]));
	for (const id of ids) {
		const log = byFarm.get(id) ?? { rows: 0, top: 0 };
		const top = Number(log.top);
		if (log.rows !== top) report.gaps += 1;
		const expected = (seeded.get(id) ?? 0) + (perFarm.get(id) ?? 0);
		if (top > expected) report.unanswered += top - expected;
		if (top < expected) report.mismatched += 1;
	}
	console.log(JSON.stringify(report));
	if (report.lostUpdates + report.gaps + report.mismatched > 0) process.exitCode = 1;
}

function seededSeq(farm) {
	return farm.kind === "pair" ? 2 : farm.actions;
}

/** The accepted actions in a run's request log: POSTs answered 200, with their farm, key and seq. */
function readAccepted(path) {
	const [header, ...lines] = readFileSync(path, "utf8").trim().split("\n");
	const at = Object.fromEntries(header.split(",").map((name, i) => [name, i]));
	return lines
		.map((line) => line.split(","))
		.filter((cells) => cells[at.method] === "POST" && cells[at.status] === "200")
		.map((cells) => ({
			farm: cells[at.farm],
			key: cells[at.key],
			seq: Number(cells[at.answerSeq]),
		}));
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

/** ADMIN_DATABASE_URL from the environment, else from the repo's .env. Never printed. */
function readAdminUrl() {
	let value = process.env.ADMIN_DATABASE_URL;
	if (!value) {
		try {
			value = parseEnv(
				readFileSync(new URL("../../.env", import.meta.url), "utf8"),
			).ADMIN_DATABASE_URL;
		} catch (error) {
			throw new Error("seed.mjs can't read .env: run pnpm db:env first.", { cause: error });
		}
	}
	if (!value) throw new Error("ADMIN_DATABASE_URL isn't set: run pnpm db:env first.");
	return value;
}
