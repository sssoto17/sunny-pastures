// Progress: the Level, what it unlocks, and buying (MUST-05; ADR-0005, section 3). The Level is
// derived from XP through the Level table, never stored (D12).
import type { Content, LevelRow } from "../content/index.js";
import { refuse } from "../state/index.js";
import type { ApplyResult, FarmState } from "../state/index.js";

/** The progress rules for one content, prepared once in createSim. */
export interface ProgressRules {
	/** The XP and level-up coins of each Level, Level 1 first. */
	readonly levels: readonly { readonly xp: number; readonly coins: number }[];
	/** The Level that unlocks each crop. */
	readonly cropLevels: ReadonlyMap<string, number>;
	/** The Level that unlocks each facility (#84). */
	readonly facilityLevels: ReadonlyMap<string, number>;
	/** The Level that unlocks each pen (#86). */
	readonly penLevels: ReadonlyMap<string, number>;
	/** The Level that unlocks each good for orders (#87). */
	readonly orderGoodLevels: ReadonlyMap<string, number>;
}

/** Copies what the rules read, so a later change to the content object can't reach them. */
export function prepareProgressRules(content: Content): ProgressRules {
	const levels = content.levels.map(({ xp, coins }) => ({ xp, coins }));
	return {
		levels,
		cropLevels: mapUnlockLevels(content, (level) => level.crops),
		facilityLevels: mapUnlockLevels(content, (level) => level.facilities),
		penLevels: mapUnlockLevels(content, (level) => level.pens),
		orderGoodLevels: mapUnlockLevels(content, (level) => level.orderGoods),
	};
}

/** The Level a farm with `xp` is at, from 1 (MUST-05.3): the Levels whose XP it has reached. */
export function levelOf(xp: number, rules: ProgressRules): number {
	return rules.levels.filter((level) => level.xp <= xp).length;
}

/** Something the farm can buy: unlocked at `level`, then bought for `price` coins. */
export interface Offer {
	/** What is bought, as the subject of a refusal sentence, for example "Plot 7". */
	readonly what: string;
	/** The Level that unlocks it, or null if no Level does: then it is never bought. */
	readonly level: number | null;
	readonly price: number;
}

/**
 * The purchase rule every upgrade uses (spec decision 1, MUST-05.6, #72 D3): refused while the
 * offer is locked or the farm has too few coins (MUST-05.1); otherwise the farm pays the price.
 * The caller then adds what was bought, so it exists on the farm only once bought.
 */
export function purchase(farm: FarmState, offer: Offer, rules: ProgressRules): ApplyResult {
	const locked = lockedReason(offer.what, offer.level, farm.xp, rules);
	if (locked !== null) return refuse(locked);

	if (farm.coins < offer.price) {
		return refuse(
			`${offer.what} costs ${String(offer.price)} coins, and the farm has ${String(farm.coins)}.`,
		);
	}

	return { ok: true, state: { ...farm, coins: farm.coins - offer.price } };
}

/**
 * Why a farm with `xp` can't plant the crop yet, as a sentence for a refusal, or null if the
 * crop is unlocked (MUST-01.1, 01.5). A crop no Level lists is never unlocked; #89's content check
 * keeps every crop reachable (MUST-05.5).
 */
export function cropLocked(cropId: string, xp: number, rules: ProgressRules): string | null {
	return lockedReason(`The crop ${cropId}`, rules.cropLevels.get(cropId) ?? null, xp, rules);
}

/**
 * The first Level that lists an id unlocks it. Built from the table's array order, never from
 * object keys (MUST-10.6).
 */
function mapUnlockLevels(
	content: Content,
	listed: (level: LevelRow) => readonly string[],
): ReadonlyMap<string, number> {
	const unlocks = new Map<string, number>();
	content.levels.forEach((level, i) => {
		for (const id of listed(level)) if (!unlocks.has(id)) unlocks.set(id, i + 1);
	});
	return unlocks;
}

/** Why `what`, unlocked at `level` (null: at none), isn't unlocked yet, or null if it is. */
function lockedReason(
	what: string,
	level: number | null,
	xp: number,
	rules: ProgressRules,
): string | null {
	if (level === null) return `${what} isn't unlocked at any Level.`;

	const current = levelOf(xp, rules);
	if (current >= level) return null;

	return `${what} isn't unlocked: it unlocks at Level ${String(level)}, and you're at Level ${String(current)}.`;
}

/**
 * Adds XP to the farm and pays the level-up coins of every Level it reaches (MUST-05.2, 05.4). A
 * Level is paid when its XP is above the farm's old XP and at or below the new: XP never goes
 * down, so each Level is crossed, and paid, once in a farm's life, however many one gain crosses.
 * That holds within one rules version; a version that moves a threshold past farms handles them in
 * its `upgrade` (ADR-0006, section 6).
 */
export function gainXp(farm: FarmState, xp: number, rules: ProgressRules): FarmState {
	if (xp === 0) return farm;

	const reached = farm.xp + xp;
	const paid = rules.levels
		.filter((level) => level.xp > farm.xp && level.xp <= reached)
		.reduce((total, level) => total + level.coins, 0);
	return { ...farm, xp: reached, coins: farm.coins + paid };
}
