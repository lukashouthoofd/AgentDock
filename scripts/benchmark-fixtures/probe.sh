#!/bin/bash
set -eu
root=${BASH_SOURCE[0]%/*}
fixture="$root/shell.rc"
count=0
rss=0
pids=()
shopt -s nullglob

is_fixture() {
    local process=$1 argument executable
    [[ $process =~ ^[0-9]+$ && -O /proc/"$process" && -r /proc/"$process"/cmdline ]] || return 1
    IFS= read -r executable < /proc/"$process"/comm && [[ $executable == bash ]] || return 1
    while IFS= read -r -d '' argument; do
        [[ $argument == "$fixture" ]] && return 0
    done < /proc/"$process"/cmdline
    return 1
}

for marker in "$root"/shell-*.ready; do
    { IFS= read -r process && IFS= read -r runtime && IFS= read -r distro; } < "$marker" || continue
    [[ $runtime == Linux && $distro == "$WSL_DISTRO_NAME" ]] || continue
    is_fixture "$process" || continue
    case ${1:-} in
        cleanup) kill -HUP -- "$process" 2>/dev/null || true ;;
        force-cleanup) kill -KILL -- "$process" 2>/dev/null || true ;;
    esac
    pages=$(awk '$1 == "VmRSS:" {print $2}' /proc/"$process"/status 2>/dev/null || true)
    count=$((count + 1))
    rss=$((rss + ${pages:-0}))
    pids+=("$process")
done
printf '%s %s\n' "$count" "$rss"
printf '%s\n' "$WSL_DISTRO_NAME" "$(uname -s)" "$(uname -r)"
if (( count )); then printf '%s\n' "${pids[@]}"; fi
