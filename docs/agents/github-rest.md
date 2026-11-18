# GitHub over REST

Cloud lanes can't use GraphQL: Claude Code's cloud GitHub proxy refuses every GraphQL request with a
403, and every `gh issue`, `gh pr`, `gh label list` and `gh project` command goes through GraphQL.
So the tooling scripts call `gh api` over REST, one code path for local and cloud (#346). This page
is the inventory: every call that used GraphQL, and its REST equivalent or why there is none.

## What the cloud proxy allows

Checked from a cloud session on 18 Nov 2026:

- `repos/sssoto17/sunny-pastures/...` works, reads and writes.
- Any other path is refused with HTTP 403: "This GitHub API path is not available: sessions are
  bound to their configured repositories". That includes the REST Projects API
  (`users/sssoto17/projectsV2/3/...`), even though GitHub serves it over REST.
- `api.github.com/graphql` is refused with HTTP 403.

So the Project can't be read or written from a cloud lane at all. The scripts that need it do every
other part, name the step they skipped and the command that finishes it, and exit **4**
(`PROJECT_SKIPPED` in `scripts/lib/project-rest.sh`). Locally the same code reaches the Project over
REST.

## Sources

Every REST endpoint below is cited from GitHub's REST description, the OpenAPI file the REST
reference is built from: `github/rest-api-description`,
`descriptions/api.github.com/api.github.com.json`, version 1.1.4, read on 18 Nov 2026
(docs.github.com doesn't resolve from the cloud sessions; the file carries each operation's
reference link, quoted here). The "REST reference" column names the page and operation.

## The scripts

<!-- prettier-ignore -->
| Script | GraphQL call (before #346) | REST now | REST reference |
| --- | --- | --- | --- |
| `new-issue.sh` | `gh label list` | `GET repos/{o}/{r}/labels` (paginated) | Issues → Labels, "List labels for a repository" |
| `new-issue.sh` | `repository.issueTypes` | `GET repos/{o}/{r}/issue-types` | Repos → Issue types, "List issue types for a repository" |
| `new-issue.sh` | `gh issue create --label --milestone --parent` | `POST repos/{o}/{r}/issues` with `labels[]`, `milestone` (number) and `type` (name), then `POST repos/{o}/{r}/issues/{parent}/sub_issues` with `sub_issue_id` (the new issue's id) | Issues, "Create an issue"; Sub-issues, "Add sub-issue" |
| `issue-fields.sh` | lookup: issue, labels, `issueType`, `issueTypes` | `GET repos/{o}/{r}/issues/{n}`, `GET repos/{o}/{r}/issue-types` | Issues, "Get an issue"; "List issue types for a repository" |
| `issue-fields.sh` | lookup: `projectV2.fields`, the item's `fieldValues` | `GET users/{u}/projectsV2/{p}/fields`, `GET users/{u}/projectsV2/{p}/items?fields=<ids>` (paginated) | Projects → Fields, "List project fields for user"; Projects → Items, "List items for a user owned project" |
| `issue-fields.sh` | `gh project item-add` | `POST users/{u}/projectsV2/{p}/items` with `type: Issue`, `id` | Projects → Items, "Add item to user owned project" |
| `issue-fields.sh` | `gh project item-edit` (one per field) | `PATCH users/{u}/projectsV2/{p}/items/{item_id}` with `fields: [{id, value}]`, all fields in one call | Projects → Items, "Update project item for user" |
| `issue-fields.sh`, `backfill-issue-types.sh` | `updateIssue(issueTypeId)` | `PATCH repos/{o}/{r}/issues/{n}` with `type` (the type's name) | Issues, "Update an issue" |
| `issue-fields.sh` | `gh issue edit --remove-label triage` | `DELETE repos/{o}/{r}/issues/{n}/labels/triage` | Issues → Labels, "Remove a label from an issue" |
| `missing-fields.sh` | issues with `issueType`, labels, `projectItems.fieldValues` | `GET repos/{o}/{r}/issues?state=open` (paginated; PRs dropped), then the Project's fields and items as above | Issues, "List repository issues"; Projects, as above |
| `backfill-issue-types.sh` | `repository.issueTypes` | `GET repos/{o}/{r}/issue-types` | "List issue types for a repository" |
| `today-gather.sh` | `gh project item-list` | the Project's fields (for their ids and the Week iterations), then its items, paginated | Projects, as above |
| `today-gather.sh` | `gh pr list --state all` | `GET repos/{o}/{r}/pulls?state=all&base=main` (paginated); merged is `merged_at` set | Pulls, "List pull requests" |
| `after-merge.sh` | `gh pr list --state merged --head` | `GET repos/{o}/{r}/pulls?state=closed&base=main&head={o}:{branch}`, kept when `merged_at` is set | Pulls, "List pull requests" |

`stack.sh`, `open-pr.sh`, `orphan-issues.sh` and `ci-cost.sh` were REST already.
`.claude/skills/*/scripts/` (`diagnosing-bugs/scripts/hitl-loop.template.sh`,
`idea-refine/scripts/idea-refine.sh`) call no `gh` at all.

### Can Projects v2 field values be read and written over REST?

Yes, since GitHub added the REST Projects API: "List items for a user owned project" returns each
item's `fields` with their values (only the fields named in `fields`; "If not specified, the title
field will be returned"), and "Update project item for user" sets them, a single-select or iteration
field by "the ID of the option or iteration". A single-select value comes back as
`{id, name: {raw, html}, ...}` (the operation's example). The REST field ids are numbers, not the
`PVTSSF_...` node ids in `issue-tracker.md`'s table.

What blocks a cloud lane is the proxy, not REST: `users/...` paths are refused. The shape of an
iteration value in an item isn't in GitHub's examples; `today-gather.sh` takes its title from the
value and its dates from the field's iterations when the value lacks them.

### Issue fields

GitHub's issue fields (custom fields on the issue itself, not on a Project) have REST endpoints
under the repository: "List issue field values for an issue", "Add issue field values to an issue",
"Set issue field values for an issue" (`repos/{o}/{r}/issues/{n}/issue-field-values`), and the proxy
lets them through (an empty list for #346 on 18 Nov). The fields themselves are defined under
`user/issue-fields`, which the proxy refuses. Priority, Size and Week live on the Project today, so
nothing here uses issue fields.

## Left on GraphQL

These run outside cloud lanes, and each needs at least one call that REST doesn't offer:

<!-- prettier-ignore -->
| Where | Call | Why it stays |
| --- | --- | --- |
| `scripts/setup/ci-check-68.sh` | `gh pr ready` | no REST equivalent: the REST description has no ready-for-review operation (the cloud proxy offers its own route, `POST .../pulls/{n}/ccr/ready_for_review`, which isn't GitHub's REST) |
| `scripts/setup/ci-check-68.sh`, `ci-check.sh` (`results 101`) | `gh pr view --json reviewDecision` | no REST equivalent: the REST pull request has no review decision ("Get a pull request" lists `mergeable_state`, `auto_merge`, `requested_reviewers`, not it) |
| `scripts/setup/ci-check-68.sh`, `scripts/setup/workflows/check-101-identities.yml`, `.github/workflows/check-68-factory-resolve.yml` | `reviewThreads`, `resolveReviewThread` | no REST equivalent for review threads or resolving one |
| `scripts/setup/workflows/check-102-project.yml` | `projectV2` read with `GITHUB_TOKEN` | the check exists to test that GraphQL read from Actions (#102) |
| `scripts/setup/ci-check.sh`, `ci-check-68.sh` | `gh pr list`, `gh pr create --draft`, `gh pr close --comment`, `gh issue comment` | REST equivalents exist ("List pull requests", "Create a pull request" with `draft`, "Update a pull request" with `state: closed`, "Create an issue comment"), but the scripts also need the calls above, so they can't run in the cloud either way |

The setup scripts are the admin's runbooks, run from the admin's own clone outside the sandbox
(`scripts/setup/README.md`), and the workflows run in Actions, where GraphQL works.
