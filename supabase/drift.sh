#!/usr/bin/env bash
# Checks supabase/migrations (CONSTRAINTS.md, "Migrations"; #331 decision 7). No database needed.
#   1. Forward-only: no migration that exists at the merge base with <since> (default origin/main)
#      is edited, renamed or deleted. An applied migration is never changed; a fix is a new one.
#   2. Atomic files: no statement that commits on its own (CONCURRENTLY, VACUUM, ALTER SYSTEM,
#      CLUSTER) in any migration (CONSTRAINTS.md, "Migrations: atomic files"; #64 decision 6).
#      `supabase db push` runs each file as one transaction, so a file is applied whole or not at
#      all; most of these can't run inside a transaction, and CLUSTER rewrites a table under a
#      lock. Comments, strings, quoted identifiers and dollar-quoted bodies are blanked first, so a
#      word there doesn't count.
#   3. No drift: `drizzle-kit check` validates only drizzle-kit's own snapshots and journal, so this
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

# Prints file:line: KEYWORD for each statement that commits on its own; exits 1 if it found any.
# VACUUM, CLUSTER and ALTER SYSTEM count only where a statement starts (`ALTER TABLE … CLUSTER ON`
# runs in a transaction); CONCURRENTLY counts anywhere in a statement.
autocommits() {
  perl - "$@" <<'PERL'
use strict;
use warnings;
my $found = 0;
for my $file (@ARGV) {
  open(my $fh, '<', $file) or die "db:check: can't read $file: $!\n";
  my $sql = do { local $/; <$fh> };
  close $fh;
  # Blank every character but line breaks, so offsets still give line numbers.
  $sql =~ s{(--[^\n]*|/\*.*?\*/|'(?:[^']|'')*'|"(?:[^"]|"")*"|(\$(?:[A-Za-z_]\w*)?\$).*?\2)}
           {(my $m = $1) =~ tr/\n/ /c; $m}gse;
  while ($sql =~ /([^;]+)/g) {
    my ($stmt, $start) = ($1, $-[1]);
    next unless $stmt =~ /^(\s*)\S/;
    my $line = 1 + (substr($sql, 0, $start + length $1) =~ tr/\n//);
    my ($what) = $stmt =~ /^\s*(VACUUM|CLUSTER|ALTER\s+SYSTEM)\b/i;
    ($what) = $stmt =~ /\b(CONCURRENTLY)\b/i unless defined $what;
    next unless defined $what;
    $what = uc $what =~ s/\s+/ /gr;
    print "$file:$line: $what\n";
    $found = 1;
  }
}
exit $found;
PERL
}

shopt -s nullglob
migrations=(supabase/migrations/*.sql)
shopt -u nullglob
if ((${#migrations[@]})) && ! autocommits "${migrations[@]}" >&2; then
  echo "db:check: migrations hold no statements that commit on their own (CONCURRENTLY, VACUUM, ALTER SYSTEM, CLUSTER): supabase db push runs each file as one transaction, and these can't run inside one or rewrite a table under a lock (#64 decision 6). Use the form that runs in a transaction (CREATE INDEX without CONCURRENTLY, say)." >&2
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
