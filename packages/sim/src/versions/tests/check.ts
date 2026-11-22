// The rules-version check's assertions (ADR-0006, section 10), each as a list of faults, so the
// check (rulesVersionCheck.test.ts) expects none and check.test.ts shows each one finds its fault.
import { stateHash } from "../../index.js";
import type { Content, FarmState } from "../../index.js";
import { assertSafeIntegers } from "../../state/index.js";
import type { TimedAction } from "../../state/tests/farms.js";
import { createVersions, listVersions } from "../index.js";
import type { LoggedRow, Registry, VersionedFarm } from "../index.js";
import type { RecordedLog, Recording } from "./record.js";

/**
 * Assertion 1, frozen content: every released version's content hashes to its recorded hash, and
 * only a prefix of the versions is released (content after an unreleased version can't be frozen).
 */
export function listFrozenFaults(registry: Registry): string[] {
	const all = listVersions(registry);
	return all.flatMap(({ content, contentHash }, i) => {
		const version = String(i + 1);
		if (contentHash === null) return [];

		const faults: string[] = [];
		if (stateHash(content) !== contentHash) {
			faults.push(`version ${version}'s content no longer hashes to its recorded hash`);
		}
		if (all[i - 1]?.contentHash === null) {
			faults.push(`version ${version} is released after an unreleased version`);
		}
		return faults;
	});
}

/**
 * Assertion 2, old logs replay: each recorded log replays on today's code to every row's hash,
 * and `replay` ends on the last row's farm, which advanced offline to `to` hashes to the log's.
 */
export function listReplayFaults(registry: Registry, { rulesVersion, logs }: Recording): string[] {
	const versions = createVersions(registry);
	return logs.flatMap((log) => {
		const faults: string[] = [];
		try {
			let farm: VersionedFarm = {
				state: versions.getSim(rulesVersion).newFarm(log.farmId),
				rulesVersion,
			};
			for (const row of log.rows) {
				farm = versions.applyRow(farm, { ...row, rulesVersion });
				if (stateHash(farm.state) !== row.hash) {
					faults.push(`${log.farmId}: seq ${String(row.seq)} replays to another farm`);
				}
			}
			const replayed = versions.replay(log.farmId, [], listRows(log, rulesVersion));
			const offline = versions.getSim(rulesVersion).advance(replayed.state, log.to);
			if (stateHash(offline) !== log.hash) {
				faults.push(`${log.farmId}: the farm after its last row replays to another farm`);
			}
		} catch (error) {
			faults.push(`${log.farmId}: ${readMessage(error)}`);
		}
		return faults;
	});
}

/**
 * Assertion 3, version upgrades are total and keep the farm: `farm`, of `rulesVersion`, upgraded
 * to the next version and to the current one, doesn't throw, holds MUST-14's bounds under the
 * target's content, survives a JSON round trip and keeps every shared fact no version declares.
 */
export function listUpgradeFaults(
	registry: Registry,
	rulesVersion: number,
	farm: FarmState,
): string[] {
	const versions = createVersions(registry);
	const targets = [...new Set([rulesVersion + 1, versions.current])];
	return targets.flatMap((to) => {
		const label = `${String(rulesVersion)} → ${String(to)}`;
		let upgraded: FarmState;
		try {
			upgraded = versions.upgradeTo({ state: farm, rulesVersion }, to).state;
		} catch (error) {
			return [`${label} throws: ${readMessage(error)}`];
		}

		const target = listVersions(registry)[to - 1];
		if (target === undefined) return [`${label}: the registry has no version ${String(to)}`];

		const declared = new Set(
			registry.later.slice(rulesVersion - 1, to - 1).flatMap(({ changes }) => changes),
		);
		return [
			...listInvariantFaults(upgraded, target.content),
			...(isPlainJson(upgraded) ? [] : ["it doesn't survive a JSON round trip"]),
			...listChangedFacts(farm, upgraded, declared),
		].map((fault) => `${label}: ${fault}`);
	});
}

/**
 * Assertion 4, across the boundary: `log` (of `rulesVersion`), given its version upgrade to the
 * current version and continued with `played` under it, ends on the same farm replayed from its
 * first action as from a base snapshot written at the boundary, beside the old version's snapshot.
 */
export function listBoundaryFaults(
	registry: Registry,
	rulesVersion: number,
	log: RecordedLog,
	played: readonly TimedAction[],
): string[] {
	const versions = createVersions(registry);
	const { current } = versions;
	const old = listRows(log, rulesVersion);
	const last = versions.replay(log.farmId, [], old);
	const base = versions.upgradeTo(last, current);
	const continued: LoggedRow[] = [];
	let farm = base.state;
	for (const { action, delay } of played) {
		const at = farm.time + delay;
		const result = versions.getSim(current).apply(farm, action, at);
		if (!result.ok) continue;

		farm = result.state;
		continued.push({ seq: old.length + continued.length + 1, at, action, rulesVersion: current });
	}

	const rows = [...old, ...continued];
	const seq = old.length;
	const snapshots = [
		{ seq, ...last },
		// The base snapshot as the store keeps it: through JSON (ADR-0003, plain data).
		{ seq, rulesVersion: current, state: JSON.parse(JSON.stringify(base.state)) as FarmState },
	];
	const load = (from: VersionedFarm): string => stateHash(versions.upgradeTo(from, current).state);
	const fromFirst = load(versions.replay(log.farmId, [], rows));
	const fromBase = load(versions.replay(log.farmId, snapshots, rows));
	return fromFirst === stateHash(farm) && fromBase === fromFirst
		? []
		: [`${log.farmId}: the replay from the base snapshot ends on another farm`];
}

/** MUST-14.4's bounds for a farm of any content, and the state's shape that content fixes. */
export function listInvariantFaults(farm: FarmState, content: Content): string[] {
	const faults: string[] = [];
	try {
		assertSafeIntegers(farm);
	} catch (error) {
		faults.push(readMessage(error));
	}
	const sum = (pick: (row: Content["levels"][number]) => number): number =>
		content.levels.reduce((total, row) => total + pick(row), 0);
	if (farm.coins < 0 || farm.xp < 0) faults.push("coins or XP below 0");
	for (const [name, goods, capacity] of [
		["silo", farm.silo, content.silo.capacity],
		["barn", farm.barn, content.barn.capacity],
	] as const) {
		const counts = Object.values(goods);
		if (counts.some((count) => count <= 0)) faults.push(`the ${name} keeps a count of 0 or less`);
		if (counts.reduce((total, count) => total + count, 0) > capacity) {
			faults.push(`the ${name} holds more than its capacity`);
		}
	}
	if (farm.plots.length > content.start.plots + sum((row) => row.plots)) {
		faults.push("more plots than content allows");
	}
	if (farm.board.length > sum((row) => row.orderSlots)) {
		faults.push("more order slots than content gives");
	}
	if (farm.facilities.length !== content.facilities.length) {
		faults.push("a facility entry per content facility");
	}
	if (farm.pens.length !== content.pens.length) faults.push("a pen entry per content pen");
	farm.facilities.forEach((owned, i) => {
		const facility = content.facilities[i];
		if (owned === null || facility === undefined) return;

		const slots = owned.tier === 1 ? facility.slots : facility.tiers[owned.tier - 2]?.slots;
		if (slots === undefined || owned.jobs.length > slots) {
			faults.push(`facility ${String(i)}'s queue is over its tier's slots`);
		}
	});
	farm.pens.forEach((owned, i) => {
		const pen = content.pens[i];
		if (owned === null || pen === undefined) return;

		const isBounded =
			owned.trough >= 0 && owned.trough <= pen.troughCapacity && owned.products >= 0;
		if (!isBounded || owned.animals.length !== pen.animals) {
			faults.push(`pen ${String(i)} is out of its bounds`);
		}
	});
	return faults;
}

/** The facts of `before` that `after` changed, other than the `declared` ones (section 6). */
function listChangedFacts(
	before: FarmState,
	after: FarmState,
	declared: ReadonlySet<keyof FarmState>,
): string[] {
	const keys = Object.keys(before) as (keyof FarmState)[];
	return keys.flatMap((key) => {
		if (declared.has(key)) return [];

		const was = before[key];
		const now = after[key];
		// A list keeps its entries and may gain new ones from content (new plots, facilities, pens).
		const kept = Array.isArray(was) && Array.isArray(now) ? now.slice(0, was.length) : now;
		return isSame(kept, was) ? [] : [`it changed the shared fact ${key}`];
	});
}

/** Whether `farm` comes back from a JSON round trip as the same farm (ADR-0003, section 9). */
function isPlainJson(farm: FarmState): boolean {
	return isSame(JSON.parse(JSON.stringify(farm)), farm);
}

/** Whether two values are the same plain JSON data; a value that isn't plain JSON is never. */
function isSame(a: unknown, b: unknown): boolean {
	try {
		return stateHash(a) === stateHash(b);
	} catch {
		// stateHash refuses what isn't plain JSON data, such as undefined or NaN (MUST-10.5).
		return false;
	}
}

function listRows(log: RecordedLog, rulesVersion: number): LoggedRow[] {
	return log.rows.map(({ seq, at, action }) => ({ seq, at, action, rulesVersion }));
}

function readMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
