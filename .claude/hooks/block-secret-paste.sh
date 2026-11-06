#!/usr/bin/env bash
# UserPromptSubmit hook: refuse a prompt that contains a secret, before any session reads it.
# Exit 2 blocks the prompt and shows stderr to the user; the prompt never reaches the model.
# It matches the raw hook JSON on stdin, so it needs no jq. Placeholders such as
# `postgres:<password>@` and redacted output (`<hidden>`) pass. 64-hex hashes pass, since the
# spike prints state hashes.
set -uo pipefail

input=$(cat)

patterns=(
  'sb_secret_[A-Za-z0-9_-]{8,}'                                       # Supabase secret key
  'sb_publishable_[A-Za-z0-9_-]{8,}'                                  # Supabase publishable key
  'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'  # JWT (anon/service_role)
  'super-secret-jwt-token'                                            # Supabase local JWT secret
  '(Secret|Access) Key[^A-Za-z0-9]{1,12}[A-Za-z0-9]{24,}'             # `supabase start` S3 box
  'postgres(ql)?://[^:/@[:space:]"]+:[^@[:space:]"<>]+@'              # DB URL with a password
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'                                # PEM private key
  '(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}' # GitHub token
  'sk-ant-[A-Za-z0-9_-]{20,}'                                         # Anthropic API key
  'AKIA[0-9A-Z]{16}'                                                  # AWS access key id
)

for p in "${patterns[@]}"; do
  if grep -qE -e "$p" <<<"$input"; then
    cat >&2 <<'EOF'
Blocked: this message looks like it contains a secret (a key, token or a database URL with a
password), so it was not sent. Paste redacted output instead, e.g. `pnpm db:status` for the
local Supabase stack. See docs/agents/sandbox.md, "Secrets in output".
EOF
    exit 2
  fi
done
exit 0