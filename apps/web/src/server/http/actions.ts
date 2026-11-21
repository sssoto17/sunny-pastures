import type { Action, AddOn } from "@sunny-pastures/sim";

/** A parsed JSON object. */
export type JsonObject = Readonly<Record<string, unknown>>;

/**
 * Reads one sim action from parsed JSON, or null when it matches no variant's shape (#330,
 * "Request"). Shape only: a known `type`, exactly the variant's fields, whole numbers and short
 * strings. What they mean (does the crop exist, is the plot free) is the sim's, as a 422.
 */
export function readAction(value: unknown): Action | null {
	if (!isJsonObject(value)) return null;

	const { type } = value;
	return isActionType(type) ? guards[type](value) : null;
}

/** A safe integer of 0 or more, and not -0, which the sim's state never holds (ADR-0003, D16). */
export function isWholeNumber(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0 && !Object.is(value, -0);
}

export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `value` has exactly `keys` as its own keys: no key missing, none extra (T1, T2). */
export function hasExactKeys(value: JsonObject, keys: readonly string[]): boolean {
	const own = Object.keys(value);
	return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

// Ids in content are short words; a longer string is no id and only costs memory (T8). A control
// character or a lone surrogate is no id either, and Postgres refuses `\u0000` in text and jsonb,
// so one that reached a sim reason or a stored row would end in a 500 (T8: never a 500).
const maxStringLength = 64;
const controlCharacter = /\p{Cc}/u;

/** `whole`: a whole number (an index or a tier). `id`: a content id. `addOn`: an add-on's id. */
type Field = "whole" | "id" | "addOn";

type FieldValue<F extends Field> = F extends "whole" ? number : F extends "addOn" ? AddOn : string;

type Guard<T extends Action["type"]> = (value: JsonObject) => Extract<Action, { type: T }> | null;

// One guard per variant, keyed by `type` (#330): the `satisfies` fails the build when the sim adds
// a variant without a guard here, or a guard returns the wrong variant.
const guards = {
	plant: guard("plant", { plot: "whole", crop: "id" }),
	harvest: guard("harvest", { plot: "whole" }),
	buyPlot: guard("buyPlot", { plot: "whole" }),
	buyFacility: guard("buyFacility", { facility: "whole" }),
	startJob: guard("startJob", { facility: "whole", recipe: "id" }),
	collect: guard("collect", { facility: "whole" }),
	buyAddOn: guard("buyAddOn", { facility: "whole", addOn: "addOn" }),
	buyTier: guard("buyTier", { facility: "whole", tier: "whole" }),
	buyPen: guard("buyPen", { pen: "whole" }),
	feed: guard("feed", { pen: "whole" }),
	collectProducts: guard("collectProducts", { pen: "whole" }),
	deliver: guard("deliver", { slot: "whole" }),
	discard: guard("discard", { slot: "whole" }),
} as const satisfies { readonly [T in Action["type"]]: Guard<T> };

// Object.hasOwn, not `in`, so `toString` or `__proto__` is no action type.
function isActionType(type: unknown): type is Action["type"] {
	return typeof type === "string" && Object.hasOwn(guards, type);
}

function guard<const T extends Action["type"], const S extends Readonly<Record<string, Field>>>(
	type: T,
	shape: S,
) {
	const keys = ["type", ...Object.keys(shape)];
	return (value: JsonObject) => {
		if (value["type"] !== type || !hasExactKeys(value, keys)) return null;

		for (const [key, field] of Object.entries(shape)) {
			if (!isField(value[key], field)) return null;
		}

		// Every key was checked above, so the object is the variant as parsed.
		return value as { readonly type: T } & { readonly [K in keyof S]: FieldValue<S[K]> };
	};
}

// An add-on is checked as a string, like any id: the sim refuses one it doesn't know ("There is
// no add-on …", a 422), so the guard stays shape only (#330).
function isField(value: unknown, field: Field): boolean {
	if (field === "whole") return isWholeNumber(value);

	return (
		typeof value === "string" &&
		value.length <= maxStringLength &&
		value.isWellFormed() &&
		!controlCharacter.test(value)
	);
}
