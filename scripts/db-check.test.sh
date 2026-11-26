#!/usr/bin/env bash
# Tests for `supabase/drift.sh` (`pnpm db:check`, #372, #477) through its command line, in a
# throwaway git repo under $TMPDIR. `pnpm` is a fake on PATH that logs its arguments, so
# drizzle-kit never runs; `generate` writes a migration only when the test asks it to. What's
# checked: a statement that commits on its own (CONCURRENTLY, VACUUM, ALTER SYSTEM, CLUSTER) in
# supabase/migrations/*.sql fails, named by file and line, before drizzle-kit runs; the same words
# in a comment, a string, a quoted identifier or a dollar-quoted body don't; `ALTER TABLE … CLUSTER
# ON` (which runs in a transaction) doesn't; and the forward-only and drift checks still fail.
# Run: bash scripts/db-check.test.sh
set -uo pipefail

script="$(cd "$(dirname "$0")/.." && pwd)/supabase/drift.sh"
pass=0
fail=0

work=$(mktemp -d "${TMPDIR:-/tmp}/db-check-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/repo/supabase/migrations"
printf '[user]\n\tname = db-check test\n\temail = db-check@example.invalid\n' >"$work/gitconfig"
export GIT_CONFIG_GLOBAL="$work/gitconfig" GIT_CONFIG_NOSYSTEM=1

cat >"$work/bin/pnpm" <<'FAKE'
#!/usr/bin/env bash
dir=$(dirname "$0")/..
printf '%s\n' "$*" >>"$dir/calls"
if [[ $* == *" generate "* && -f $dir/drift ]]; then
  echo 'CREATE TABLE "game"."extra" ();' >supabase/migrations/20990101000000_extra.sql
fi
exit 0
FAKE
chmod +x "$work/bin/pnpm"
export PATH="$work/bin:$PATH"

check() {
  if [[ $2 == ok ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $1" >&2
  fi
}

cd "$work/repo" || exit 1
git init -q
cat >supabase/migrations/20260101000000_base.sql <<'SQL'
CREATE TABLE "game"."base" ("id" uuid NOT NULL);
SQL
git add -A
git commit -qm base
base=$(git rev-parse HEAD)

# Runs drift.sh against the base commit with one new migration holding $1, from a clean tree.
run_with() {
  git reset -q --hard "$base"
  git clean -qfd
  : >"$work/calls"
  printf '%s\n' "$1" >supabase/migrations/20260102000000_new.sql
  git add -A
  git commit -qm new
  bash "$script" "$base" >"$work/out" 2>&1
}

refused() { # $1 name, $2 SQL, $3 line the refusal must name
  run_with "$2"
  check "$1: fails" "$([[ $? == 1 ]] && echo ok)"
  check "$1: names the file and line" \
    "$(grep -q "supabase/migrations/20260102000000_new.sql:$3:" "$work/out" && echo ok)"
  check "$1: says why" "$(grep -q 'commit on their own' "$work/out" && echo ok)"
  check "$1: stops before drizzle-kit" "$([[ ! -s $work/calls ]] && echo ok)"
}

allowed() { # $1 name, $2 SQL
  run_with "$2"
  check "$1: passes" "$([[ $? == 0 ]] && echo ok)"
  check "$1: runs drizzle-kit check and generate" \
    "$(grep -q ' check ' "$work/calls" && grep -q ' generate ' "$work/calls" && echo ok)"
}

refused "CREATE INDEX CONCURRENTLY" \
  'CREATE INDEX CONCURRENTLY "base_id_idx" ON "game"."base" ("id");' 1
refused "lowercase vacuum after a comment line" \
  $'-- tidy up\n--> statement-breakpoint\nvacuum analyze "game"."base";' 3
refused "ALTER SYSTEM across lines" \
  $'SELECT 1;\nALTER\n  SYSTEM SET work_mem = \'64MB\';' 2
refused "CLUSTER" \
  $'CREATE INDEX "b" ON "game"."base" ("id");--> statement-breakpoint\nCLUSTER "game"."base" USING "b";' 2
refused "REINDEX CONCURRENTLY in a statement after a dollar-quoted body" \
  $'DO $$ BEGIN PERFORM 1; END $$;\nREINDEX INDEX CONCURRENTLY "b";' 2

allowed "the words in comments, strings, identifiers and dollar-quoted bodies" \
  "$(
    cat <<'SQL'
-- CREATE INDEX CONCURRENTLY later, once the table is big; VACUUM too.
/* ALTER SYSTEM is never for a migration;
   CLUSTER neither */
COMMENT ON TABLE "game"."base" IS 'see VACUUM; CLUSTER; and it''s CONCURRENTLY safe';
ALTER TABLE "game"."base" ADD COLUMN "vacuum" text;
DO $body$
BEGIN
  RAISE NOTICE 'CLUSTER %', 1; -- VACUUM
END
$body$;
SQL
  )"
allowed "ALTER TABLE … CLUSTER ON, which runs in a transaction" \
  $'CREATE INDEX "b" ON "game"."base" ("id");\nALTER TABLE "game"."base" CLUSTER ON "b";\nALTER TABLE "game"."base" SET WITHOUT CLUSTER;'

# The checks that were there before #477 still hold.
git reset -q --hard "$base"
echo '-- edited' >>supabase/migrations/20260101000000_base.sql
git commit -qam edit
bash "$script" "$base" >"$work/out" 2>&1
check "an edited migration fails" "$([[ $? == 1 ]] && echo ok)"
check "an edited migration is called forward-only" \
  "$(grep -q 'forward-only' "$work/out" && echo ok)"

touch "$work/drift"
run_with 'CREATE TABLE "game"."other" ("id" uuid NOT NULL);'
check "drift fails" "$([[ $? == 1 ]] && echo ok)"
check "drift says to generate" "$(grep -q 'pnpm db:generate' "$work/out" && echo ok)"
rm -f "$work/drift"

echo "db-check.test.sh: $pass passed, $fail failed"
[[ $fail == 0 ]]
