#!/usr/bin/env bash
# Checks supabase/migrations (CONSTRAINTS.md, "Migrations"; #331 decision 7). No database needed.
#   1. Forward-only: no migration that exists at the merge base with <since> (default origin/main)
#      is edited, renamed or deleted. An applied migration is never changed; a fix is a new one.
#   2. No drift: `drizzle-kit check` validates only drizzle-kit's own snapshots and journal, so this
#      also runs `drizzle-kit generate` and fails when it wrote anything, a schema.ts change with no
#      migration. Generate writes into supabase/migrations, so run it on a clean tree: an
#      uncommitted migration fails it too, and a failure leaves the new files there to commit or
#      delete.
# Usage: supabase/drift.sh [<since>]   (`pnpm db:check`; `ci / lint` passes the stack's base)
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

since=${1:-origin/main}
if ! git rev-parse -q --verify "$since^{commit}" >/dev/null; then
  echo "db:check: can't resolve $since to check migrations are forward-only; fetch it first." >&2
  exit 2
fi
changed=$(git diff --name-status --diff-filter=MDRT "$since"...HEAD -- 'supabase/migrations/*.sql')
if [[ -n $changed ]]; then
  printf '%s\n' "$changed" >&2
  echo "db:check: migrations are forward-only: an applied migration is never edited, renamed or deleted. Add a new one." >&2
  exit 1
fi

kit() { pnpm --dir apps/web exec drizzle-kit "$@" --config drizzle.config.json; }

kit check
kit generate

changes=$(git status --porcelain --untracked-files=all -- supabase/migrations)
if [[ -n $changes ]]; then
  printf '%s\n' "$changes" >&2
  echo "db:check: schema.ts and supabase/migrations differ. Run pnpm db:generate and commit the migration." >&2
  exit 1
fi
echo "db:check: supabase/migrations matches schema.ts."
