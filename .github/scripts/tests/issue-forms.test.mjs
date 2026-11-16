import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #254: each issue form sets the native issue type its type label maps to, read from the mapping
// the issue scripts share (scripts/lib/issue-types.sh, #266), so a rename of the repo's types that
// updates the mapping but not the forms goes red here, in `ci / test`.
const FORMS = fileURLToPath(new URL("../../ISSUE_TEMPLATE/", import.meta.url));
const MAPPING = fileURLToPath(new URL("../../../scripts/lib/issue-types.sh", import.meta.url));

// The mapping as the scripts see it: each type label in TYPE_LABELS, a tab, its native type.
function mapping() {
	const res = spawnSync(
		"bash",
		[
			"-c",
			'source "$1"; for l in "${TYPE_LABELS[@]}"; do printf "%s\\t%s\\n" "$l" "$(native_type "$l")"; done',
			"_",
			MAPPING,
		],
		{ encoding: "utf8" },
	);
	if (res.status !== 0) throw new Error(`sourcing ${MAPPING} failed: ${res.stderr}`);
	return new Map(
		res.stdout
			.trim()
			.split("\n")
			.map((line) => line.split("\t")),
	);
}

// A form's top-level `key: value` lines (unindented), enough for name, labels and type. It reads
// plain scalars and flow lists only, as the forms use: a quoted value, an inline comment or a block
// list reads differently and turns the test red, never green.
function topLevel(file) {
	const keys = new Map();
	for (const line of readFileSync(`${FORMS}${file}`, "utf8").split("\n")) {
		const m = /^([a-z_]+):\s*(.*)$/.exec(line);
		if (m) keys.set(m[1], m[2].trim());
	}
	return keys;
}

const types = mapping();
// Each form as [file, the type label it's named after].
const forms = readdirSync(FORMS)
	.filter((f) => f.endsWith(".yml") && f !== "config.yml")
	.map((f) => [f, f.replace(/\.yml$/, "")]);

describe("issue forms", () => {
	it("has one form per type label, named after the label", () => {
		expect(forms.map(([, label]) => label).sort()).toEqual([...types.keys()].sort());
	});

	it.each(forms)("%s sets the native type its label maps to", (file, label) => {
		const want = types.get(label);
		expect(want, `scripts/lib/issue-types.sh maps no native type to ${label}`).toBeTruthy();
		expect(topLevel(file).get("type")).toBe(want);
	});

	it.each(forms)("%s still adds its type label and triage", (file, label) => {
		expect(topLevel(file).get("labels")).toBe(`[${label}, triage]`);
	});
});
