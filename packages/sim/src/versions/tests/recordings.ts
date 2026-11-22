// The recorded logs of every released rules version (ADR-0006, section 10), one file per version
// beside this one. Written by `node .github/scripts/record-rules-version.mjs <version>` when the version is
// released, never edited by hand: the rules-version check replays each one on today's code.
import type { Recording } from "./record.js";

export const recordings: readonly Recording[] = [];
