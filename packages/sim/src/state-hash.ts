import { canonicalJson } from './canonical-json.js';
import { sha256Hex } from './sha256.js';

/**
 * The state hash (ADR-0003, section 6, MUST-10.5): SHA-256 over the UTF-8 bytes of the value's
 * canonical JSON, as 64 lowercase hex digits. The same for every content and on every engine.
 * Throws on a value that isn't plain JSON data, such as NaN or a Map.
 */
export function stateHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
