// The goods' names as the player reads them (GLOSSARY.md, "Goods"), in the slice's production
// order: the order the storage popover lists them in. Content holds ids only, so the names are
// copy and live with the screens.
const goodNames: ReadonlyMap<string, string> = new Map([
	["wheat", "Wheat"],
	["chickenFeed", "Chicken feed"],
	["egg", "Eggs"],
	["bread", "Bread"],
	["cookies", "Cookies"],
]);

const goodOrder: readonly string[] = [...goodNames.keys()];

export interface NamedCount {
	readonly id: string;
	readonly name: string;
	readonly count: number;
}

/**
 * The goods a store holds, named and in production order; a good with no name here keeps its id
 * as its name and comes last, so content added before its copy still shows.
 */
export function listGoods(goods: Readonly<Record<string, number>>): readonly NamedCount[] {
	return Object.entries(goods)
		.map(([id, count]) => ({ id, name: goodNames.get(id) ?? id, count }))
		.sort((a, b) => rank(a.id) - rank(b.id));
}

function rank(id: string): number {
	const index = goodOrder.indexOf(id);
	return index === -1 ? goodOrder.length : index;
}
