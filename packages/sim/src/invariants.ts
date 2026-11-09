// State invariants the property tests check on every generated state (ADR-0003, section 9).

/**
 * D16 (ADR-0003, section 10): every number in the state is a safe integer. Throws on the first
 * number that isn't, naming its path (for example `$.plots[1].grownAt`).
 */
export function assertSafeIntegers(value: unknown): void {
  check(value, '$');
}

function check(value: unknown, path: string): void {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`${path} is ${value}, not a safe integer`);
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => check(item, `${path}[${i}]`));
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) check(item, `${path}.${key}`);
  }
}
