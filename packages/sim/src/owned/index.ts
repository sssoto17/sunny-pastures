// The owned list: one entry per content item of a kind, null until the farm buys it (facilities
// and pens; ADR-0003, section 18). Lookup, the "isn't bought" and "already bought" refusals,
// buy-once and replace are written once here (#541).

/** What the list needs of a content item's rule: its id, to name it in a sentence. */
interface Ruled {
	readonly id: string;
}

/** An entry that was bought, with the rule it belongs to. */
export interface Found<Rule, Owned> {
	readonly rule: Rule;
	readonly owned: Owned;
}

/** The rule at `index`, or null if the index names no content item (negative, fractional, past the end). */
export function findRule<Rule>(rules: readonly Rule[], index: number): Rule | null {
	return Number.isSafeInteger(index) && index >= 0 ? (rules[index] ?? null) : null;
}

/**
 * The farm's entry for a content item: null until bought. Every farm has one entry per content
 * item (ADR-0003, section 12), so a missing entry is a broken farm, a programmer error, and
 * throws a RangeError rather than refuse (D15).
 */
function readOwned<Owned>(
	entries: readonly (Owned | null)[],
	index: number,
	rule: Ruled,
): Owned | null {
	const entry = entries[index];
	if (entry === undefined) {
		throw new RangeError(
			`The farm has no entry for the ${rule.id}: its entries don't match the content.`,
		);
	}

	return entry;
}

/**
 * The bought entry at `index` and its rule, or why there is none, as a sentence. `describeNone`
 * words the refusal for an index that names no content item.
 */
export function findOwned<Rule extends Ruled, Owned>(
	entries: readonly (Owned | null)[],
	rules: readonly Rule[],
	index: number,
	describeNone: (index: number) => string,
): Found<Rule, Owned> | string {
	const rule = findRule(rules, index);
	if (rule === null) return describeNone(index);

	const owned = readOwned(entries, index, rule);
	if (owned === null) return `The ${rule.id} isn't bought.`;

	return { rule, owned };
}

/**
 * The rule at `index` if the farm hasn't bought it yet, or why not, as a sentence: buy-once, so an
 * action sent twice buys one.
 */
export function findUnowned<Rule extends Ruled>(
	entries: readonly unknown[],
	rules: readonly Rule[],
	index: number,
	describeNone: (index: number) => string,
): Rule | string {
	const rule = findRule(rules, index);
	if (rule === null) return describeNone(index);
	if (readOwned(entries, index, rule) !== null) return `The ${rule.id} is already bought.`;

	return rule;
}

/**
 * The entries with the one at `index` set. The farm has one entry per content item, so an index
 * past them is a broken farm and throws a RangeError, rather than dropping the entry (D15).
 */
export function replaceOwned<Owned>(
	entries: readonly (Owned | null)[],
	index: number,
	owned: Owned,
): readonly (Owned | null)[] {
	if (index < 0 || index >= entries.length) {
		throw new RangeError(`The farm has no entry ${String(index + 1)} to replace.`);
	}

	return entries.map((current, i) => (i === index ? owned : current));
}
