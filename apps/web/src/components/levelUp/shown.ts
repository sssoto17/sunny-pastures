// The Level the player last saw the dialog for (#607), kept in `localStorage` so a reload doesn't
// show the same level-up twice and a Level reached while away shows on return. The browser may
// block storage (a private window, cleared site data); then reading finds nothing and writing
// keeps nothing, and the hook falls back to its own memory for the visit.

const key = "sunny-pastures:level-shown";

/** The stored Level, from 1; null when none is stored, it isn't a Level, or storage is blocked. */
export function readShownLevel(): number | null {
	try {
		const level = Number(localStorage.getItem(key) ?? Number.NaN);
		return Number.isSafeInteger(level) && level >= 1 ? level : null;
	} catch (error) {
		if (!(error instanceof DOMException)) throw error;

		return null;
	}
}

/** Stores `level`; a browser that blocks storage keeps nothing. */
export function writeShownLevel(level: number): void {
	try {
		localStorage.setItem(key, String(level));
	} catch (error) {
		if (!(error instanceof DOMException)) throw error;
	}
}
