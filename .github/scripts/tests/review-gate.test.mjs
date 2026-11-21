import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../review-gate.sh", import.meta.url));

// A review as review.yml's gather step writes it to reviews.json.
const review = (
	state,
	{ body = "summary", commit = "abc", author = "sunny-reviewer[bot]" } = {},
) => ({
	id: 1,
	author,
	state,
	submitted_at: "2026-11-16T10:00:00Z",
	body,
	commit_id: commit,
});

let dir;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

// ADMIN marks a PR that carries review:admin, as gather's pr.json lists its labels.
const ADMIN = { labels: ["review:admin"] };
// Part 2 of a native stack: based on part 1's branch, with the live `stack` GET pulls/<n> gives.
const PART2 = {
	base: "lane-part1",
	stack: { number: 9, position: 2, size: 2, base: { ref: "main" } },
};

function gate(
	action,
	reviews,
	{ labels = [], files = {}, base = "main", stack = null, baseFiles } = {},
) {
	dir = mkdtempSync(join(tmpdir(), "review-gate-"));
	writeFileSync(join(dir, "reviews.json"), JSON.stringify(reviews));
	writeFileSync(join(dir, "pr.json"), JSON.stringify({ head_sha: "abc", base, stack, labels }));
	if (baseFiles) writeFileSync(join(dir, "base-files.json"), JSON.stringify(baseFiles));
	writeFileSync(join(dir, "out"), "");
	const res = spawnSync("bash", [SCRIPT], {
		cwd: dir,
		encoding: "utf8",
		env: {
			PATH: process.env.PATH,
			ACTION: action,
			BOT: "sunny-reviewer",
			ADMIN: "sssoto17",
			DEFAULT_BRANCH: "main",
			PR_JSON: join(dir, files.pr ?? "pr.json"),
			REVIEWS: join(dir, files.reviews ?? "reviews.json"),
			BASE_FILES: join(dir, files.baseFiles ?? "base-files.json"),
			GITHUB_OUTPUT: join(dir, "out"),
		},
	});
	return {
		code: res.status,
		out: res.stdout + res.stderr,
		run: readFileSync(join(dir, "out"), "utf8").match(/^run=(.*)$/m)?.[1],
	};
}

describe("review-gate.sh", () => {
	it.each(["synchronize", "reopened", "ready_for_review", "opened"])(
		"skips a %s run on a head the App already reviewed",
		(action) => {
			const g = gate(action, [review("COMMENTED")]);
			expect(g.code).toBe(0);
			expect(g.run).toBe("false");
			expect(g.out).toContain("GATE skip");
		},
	);

	// Each line or file comment post-review.sh posts is its own COMMENTED review with an empty
	// body (PR #280: two reviews at 2a46ae8, 2 s apart). Only the summary review ends a run.
	it.each([
		["no review yet", []],
		[
			"only an empty-body comment review: the run died before its summary",
			[review("COMMENTED", { body: "" })],
		],
		["a review of an older head", [review("APPROVED", { commit: "old" })]],
		["another writer's approval of this head", [review("APPROVED", { author: "a-writer" })]],
		[
			"the admin's approval of an older head",
			[review("APPROVED", { author: "sssoto17", commit: "old" })],
		],
		[
			"only the App's Request changes on this head, with no summary",
			[review("CHANGES_REQUESTED", { body: "" })],
		],
		["another App's review of this head", [review("COMMENTED", { author: "sunny-factory[bot]" })]],
	])("reviews a head after %s", (_name, reviews) => {
		const g = gate("synchronize", reviews);
		expect(g.code).toBe(0);
		expect(g.run).toBe("true");
	});

	// ADR-0002 test (e): review:admin added after an approval re-runs the review, which dismisses
	// the approval and turns auto-merge off. The job's `if:` lets through only that label, added
	// by someone other than the App.
	it("reviews a reviewed head again when review:admin is added after its approval", () => {
		const g = gate("labeled", [review("COMMENTED", { body: "" }), review("APPROVED")], ADMIN);
		expect(g.run).toBe("true");
		expect(g.out).toContain("GATE run");
	});

	// cancel-in-progress: a reopened or ready_for_review at the same head cancels that labeled run
	// mid-way, so the run that replaces it must withdraw the approval in its place.
	it.each(["reopened", "ready_for_review", "synchronize"])(
		"still withdraws the approval on a %s run that cancelled the labeled one",
		(action) => {
			expect(gate(action, [review("APPROVED")], ADMIN).run).toBe("true");
		},
	);

	it("skips any other event after that approval while review:admin is off", () => {
		expect(gate("synchronize", [review("APPROVED")]).run).toBe("false");
		expect(gate("reopened", [review("APPROVED")]).run).toBe("false");
	});

	it.each([
		["a summary that already held the approval", [review("COMMENTED")]],
		["an approval already dismissed", [review("DISMISSED"), review("COMMENTED")]],
		["Request changes", [review("CHANGES_REQUESTED")]],
		["someone else's approval", [review("COMMENTED"), review("APPROVED", { author: "sssoto17" })]],
	])("skips review:admin added after %s: there is no approval to withdraw", (_name, reviews) => {
		expect(gate("labeled", reviews, ADMIN).run).toBe("false");
	});

	it("reviews an unreviewed head whatever the event", () => {
		expect(gate("labeled", [], ADMIN).run).toBe("true");
	});

	// #404: a head somebody who counts has approved needs no review. The admin's approval or the
	// App's own, on this very head; a dismissed approval reads DISMISSED and doesn't count.
	it.each(["synchronize", "ready_for_review", "opened", "reopened"])(
		"skips a %s run on a head the admin approved",
		(action) => {
			const g = gate(action, [review("APPROVED", { author: "sssoto17", body: "" })]);
			expect(g.code).toBe(0);
			expect(g.run).toBe("false");
			expect(g.out).toContain("GATE skip: approved");
		},
	);

	it("skips a head the App approved, even with an empty body", () => {
		const g = gate("synchronize", [review("APPROVED", { body: "" })]);
		expect(g.run).toBe("false");
		expect(g.out).toContain("GATE skip: approved");
	});

	it("reviews a head whose approval was dismissed", () => {
		expect(gate("synchronize", [review("DISMISSED", { author: "sssoto17", body: "" })]).run).toBe(
			"true",
		);
	});

	it.each([
		["the admin", "sssoto17"],
		["the App", "sunny-reviewer[bot]"],
	])("reviews a new push after %s approved the head before it", (_who, author) => {
		const g = gate("synchronize", [
			review("COMMENTED", { commit: "old" }),
			review("APPROVED", { author, commit: "old" }),
		]);
		expect(g.run).toBe("true");
		expect(g.out).toContain("GATE run");
	});

	// Test (e) still wins over the admin's approval: the App's own approval must be withdrawn.
	it("still withdraws the App's approval under review:admin when the admin approved the head too", () => {
		const reviews = [
			review("APPROVED", { commit: "old" }),
			review("APPROVED", { author: "sssoto17" }),
		];
		expect(gate("labeled", reviews, ADMIN).run).toBe("true");
	});

	// #404 (admin, 21 Nov 2026): a part of a native stack is reviewed whatever its base. A PR on
	// another base outside a stack is the hand-chained PR `guard / stack-base` refuses: no review.
	describe("stacked parts", () => {
		it.each(["ready_for_review", "synchronize", "opened"])(
			"reviews a %s run on part 2 of a native stack",
			(action) => {
				const g = gate(action, [], { ...PART2, baseFiles: ["src/a.ts"] });
				expect(g.code).toBe(0);
				expect(g.run).toBe("true");
				expect(g.out).toContain("GATE run");
			},
		);

		it("skips a stacked part's head already reviewed or approved, as on main", () => {
			expect(gate("synchronize", [review("COMMENTED")], { ...PART2, baseFiles: [] }).run).toBe(
				"false",
			);
			const byAdmin = [review("APPROVED", { author: "sssoto17" })];
			expect(gate("synchronize", byAdmin, { ...PART2, baseFiles: [] }).run).toBe("false");
		});

		// #468's review: `gh api` cuts a URL at `#`, and post-review.sh reads origin/<base> by
		// name, so a base outside git's plainest characters gets no review.
		it.each(["main#x", "part1?x", "part 1", "part1;x"])(
			"skips a stacked part on the odd base name %s",
			(base) => {
				const g = gate("synchronize", [], { ...PART2, base, baseFiles: [] });
				expect(g.code).toBe(0);
				expect(g.run).toBe("false");
				expect(g.out).toContain("GATE skip: odd base name");
				expect(g.out).not.toContain(base);
			},
		);

		it("skips a hand-chained PR: based on another branch, in no stack", () => {
			const g = gate("synchronize", [], { base: "lane-part1", stack: null, baseFiles: [] });
			expect(g.code).toBe(0);
			expect(g.run).toBe("false");
			expect(g.out).toContain("GATE skip: hand-chained");
		});

		// claude-code-action restores .claude/, CLAUDE.md, .mcp.json and the like from
		// origin/<base.ref> before Claude starts (restore-config.ts at the pinned SHA). On a part
		// above 1 that's the part below's branch, which nobody has merged yet.
		it.each([
			".claude/settings.json",
			".claude",
			"CLAUDE.md",
			"CLAUDE.local.md",
			".mcp.json",
			".claude.json",
			".gitmodules",
			".ripgreprc",
			".husky/pre-commit",
		])("skips a part whose stack below changes %s, which the action would restore", (path) => {
			const g = gate("synchronize", [], { ...PART2, baseFiles: ["src/a.ts", path] });
			expect(g.code).toBe(0);
			expect(g.run).toBe("false");
			expect(g.out).toContain("GATE skip: restored config");
		});

		it.each(["docs/CLAUDE.md", ".claude-pr/x", "apps/.claude/x", ".mcp.jsonc"])(
			"still reviews a part whose stack below changes only %s",
			(path) => {
				expect(gate("synchronize", [], { ...PART2, baseFiles: [path] }).run).toBe("true");
			},
		);

		it("skips a part whose stack below may hold more files than the compare lists", () => {
			const many = Array.from({ length: 300 }, (_, i) => `src/f${i}.ts`);
			const g = gate("synchronize", [], { ...PART2, baseFiles: many });
			expect(g.run).toBe("false");
			expect(g.out).toContain("GATE skip: restored config");
		});

		it("fails, rather than guess, when a stacked part's base files can't be read", () => {
			const g = gate("synchronize", [], PART2);
			expect(g.code).not.toBe(0);
			expect(g.run).toBeUndefined();
		});

		it("never reads the base files for a PR on main", () => {
			expect(gate("synchronize", []).run).toBe("true");
		});
	});

	it.each(["reviews", "pr"])("fails, rather than guess, when %s can't be read", (which) => {
		const g = gate("synchronize", [], { files: { [which]: "missing.json" } });
		expect(g.code).not.toBe(0);
		expect(g.run).toBeUndefined();
	});
});
// The gate saves money only if review.yml asks it before Claude runs, from the reviews with their
// commit_id. The workflow runs from main on pull_request_target, so a PR can't prove this live.
describe("review.yml", () => {
	const yml = readFileSync(
		fileURLToPath(new URL("../../workflows/review.yml", import.meta.url)),
		"utf8",
	);
	const at = (s) => {
		const i = yml.indexOf(s);
		expect(i, s).toBeGreaterThan(-1);
		return i;
	};

	it("asks the gate in gather, before the diff, the threads and Claude", () => {
		const gate = at("bash .github/scripts/review-gate.sh");
		expect(at('"$CTX/pr.json"')).toBeLessThan(gate);
		expect(at("submitted_at, body, commit_id}")).toBeLessThan(gate);
		expect(at("if grep -qx 'run=false' \"$GITHUB_OUTPUT\"; then exit 0; fi")).toBeGreaterThan(gate);
		expect(at("gh pr diff")).toBeGreaterThan(gate);
		expect(at("gh api graphql")).toBeGreaterThan(gate);
		expect(at("- id: claude\n        if: steps.gather.outputs.run == 'true'\n")).toBeGreaterThan(
			gate,
		);
	});

	// #404: the trigger takes every base, and the gate decides which. Main's copy and main's
	// checkout still run, whatever the base (the header quotes GitHub's docs).
	describe("every base (#404)", () => {
		const trigger = yml.slice(at("on:\n  pull_request_target:\n"), at("\npermissions: {}"));
		const gather = yml.slice(at("- id: gather\n"), at("- name: Install the review skill"));

		it("has no branches filter on pull_request_target", () => {
			expect(trigger).not.toMatch(/^\s*branches(-ignore)?:/m);
		});

		it("still runs on pull_request_target only, never on pull_request", () => {
			expect(yml).not.toMatch(/^\s+pull_request:/m);
			expect(yml).not.toMatch(/^\s+(push|workflow_run|issue_comment):/m);
		});

		// One checkout a job (#454), each of main: no `ref`, no other repository.
		it("never checks out anything but the default branch", () => {
			const checkouts = yml.match(/uses: actions\/checkout@[^\n]*\n(\s+with:\n(\s{10}.*\n)*)?/g);
			expect(checkouts).toHaveLength(2);
			for (const c of checkouts) expect(c).not.toMatch(/\bref:|repository:/);
			expect(yml).not.toMatch(/pull_request\.head\.(sha|ref)|refs\/pull\//);
			expect(yml).not.toMatch(/gh pr checkout|git (fetch|checkout|switch)/);
		});

		it("stops when the run's ref isn't the default branch", () => {
			expect(gather).toContain('if [[ $GITHUB_REF != "refs/heads/$DEFAULT_BRANCH" ]]; then');
			expect(gather.indexOf("GITHUB_REF")).toBeLessThan(gather.indexOf("gh api"));
		});

		it("hands the gate the PR's live stack, the base's files, the admin and the default branch", () => {
			expect(gather).toMatch(/head_sha: \.head\.sha, stack, labels/);
			expect(gather).toContain("ADMIN: ${{ github.repository_owner }}");
			expect(gather).toContain("DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}");
			// By the base's SHA, only for a base that isn't the default branch, with renames' old paths.
			expect(gather).toMatch(/base_sha: \.base\.sha, head_sha/);
			expect(gather).toContain(
				`base_sha=$(jq -er '.base_sha | select(test("^[0-9a-f]{40}$"))' "$CTX/pr.json")`,
			);
			expect(gather).toContain(
				'if [[ $base != "$DEFAULT_BRANCH" ]]; then\n            gh api "$r/compare/$DEFAULT_BRANCH...$base_sha" --jq \'[.files[]? | .filename,\n              (.previous_filename // empty)]\' >"$CTX/base-files.json"\n          fi\n',
			);
			expect(gather).not.toContain('...$base"');
			const compare = at('gh api "$r/compare/$DEFAULT_BRANCH...$base_sha"');
			expect(compare).toBeLessThan(at("bash .github/scripts/review-gate.sh"));
			expect(gather).toContain("BASE_FILES=$CTX/base-files.json");
		});

		it("tells post-review.sh the default branch and the base the gate read", () => {
			const post = yml.slice(at("\n  post:\n"));
			expect(post).toContain("DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}");
			expect(post).toContain("BASE: ${{ needs.review.outputs.base }}");
			expect(post).toContain("BASE_SHA: ${{ needs.review.outputs.base_sha }}");
			expect(yml).toContain("base: ${{ steps.gather.outputs.base }}");
			expect(yml).toContain("base_sha: ${{ steps.gather.outputs.base_sha }}");
			expect(gather).toContain('echo "base=$base" >>"$GITHUB_OUTPUT"');
			expect(gather).toContain('echo "base_sha=$base_sha" >>"$GITHUB_OUTPUT"');
		});

		// Exactly one review of a head (#404): a draft never runs, the ready mark does, and a newer
		// run for the PR cancels the older one; the gate then skips the head a finished run reviewed.
		it("reviews a part on its ready mark, skips drafts and keeps one run per PR", () => {
			expect(trigger).toMatch(
				/types: \[opened, synchronize, reopened, ready_for_review, labeled\]/,
			);
			expect(yml).toContain("!github.event.pull_request.draft &&");
			expect(yml).toMatch(
				/concurrency:\n\s+group: review-\$\{\{ github\.event\.pull_request\.number \}\}\n\s+cancel-in-progress: true/,
			);
		});
	});

	it("keeps the allowed claude-code-action pin (#290)", () => {
		expect(yml).toContain("anthropics/claude-code-action@61a9c274fa7110a66dfafc1bbbced03833eb25fe");
	});

	// #68 (admin, 18 Nov 2026): the review runs the code-review-and-quality skill. A typed /skill
	// loads only a registered skill, and `--setting-sources user` registers ~/.claude/skills only,
	// so a step copies main's skill there before Claude runs. `project` stays out: it would load the
	// repo's .mcp.json (the action sets enableAllProjectMcpServers), hooks and allow rules.
	describe("the review skill", () => {
		const claudeArgs = yml.slice(at("claude_args: >-"), at("- id: handoff\n"));

		it("copies main's skill into the user's skills before Claude runs", () => {
			const step = at("- name: Install the review skill (main's copy)\n");
			expect(at("uses: actions/checkout@")).toBeLessThan(step);
			expect(step).toBeLessThan(at("- id: claude\n"));
		});

		// .claude/skills/code-review-and-quality is a symlink into .agents/skills/ (mode 120000): a
		// plain `cp -R` copies the link, which dangles under $HOME, and the skill never registers.
		it("leaves a real SKILL.md under $HOME, not a link", () => {
			const lines = yml.slice(at("- name: Install the review skill (main's copy)\n")).split("\n");
			const from = lines.findIndex((l) => l.trim() === "run: |") + 1;
			const end = lines.findIndex((l, i) => i >= from && l.trim() === "");
			const script = lines
				.slice(from, end)
				.map((l) => l.trim())
				.join("\n");
			const home = mkdtempSync(join(tmpdir(), "review-skill-"));
			try {
				const root = fileURLToPath(new URL("../../..", import.meta.url));
				const r = spawnSync("bash", ["-c", script], {
					cwd: root,
					env: { ...process.env, HOME: home },
					encoding: "utf8",
				});
				expect(r.status, r.stderr).toBe(0);
				const dir = join(home, ".claude/skills/code-review-and-quality");
				expect(lstatSync(dir).isSymbolicLink()).toBe(false);
				expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toMatch(
					/^---\nname: code-review-and-quality\n/,
				);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});

		it("invokes the skill as the prompt's first word", () => {
			expect(yml).toMatch(
				/prompt: >-\n\s+\/code-review-and-quality Read \.github\/review-prompt\.md/,
			);
		});

		it("still loads user settings only, with no MCP servers", () => {
			expect(claudeArgs).toContain("--setting-sources user\n");
			expect(claudeArgs).not.toMatch(/project|local|--mcp-config/);
		});

		it("still gives Claude Read, Grep and Glob only, Skill denied", () => {
			expect(claudeArgs).toContain('--allowedTools "Read,Grep,Glob"');
			const denied = claudeArgs.match(/--disallowedTools "([^"]*)"/)?.[1].split(",");
			expect(denied).toEqual(
				expect.arrayContaining(["Bash", "Edit", "Write", "WebFetch", "WebSearch", "Task", "Skill"]),
			);
		});

		it("proves in the Report step that the skill's text reached the model (#381)", () => {
			// In Claude's job (#454): the transcript and the execution file are on its runner only.
			const report = yml.slice(
				at("- name: Report"),
				at("\n  # Posts the verdict as sunny-reviewer"),
			);
			expect(report).toMatch(
				/node \.github\/scripts\/skill-proof\.mjs "\$f" "\$HOME\/\.claude\/projects" \\\s+code-review-and-quality '# Code Review and Quality' \|\| proof=\$\?/,
			);
			expect(report).toMatch(/exit "\$proof"\s*$/);
			// The line it counts is SKILL.md's own heading, so a renamed heading fails here first.
			const skill = readFileSync(
				fileURLToPath(
					new URL("../../../.claude/skills/code-review-and-quality/SKILL.md", import.meta.url),
				),
				"utf8",
			);
			expect(skill.split("\n")).toContain("# Code Review and Quality");
		});
	});

	// #454 (admin, 21 Nov 2026): Claude runs in `claude-seat`, which holds only the seat token, with
	// a read-only GITHUB_TOKEN, and never mints or holds the App's key. Only `post`, a fresh runner
	// in `review`, mints the App's token, after it has checked the hand-off.
	describe("two jobs, two environments (#454)", () => {
		// Code only: the comments name the other job's secrets to say they aren't there.
		const code = (text) =>
			text
				.split("\n")
				.filter((l) => !l.trim().startsWith("#"))
				.join("\n");
		const model = code(yml.slice(at("\n  review:\n"), at("\n  post:\n")));
		const post = code(yml.slice(at("\n  post:\n")));

		it("runs Claude in claude-seat and posts from review, each job once", () => {
			expect(yml.match(/^ {4}environment: .*$/gm)).toEqual([
				"    environment: claude-seat",
				"    environment: review",
			]);
			expect(model).toMatch(/^ {4}environment: claude-seat$/m);
			expect(post).toMatch(/^ {4}environment: review$/m);
			expect(model).toContain("uses: anthropics/claude-code-action@");
			expect(post).not.toContain("claude-code-action");
		});

		it("keeps the App's key and token out of Claude's job, and the seat token out of post", () => {
			expect(model).not.toMatch(
				/create-github-app-token|REVIEWER_APP_PRIVATE_KEY|app-slug|steps\.app\./,
			);
			expect(model).toContain("claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}");
			expect(post).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
			expect(post.match(/secrets\.\w+/g)).toEqual(["secrets.REVIEWER_APP_PRIVATE_KEY"]);
			expect(model.match(/secrets\.\w+/g)).toEqual(["secrets.CLAUDE_CODE_OAUTH_TOKEN"]);
			expect(yml.slice(0, at("\njobs:\n"))).not.toContain("secrets.");
		});

		it("gives both jobs a read-only GITHUB_TOKEN", () => {
			for (const job of [model, post]) {
				const perms = job.match(/\n {4}permissions:\n((?: {6}.*\n)+)/)?.[1];
				expect(perms).toBeDefined();
				const scopes = perms.split("\n").filter((l) => l.trim());
				expect(scopes.length).toBeGreaterThan(0);
				for (const l of scopes) expect(l).toMatch(/^ {6}[a-z-]+: read\b/);
			}
			expect(yml).toMatch(/^permissions: \{\}$/m);
		});

		it("hands off through job outputs, and post reads only those", () => {
			expect(model).toContain("verdict: ${{ steps.claude.outputs.structured_output }}");
			expect(model).toContain("head: ${{ steps.gather.outputs.head }}");
			expect(model).toContain("restored: ${{ steps.handoff.outputs.restored }}");
			expect(post).toContain("needs: review\n");
			expect(post).toContain("VERDICT: ${{ needs.review.outputs.verdict }}");
			expect(post).toContain("HEAD: ${{ needs.review.outputs.head }}");
			expect(post).toContain("RESTORED: ${{ needs.review.outputs.restored }}");
			expect(post).not.toMatch(/steps\.(claude|gather|handoff)\./);
		});

		// The race check (#404) compares the base the gate read with the one the action restored,
		// which only Claude's runner fetched: it is read there, by its full ref, after Claude.
		it("records the restored base on Claude's runner, by its full ref, after Claude", () => {
			const handoff = model.slice(model.indexOf("- id: handoff\n"));
			expect(model.indexOf("- id: claude\n")).toBeLessThan(model.indexOf("- id: handoff\n"));
			expect(handoff).toContain(
				'restored=$(git rev-parse --verify --quiet "refs/remotes/origin/$BASE^{commit}") || restored=none',
			);
			expect(handoff).toContain("BASE: ${{ steps.gather.outputs.base }}");
		});

		it("checks the hand-off before it mints the App's token, and posts after", () => {
			const check = post.indexOf("bash .github/scripts/post-review.sh --check");
			const files = post.indexOf('gh api --paginate "repos/$GITHUB_REPOSITORY/pulls/$PR/files');
			const mint = post.indexOf("uses: actions/create-github-app-token@");
			const write = post.indexOf("run: bash .github/scripts/post-review.sh\n");
			expect(post.indexOf("GH_TOKEN: ${{ github.token }}")).toBeGreaterThan(-1);
			expect(check).toBeGreaterThan(
				post.indexOf('if [[ $GITHUB_REF != "refs/heads/$DEFAULT_BRANCH" ]]'),
			);
			expect(files).toBeGreaterThan(check);
			expect(mint).toBeGreaterThan(files);
			expect(write).toBeGreaterThan(mint);
			expect(post.slice(write - 200, write)).toContain("GH_TOKEN: ${{ steps.app.outputs.token }}");
		});

		// A failed skill proof fails Claude's job but still posts; a cancelled run never posts, and
		// an older run's post never cancels a newer run's review.
		it("posts after a failed proof, never after a cancel, in a group of its own", () => {
			expect(post).toContain("if: ${{ !cancelled() && needs.review.outputs.verdict != '' }}");
			expect(post).toMatch(
				/concurrency:\n\s+group: review-post-\$\{\{ github\.event\.pull_request\.number \}\}\n\s+cancel-in-progress: false/,
			);
		});
	});
});
