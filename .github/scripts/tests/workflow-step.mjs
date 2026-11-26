// Test helper: a workflow step's own `run: |` block, as the workflow has it, so a test can run the
// step's shell exactly. The block is the lines indented past the step's keys (10 spaces, a job's
// step), up to the first line that isn't. Used by the factory tests (#615, #646).
export const runBlock = (yml, name) => {
	const step = yml.slice(yml.indexOf(`name: ${name}`));
	return step
		.slice(step.indexOf("run: |\n") + "run: |\n".length)
		.split("\n")
		.filter((l, i, all) =>
			all.slice(0, i + 1).every((x) => x === "" || x.startsWith(" ".repeat(10))),
		)
		.map((l) => l.slice(10))
		.join("\n");
};
