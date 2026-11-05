# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

This is a solo project: every issue is written by the owner, so there is no reporter to wait on and nothing to reject by label. Work is manual by default. Anything automated belongs to the **factory** and carries a `factory:` label. The Project's **Mode** field (Manual / Factory) is the top-level split for tracking; `factory:*` labels scope factory work further (more states arrive with the factory itself, e.g. `factory:changes`).

| Label in mattpocock/skills | Label in our tracker | Meaning                                         |
| -------------------------- | -------------------- | ----------------------------------------------- |
| `needs-triage`             | `triage`             | Needs evaluation before it can be worked        |
| `needs-info`               | a `blocked:*` label  | Can't move until the reason named below clears  |
| `ready-for-agent`          | `factory:ready`      | Fully specified; the factory may pick it up without the admin |
| `ready-for-human`          | no label             | The default. Readiness is the Project **Status** `Ready` (see `issue-tracker.md`, **Status rules**) |
| `wontfix`                  | no label             | Close with `gh issue close <n> --reason "not planned" --comment "<why>"` |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table. A role with no label means: remove `triage` if present and set the Status the role implies. `factory:ready` is the only label that says an issue can be worked without the admin in the loop; when you apply it, also set the issue's Project **Mode** to `Factory`.

## Blocked

A `blocked:*` label says why an issue can't be worked, or can't be queued for the factory, yet. Remove it when the reason clears. An issue may carry more than one.

| Label              | Use when                                                                 |
| ------------------ | ------------------------------------------------------------------------ |
| `blocked:decision` | A design or scope decision by the admin is still open                    |
| `blocked:external` | It waits on something outside the project: a service, a person, upstream |
| `blocked:admin`    | Only the admin can do it: config, secrets, protected files, dashboards   |

An issue blocked by another issue uses GitHub's native issue dependencies instead (see `issue-tracker.md`, **Blocking**), not a label.
