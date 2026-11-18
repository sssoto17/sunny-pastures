#!/usr/bin/env bash
# A test helper, never run outside a suite: a fake `gh` that answers `gh api` over REST from JSON
# files, for the scripts that #346 moved off GraphQL (issue-fields, new-issue, missing-fields,
# backfill-issue-types, today-gather, after-merge). A suite copies it to $work/bin/gh, puts that
# first on PATH and keeps its state in $work/gh. It never reaches GitHub, and it refuses every
# subcommand but `api`, so a call that would go through GraphQL fails the suite.
#
# State under $work/gh:
#   calls                   each call's arguments, one per line, then "--"
#   get/<path>              the JSON a GET of <path> returns (query string ignored); a missing
#                           file is a 404, as on GitHub
#   fail_<METHOD>_<path>    fails every such call with the file's text (path's / become _)
#   fail_<METHOD>_<path>.<n> fails only the n-th such call
#   refuse_projects         every users/<owner>/projectsV2 path answers as the cloud proxy does:
#                           HTTP 403, "sessions are bound to their configured repositories"
#   hook                    bash sourced for a call no get/ file answers (writes): it sees
#                           $method, $path, $query, $input (the JSON body) and $st, sets $out
#                           to the answer, or `return 1` for an unexpected call
# --jq runs through jq, as gh runs it through gojq (nothing these scripts use differs).
st=$(cd "$(dirname "$0")/../gh" && pwd)
for a in "$@"; do printf '%s\n' "$a"; done >>"$st/calls"
printf -- '--\n' >>"$st/calls"
[[ $1 == api ]] || { echo "fake: gh $1 goes through GraphQL; use gh api over REST" >&2; exit 99; }
shift
method="" endpoint="" filter="" input='{}' silent=0 has_params=0
while (($#)); do
  case $1 in
    -X | --method) method=$2; shift 2 ;;
    --jq | -q) filter=$2; shift 2 ;;
    --silent) silent=1; shift ;;
    --paginate) shift ;;
    -H | --header) shift 2 ;;
    --input) [[ $2 == - ]] || { echo "fake: --input takes - only" >&2; exit 98; }; input=$(cat); has_params=1; shift 2 ;;
    -f | -F | --raw-field | --field) # key=value into the body; -F types numbers and reads @file
      has_params=1
      k=${2%%=*} v=${2#*=}
      if [[ $1 == -F || $1 == --field ]] && [[ $v == @* ]]; then
        jv=$(jq -Rs . <"${v#@}")
      elif [[ ($1 == -F || $1 == --field) && $v =~ ^[0-9]+$ ]]; then
        jv=$v
      else
        jv=$(jq -n --arg v "$v" '$v')
      fi
      if [[ $k == *'[]' ]]; then
        input=$(jq --argjson v "$jv" --arg k "${k%'[]'}" '.[$k] += [$v]' <<<"$input")
      else
        input=$(jq --argjson v "$jv" --arg k "$k" '.[$k] = $v' <<<"$input")
      fi
      shift 2 ;;
    -*) echo "fake: unexpected flag $1" >&2; exit 98 ;;
    *) endpoint=$1; shift ;;
  esac
done
# gh sends a call with fields or --input as a POST unless -X says otherwise.
if [[ -z $method ]]; then
  method=GET
  ((has_params)) && method=POST
fi
path=${endpoint%%\?*} query=""
[[ $endpoint == *\?* ]] && query=${endpoint#*\?}
key=${method}_${path//\//_}
n=$(($(cat "$st/count_$key" 2>/dev/null || echo 0) + 1))
echo "$n" >"$st/count_$key"
for f in "$st/fail_$key" "$st/fail_$key.$n"; do
  [[ -f $f ]] && { cat "$f" >&2; exit 1; }
done
if [[ -f $st/refuse_projects && $path =~ ^users/[^/]+/projectsV2 ]]; then
  echo '{"message":"This GitHub API path is not available: sessions are bound to their configured repositories."}gh: This GitHub API path is not available: sessions are bound to their configured repositories. Use repository-scoped endpoints (repos/{owner}/{repo}/...). (HTTP 403)' >&2
  exit 1
fi
out=""
if [[ $method == GET && -f $st/get/$path ]]; then
  out=$(cat "$st/get/$path")
elif [[ -f $st/hook ]] && { . "$st/hook"; }; then
  :
elif [[ $method == GET ]]; then
  echo "gh: Not Found (HTTP 404)" >&2
  exit 1
else
  echo "fake: unexpected endpoint $method $endpoint" >&2
  exit 97
fi
((silent)) && exit 0
if [[ -n $filter ]]; then jq -r "$filter" <<<"$out"; else printf '%s\n' "$out"; fi
