// Canonical JSON for the state hash (ADR-0003, sections 6 and 10): object keys sorted at every
// level by UTF-16 code unit, and only plain JSON data accepted. JSON.stringify would silently turn
// NaN and Infinity into null, drop undefined, and serialize a Date or Map as something else, so
// two different states could hash the same; this throws instead.

/** The canonical JSON text of a plain JSON value. Throws on anything else. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`canonicalJson: ${value} is not a finite number`);
    return JSON.stringify(value); // -0 is written as 0
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    // The default sort compares UTF-16 code units, the same on every engine; never localeCompare.
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new Error(`canonicalJson: ${describe(value)} is not plain JSON data`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function describe(value: unknown): string {
  if (typeof value !== 'object' || value === null) return typeof value;
  const { constructor } = value as { constructor?: { name?: string } };
  return `an object of type ${constructor?.name ?? 'unknown'}`;
}
