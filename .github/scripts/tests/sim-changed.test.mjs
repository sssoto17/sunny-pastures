import { afterEach, describe, expect, it } from "vitest";

import { makeRepo } from "./test-repo.mjs";

const SCRIPT = new URL("../sim-changed.mjs", import.meta.url).pathname;
// The command under the helper prints the variable it was given, or `unset`. The test run itself
// may have SIM_PROPERTY_RUNS set (1000 in `ci / test`), so the helper starts with it empty.
const PRINT_RUNS = [
	"node",
	"-e",
	'console.log("runs=" + (process.env.SIM_PROPERTY_RUNS || "unset"))',
];
const FILES = {
	"packages/sim/src/hash/index.ts": "export const a = 1;\n",
	"apps/web/src/page.ts": "export const b = 1;\n",
};

let repo;
afterEach(() => repo?.cleanup());

const runHelper = (args = ["SIM_PROPERTY_RUNS=1000", "--", ...PRINT_RUNS]) =>
	repo.run(SCRIPT, args, { SIM_PROPERTY_RUNS: "" });

describe("sim-changed", () => {
	it("adds the variables when a commit on the branch changes packages/sim", () => {
		repo = makeRepo(FILES);
		repo.write({ "packages/sim/src/hash/index.ts": "export const a = 2;\n" });
		repo.commit();

		const { code, out } = runHelper();

		expect(code).toBe(0);
		expect(out).toContain("runs=1000");
	});

	it("adds the variables for an untracked file under packages/sim", () => {
		repo = makeRepo(FILES);
		repo.write({ "packages/sim/src/hash/extra.ts": "export const c = 1;\n" });

		expect(runHelper().out).toContain("runs=1000");
	});

	it("adds the variables for a staged change under packages/sim", () => {
		repo = makeRepo(FILES);
		repo.write({ "packages/sim/src/hash/index.ts": "export const a = 3;\n" });
		repo.git("add", "packages/sim/src/hash/index.ts");

		expect(runHelper().out).toContain("runs=1000");
	});

	it("runs the command without them when only files outside packages/sim change", () => {
		repo = makeRepo(FILES);
		repo.write({ "apps/web/src/page.ts": "export const b = 2;\n" });
		repo.commit();
		repo.write({ "apps/web/src/other.ts": "export const d = 1;\n" });

		const { code, out } = runHelper();

		expect(code).toBe(0);
		expect(out).toContain("runs=unset");
	});

	it("ignores a sim change that is on the base but not on the branch", () => {
		repo = makeRepo(FILES);
		repo.git("switch", "-q", "main");
		repo.write({ "packages/sim/src/hash/index.ts": "export const a = 4;\n" });
		repo.git("commit", "-qam", "main moves on");
		repo.git("switch", "-q", "work");

		expect(runHelper().out).toContain("runs=unset");
	});

	it("exits with the command's own status", () => {
		repo = makeRepo(FILES);

		const { code } = runHelper(["SIM_PROPERTY_RUNS=1000", "--", "node", "-e", "process.exit(3)"]);

		expect(code).toBe(3);
	});

	it("exits 2 without running the command when the base can't be read", () => {
		repo = makeRepo(FILES);

		const { code, out } = runHelper([
			"--base",
			"no-such-ref",
			"SIM_PROPERTY_RUNS=1000",
			"--",
			...PRINT_RUNS,
		]);

		expect(code).toBe(2);
		expect(out).not.toContain("runs=");
	});

	it.each([
		[["SIM_PROPERTY_RUNS=1000", ...PRINT_RUNS]],
		[["SIM_PROPERTY_RUNS=1000", "--"]],
		[["sim_property_runs", "--", ...PRINT_RUNS]],
	])("exits 2 on arguments it can't read: %j", (args) => {
		repo = makeRepo(FILES);

		expect(runHelper(args).code).toBe(2);
	});
});
