#!/usr/bin/env bash
# The load VM devcontainer's postCreateCommand (ADR-0009, section 4; #501). Enables Corepack, runs
# the frozen install, and installs the Supabase CLI and uv from the versions already pinned
# elsewhere, never a second copy of them:
#   - the Supabase CLI: SUPABASE_VERSION and SUPABASE_SHA256 in the supabase-cli action, which CI
#     installs from too; `pnpm supabase:check` then checks the binary against package.json's pin.
#   - uv: `required-version` in tools/load/pyproject.toml, the load project (#388). Its archive's
#     hash is below, keyed by version, since no file holds it yet.
# Each download is checked against its hash before it is unpacked, as the supabase-cli action and
# workflow-lint.yml do. linux amd64 only: those are the only hashes pinned. Prints no secret.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
bin=$HOME/.local/bin
mkdir -p "$bin"
export PATH=$bin:$PATH
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fail() {
	echo "post-create: $*" >&2
	exit 1
}

# One `key: value` line from a YAML file; fails unless the key is there exactly once.
pin() {
	local key=$1 file=$2 values
	values=$(sed -n -E "s/^[[:space:]]+$key:[[:space:]]*([^[:space:]#]+)[[:space:]]*\$/\1/p" "$file")
	[[ -n $values && $values != *$'\n'* ]] || fail "expected one $key in $file"
	printf '%s\n' "$values"
}

# Download $1 to $2 and check it against the sha256 $3.
fetch() {
	curl -fsSL --retry 3 -o "$2" "$1"
	echo "$3  $2" | sha256sum --check --strict
}

[[ $(dpkg --print-architecture) == amd64 ]] || fail "linux amd64 only: the pinned hashes are for it"

nvmrc=$(tr -d '[:space:]' <.nvmrc)
node=$(node --version)
[[ $node == "v$nvmrc" || $node == "v$nvmrc."* ]] || fail "Node $node doesn't match .nvmrc ($nvmrc)"

# pnpm at package.json's packageManager pin, through Corepack (as .github/actions/setup does).
corepack enable --install-directory "$bin"
# The checkout may hold a node_modules the host installed from another store; with no TTY, pnpm
# would abort rather than ask to replace it, so it replaces it without asking.
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile --config.confirmModulesPurge=false

action=.github/actions/supabase-cli/action.yml
supabase_version=$(pin SUPABASE_VERSION "$action")
supabase_sha256=$(pin SUPABASE_SHA256 "$action")
archive="supabase_${supabase_version}_linux_amd64.tar.gz"
fetch "https://github.com/supabase/cli/releases/download/v${supabase_version}/$archive" \
	"$tmp/$archive" "$supabase_sha256"
tar -xzf "$tmp/$archive" -C "$bin" supabase
pnpm supabase:check
echo "Supabase CLI $supabase_version installed."

# uv's linux amd64 archive (uv-x86_64-unknown-linux-gnu.tar.gz) for each version the load project
# may pin, from the release's own .sha256 file. Add a line when the pin moves, with the date the
# version was checked against the 7-day rule. 0.13.6: the release's PyPI upload is dated 27 Oct 2026
# (GitHub's release API isn't reachable from a cloud session); checked 22 Nov.
declare -A uv_sha256=(
	[0.13.6]=f29c3e94ffabd7e6f3ba521dba169a9b7ec12100bf3257087f0f24f6123f3645
)
pyproject=tools/load/pyproject.toml
if [[ ! -f $pyproject ]]; then
	# The load project lands with #388; until then there is no uv pin to read.
	echo "post-create: $pyproject doesn't exist yet (#388), so uv isn't installed." >&2
else
	uv_version=$(sed -n -E 's/^required-version[[:space:]]*=[[:space:]]*"==([0-9.]+)"[[:space:]]*$/\1/p' "$pyproject")
	[[ -n $uv_version && $uv_version != *$'\n'* ]] ||
		fail "expected one exact required-version (\"==X.Y.Z\") in $pyproject"
	[[ -n ${uv_sha256[$uv_version]:-} ]] ||
		fail "no hash for uv $uv_version in .devcontainer/post-create.sh; add one"
	archive=uv-x86_64-unknown-linux-gnu.tar.gz
	fetch "https://github.com/astral-sh/uv/releases/download/$uv_version/$archive" \
		"$tmp/$archive" "${uv_sha256[$uv_version]}"
	tar -xzf "$tmp/$archive" -C "$bin" --strip-components=1 \
		uv-x86_64-unknown-linux-gnu/uv uv-x86_64-unknown-linux-gnu/uvx
	[[ $(uv --version) == "uv $uv_version"* ]] || fail "uv reports $(uv --version), not $uv_version"
	echo "uv $uv_version installed."
fi
