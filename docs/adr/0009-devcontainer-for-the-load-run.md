---
status: accepted
---

# A devcontainer for the load run

Production is Vercel plus Supabase (MUST-17), and Vercel doesn't run our container. The question in
#39 was whether the app should be containerised anyway, and for what: an image of the build that
ships for the M3 load test, or Postgres as a CI service container. This ADR records the answer: no
app container anywhere, and a **devcontainer for the load run only**.

## How this was decided

Grilled with the admin on 22 Nov 2026 in
[Design: a container for the load test and CI](https://github.com/sssoto17/sunny-pastures/issues/39);
its
[resolution comment](https://github.com/sssoto17/sunny-pastures/issues/39#issuecomment-7081566212)
is the source for every choice and reason below. #501 builds it. The "coordinate with #33" criterion
of #39 is moot: #33 is closed, and MUST-13.8 to 13.10 are unchanged by this.

## 1. No app container

- **Production stays Vercel-only (MUST-17).**
- **CI keeps the `supabase-stack` action (#382)**, which already runs the Supabase CLI stack in
  Docker on the runner.
- **No Next.js `standalone` image** for the load test either: it matches neither Vercel nor CI.

## 2. A devcontainer for the load VM

The M3 load run (#388) runs `next start`, Locust and the Supabase stack inside
`.devcontainer/devcontainer.json` on the cloud VM, started with `pnpm exec devcontainer up`. Cloud
sessions can run Docker; the spike's VM (ADR-0001, "Method") only skipped it to stay lean.

**Scope: the load VM only**, said in a header comment in `devcontainer.json`. Development use (WSL,
Codespaces for readers) would move Claude Code's sandbox, hooks and credentials into a container. It
is parked as an `idea` in Backlog (#502), picked up if ADR-0002's examiner trigger fires.

## 3. Docker: `docker-outside-of-docker` with host networking

- The devcontainer reaches the host's Docker through the `docker-outside-of-docker` Feature, and
  `runArgs: ["--network=host"]` puts it on the host's network.
- The Supabase containers run beside the devcontainer, one layer deep as on the laptop and in CI,
  and the app and Locust reach them on `localhost`.
- **Postgres runs in a container**, where the spike ran it natively. The load results (ADR-0007,
  "Load and concurrency") record this as a method difference from ADR-0001's spike.

## 4. The image and its tools

- **Base:** Docker's official `node:24-bookworm`, pinned by digest, with the tag and the date it was
  checked against the 7-day rule in a comment (`CONSTRAINTS.md`, "Tools are dependencies": container
  images are checked by hand). The digest and the date are to be settled in #501.
- **One Feature:** `docker-outside-of-docker`, at an exact version. The version is to be settled in
  #501.
- **Tools from their existing pins:** the Supabase CLI and uv install in `postCreateCommand` from
  their pinned releases with hash checks, taking the versions from where they are already pinned,
  not a second copy; `pnpm supabase:check` verifies the CLI. Node (`.nvmrc`) and pnpm
  (`packageManager`, Corepack) stay pinned where they are.

## 5. The CLI: `@devcontainers/cli` as a devDependency

`@devcontainers/cli` is an exact-pinned root devDependency (admin-approved, 22 Nov), so
`pnpm exec devcontainer up` runs after a frozen install under the lockfile and `minimumReleaseAge`.
Its install scripts are checked before it is added; if it has any, they stay disallowed and go to
the admin. The version is to be settled in #501.

## 6. The CI check

A job runs `devcontainer build` only on PRs that change `.devcontainer/**`. It is **not required**
on `main`: a path-filtered required check would leave other PRs waiting. The job's name and the
workflow it lives in are to be settled in #501.

## Not chosen

<!-- prettier-ignore -->
| Alternative | Why not |
| --- | --- |
| A production image | Vercel is the only deploy path (MUST-17) and doesn't run our container, so a production Dockerfile would be a second deploy path that nobody uses. |
| A Next.js `standalone` image for the load test | It matches neither Vercel nor CI, so it isn't "the same build that ships" either. |
| A Postgres service container in CI | It would lack Auth, which anonymous sign-up needs, and it duplicates the `supabase-stack` action (#382), which already runs the whole stack in Docker on the runner. |
| `docker-in-docker` | `--privileged`, nested overlay storage and a nested bridge would add I/O and latency to the `load` and `commit` phases that MUST-13.8 judges. |
| A hand-written VM setup script | What the spike's VM did (ADR-0001, "Method"). It pins nothing a reader can rebuild: the devcontainer's base is pinned by digest, its tools come from their existing pins, and CI builds it whenever it changes (section 6). |
| Microsoft's `devcontainers/typescript-node` image | A bigger second publisher for extras the load run doesn't need. |
| `pnpm dlx` for the CLI | No lockfile integrity, no 7-day rule. |
| A devcontainer for development as well | It would move Claude Code's sandbox, hooks and credentials into a container. Parked as #502, behind ADR-0002's examiner trigger. |

## Patterns

<!-- prettier-ignore -->
| Pattern | Where | Why |
| --- | --- | --- |
| A reproducible build environment per the [dev container spec](https://containers.dev/), used as a test harness, not a deployment unit | `.devcontainer/devcontainer.json` on the load VM | The load run gets a pinned, rebuildable toolchain, while production keeps one deploy path (Vercel). |
| Sidecar containers on a shared host network | `docker-outside-of-docker` with `--network=host`; the Supabase containers beside the devcontainer | One Docker layer, as on the laptop and in CI, so the measured phases carry no nested I/O or network. |
| Pin by content, not by name | the image by digest, the Feature and the CLI at exact versions, tools with hash checks | A rebuild gets the same bytes, and the 7-day rule applies to every piece. |

## Consequences

- **#501 builds it:** `.devcontainer/devcontainer.json` with the header comment, the Feature and
  `runArgs`, the `postCreateCommand`, `@devcontainers/cli` in the root `package.json`, and the
  path-filtered CI job. `package.json` and `.github/` are code-owned, so its PR carries
  `review:admin`.
- **The M3 load run (#388) happens inside the devcontainer** (ADR-0007, "Load and concurrency"), and
  its results record Postgres-in-a-container as a method difference from ADR-0001's spike.
- **ADR-0002** points its "A container for the load test and CI" and "Codespaces / dev container"
  rows here; the latter keeps its examiner trigger for development use (#502).
