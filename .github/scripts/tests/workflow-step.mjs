// Test helper: a workflow step's own `run: |` block, as the workflow has it, so a test can run the
// step's shell exactly. The block is the lines indented past the step's keys (10 spaces, a job's
// step), up to the first line that isn't. A step that isn't there throws. Used by the factory tests (#615, #646).
export const runBlock = (yml, name) => {
	const at = yml.indexOf(`name: ${name}`);
	const run = yml.indexOf("run: |\n", at);
	if (at < 0 || run < 0) throw new Error(`no step "${name}" with a run: | block`);
	const step = yml.slice(at);
	return step
		.slice(step.indexOf("run: |\n") + "run: |\n".length)
		.split("\n")
		.filter((l, i, all) =>
			all.slice(0, i + 1).every((x) => x === "" || x.startsWith(" ".repeat(10))),
		)
		.map((l) => l.slice(10))
		.join("\n");
};

// Test helper: the lines a fake gh ends with, after it has written its answer to "$out". Like the
// runner's gh (#668: review run 45890313722 on #661), it refuses an answer that holds an ESC byte
// unless the call passes --allow-escape-sequences, then prints the answer.
export const GH_ESCAPE_REFUSAL = `if grep -q $'\\x1b' "$out" && [[ " $* " != *" --allow-escape-sequences "* ]]; then
  echo "the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway" >&2
  exit 1
fi
cat "$out"
`;
