// State invariants the property tests check on every generated state (ADR-0003, section 9).

/**
 * D16 (ADR-0003, section 10): every number in the state is a safe integer, and not -0. Throws on
 * the first number that isn't, naming its path (for example `$.plots[1].grownAt`).
 */
export function assertSafeIntegers(value: unknown): void {
  check(value, '$');
}

function check(value: unknown, path: string): void {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`${path} is ${String(value)}, not a safe integer`);
    // -0 is a safe integer to JavaScript, but a JSON round trip turns it into 0, so a state holding
    // it wouldn't survive a snapshot unchanged (ADR-0003, section 9).
    if (Object.is(value, -0)) throw new Error(`${path} is -0, not a safe integer for the state`);
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => {
      check(item, `${path}[${String(i)}]`);
    });
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) check(item, `${path}.${key}`);
  }
}
