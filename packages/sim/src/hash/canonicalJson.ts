// Canonical JSON for the state hash (ADR-0003, sections 6 and 10): object keys sorted at every
// level by UTF-16 code unit, and only plain JSON data accepted. JSON.stringify would silently turn
// NaN and Infinity into null, drop undefined, symbol keys and non-enumerable properties, call
// getters, and serialize a Date or Map as something else, so two different states could hash the
// same; this throws instead.

/** The canonical JSON text of a plain JSON value. Throws on anything else. */
export function canonicalJson(value: unknown): string {
	return write(value, new Set());
}

/** `ancestors` holds the arrays and objects on the path to `value`, to find a cycle. */
function write(value: unknown, ancestors: Set<object>): string {
	if (value === null || typeof value === "boolean" || typeof value === "string") {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error(`canonicalJson: ${String(value)} is not a finite number`);
		}
		return JSON.stringify(value); // -0 is written as 0
	}
	if (!Array.isArray(value) && !isPlainObject(value)) throw notPlain(typeName(value));
	if (ancestors.has(value)) throw notPlain("a cycle");
	if (Object.getOwnPropertySymbols(value).length > 0) throw notPlain("a symbol key");
	ancestors.add(value);
	let text: string;
	if (Array.isArray(value)) {
		// Own names are the indexes plus `length`; anything more is a property JSON would drop.
		if (Object.getOwnPropertyNames(value).length !== value.length + 1) {
			throw notPlain("an array with properties other than its items");
		}
		const items = Array.from({ length: value.length }, (_, i) =>
			write(dataValue(value, String(i)), ancestors),
		);
		text = `[${items.join(",")}]`;
	} else {
		// The default sort compares UTF-16 code units, the same on every engine; never localeCompare.
		const keys = Object.keys(value).sort();
		if (Object.getOwnPropertyNames(value).length !== keys.length) {
			throw notPlain("a non-enumerable property");
		}
		text = `{${keys.map((key) => `${JSON.stringify(key)}:${write(dataValue(value, key), ancestors)}`).join(",")}}`;
	}
	ancestors.delete(value);
	return text;
}

/** The value stored at `key`, read without calling a getter. */
function dataValue(owner: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(owner, key);
	if (descriptor === undefined) throw notPlain("a sparse array"); // only a hole has no descriptor
	if (!("value" in descriptor)) throw notPlain(`a getter or setter at key ${JSON.stringify(key)}`);
	return descriptor.value;
}

function notPlain(what: string): Error {
	return new Error(`canonicalJson: ${what} is not plain JSON data`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const proto: unknown = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function typeName(value: unknown): string {
	if (typeof value !== "object" || value === null) return typeof value;
	const { constructor } = value as { constructor?: { name?: string } };
	return `an object of type ${constructor?.name ?? "unknown"}`;
}
