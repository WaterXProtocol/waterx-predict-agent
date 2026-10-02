#!/usr/bin/env bash
# waterx-commons/harness/lint/check-harness.sh v1.1.0
#
# Checks a repository against the WaterX agent-harness standard
# (Bucket-Protocol/waterx-commons, harness/STANDARD.md). Repos vendor this file as
# scripts/agent-hooks/check-harness.sh; keep the version line above intact so the
# "vendored copies" job in waterx-commons can tell which version a repo carries.
#
# Usage: check-harness.sh [--root <dir>] [--hub <dir>] [--allow-vendored <glob>]... [--report-only]
#                         [--version] [--help]
#   --root <dir>              repository root to check (default: the git toplevel of the cwd, else cwd)
#   --hub <dir>               knowledge-hub directory, relative to the root (default: docs/knowledge-hub,
#                             or knowledge-hub when docs/ is a git submodule)
#   --allow-vendored <glob>   a third-party tree whose CLAUDE.md files check 1 lists but does not fail
#                             (shell glob on the path from the root, '*' crosses '/'; repeatable)
#   --report-only             print every finding but always exit 0
# Exit 1 when a blocking finding exists (and --report-only is not set), 0 otherwise, 64 on a
# bad argument. Inside a git checkout the scan covers tracked and untracked-but-not-ignored
# files (submodule contents excluded); elsewhere it walks the tree minus build directories.
#
# Portability: bash 3.2 (macOS /bin/bash) and up; coreutils, find, grep, awk, sed, git.
# jq is used for hook JSON when present; a grep fallback covers its absence.
set -u

VERSION="1.1.0"
ROOT=""
HUB=""
REPORT_ONLY=0
ALLOW_VENDORED=""
ROOT_LIMIT_LINES=200
ROOT_LIMIT_BYTES=24576
DESCRIPTION_LIMIT_CHARS=1536
CODEX_DEFAULT_CAP=32768
CODEX_WARN_BYTES=30720
CODEX_REQUIRED_CAP=131072

usage() { sed -n '2,21p' "$0"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --root|--hub)
      [ $# -ge 2 ] && [ -n "$2" ] || { echo "$1 needs a directory" >&2; usage >&2; exit 64; }
      if [ "$1" = --root ]; then ROOT=$2; else HUB=$2; fi
      shift 2 ;;
    --allow-vendored)
      [ $# -ge 2 ] && [ -n "$2" ] || { echo "$1 needs a glob" >&2; usage >&2; exit 64; }
      ALLOW_VENDORED="$ALLOW_VENDORED$2
"; shift 2 ;;
    --allow-vendored=*) ALLOW_VENDORED="$ALLOW_VENDORED${1#--allow-vendored=}
"; shift ;;
    --root=*) ROOT=${1#--root=}; shift ;;
    --hub=*) HUB=${1#--hub=}; shift ;;
    --report-only) REPORT_ONLY=1; shift ;;
    --version) echo "check-harness.sh v$VERSION"; exit 0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
done

if [ -z "$ROOT" ]; then
  ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
fi
ROOT_ARG=$ROOT
ROOT=$(cd "$ROOT_ARG" 2>/dev/null && pwd -P) || { echo "root not found: $ROOT_ARG" >&2; exit 64; }
cd "$ROOT" || exit 64

BLOCKING=0
ADVISORY=0
CHECK_FINDINGS=0

phys() { # physical path of a directory, empty when it does not resolve
  (cd "$1" 2>/dev/null && pwd -P)
}

# The file set every check reads. In a git checkout rooted here: tracked plus untracked files
# that .gitignore does not exclude, so local worktree copies, build output and submodule
# contents (each a separate repository with its own harness) stay out. Elsewhere: a walk
# that skips dependency and build trees.
PRUNE_DIRS='.git node_modules target dist build .next vendor .venv'
SUBMODULES=""
if [ "$(phys "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)")" = "$ROOT" ]; then
  ALL_FILES=$(git -c core.quotepath=off ls-files --cached --others --exclude-standard 2>/dev/null |
    while IFS= read -r p; do { [ -e "$p" ] || [ -L "$p" ]; } && printf '%s\n' "$p"; done)
  [ -f .gitmodules ] && SUBMODULES=$(git config -f .gitmodules --get-regexp '^submodule\..*\.path$' 2>/dev/null | awk '{ print $2 }')
else
  prune=""
  for d in $PRUNE_DIRS; do prune="$prune${prune:+ -o }-name $d"; done
  # shellcheck disable=SC2086
  ALL_FILES=$(find . \( $prune \) -prune -o \( -type f -o -type l \) -print 2>/dev/null | sed 's|^\./||')
fi

# find_files <basename>: paths relative to ROOT with that basename, sorted.
find_files() {
  printf '%s\n' "$ALL_FILES" | awk -F/ -v n="$1" '$NF == n' | sort
}

is_submodule_path() { # <relative path>: 0 when it lies inside a git submodule
  local m
  for m in $SUBMODULES; do case "$1" in "$m"|"$m"/*) return 0;; esac; done
  return 1
}

# The lesson store. A repo whose docs/ is a submodule (another repository) keeps it at the root.
if [ -z "$HUB" ]; then
  if is_submodule_path docs; then HUB=knowledge-hub; else HUB=docs/knowledge-hub; fi
fi
HUB=${HUB%/}

file_bytes() { wc -c < "$1" | tr -d ' '; }
file_lines() { wc -l < "$1" | tr -d ' '; }

# A UTF-8 locale for counting characters: Linux lists it as C.utf8, macOS as en_US.UTF-8.
UTF8_LOCALE=$(locale -a 2>/dev/null | grep -iE '^(c|en_us)\.utf-?8$' | head -1)
char_count() { # characters on stdin; bytes (an overcount, never an undercount) without a UTF-8 locale
  if [ -n "$UTF8_LOCALE" ]; then LC_ALL=$UTF8_LOCALE wc -m | tr -d ' '; else wc -c | tr -d ' '; fi
}

git_ignored() { # 0 when the path is ignored by git (only meaningful inside a git repo)
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 1
  git check-ignore -q "$1" 2>/dev/null
}

begin_check() { # <number> <title> <reason>
  CHECK_FINDINGS=0
  printf '[%s] %s\n    why: %s\n' "$1" "$2" "$3"
}
fail() { # blocking finding
  CHECK_FINDINGS=$((CHECK_FINDINGS + 1))
  if [ $REPORT_ONLY -eq 1 ]; then ADVISORY=$((ADVISORY + 1)); printf '    FAIL(report-only) %s\n' "$1"
  else BLOCKING=$((BLOCKING + 1)); printf '    FAIL %s\n' "$1"; fi
}
warn() { # advisory finding
  CHECK_FINDINGS=$((CHECK_FINDINGS + 1)); ADVISORY=$((ADVISORY + 1)); printf '    WARN %s\n' "$1"
}
end_check() { [ $CHECK_FINDINGS -eq 0 ] && printf '    ok\n'; return 0; }

# A directory under .claude/skills or .agents/skills belongs to checks 3/4, not 1, 5 or 7:
# vendored skill bundles ship their own AGENTS.md / CLAUDE.md, which hide nothing outside the bundle.
in_skill_tree() { case "$1" in .claude/skills/*|.agents/skills/*|*/.claude/skills/*|*/.agents/skills/*) return 0;; esac; return 1; }

echo "check-harness v$VERSION — root: $ROOT$( [ $REPORT_ONLY -eq 1 ] && printf ' (report-only)')"
echo

# ---------------------------------------------------------------------------------------------
begin_check 1 "AGENTS.md is the only instruction file: no committed CLAUDE.md, .claude/CLAUDE.md or CLAUDE.local.md; every AGENTS.md a real file" \
  "Claude Code (v2.1.281+) reads AGENTS.md only while no CLAUDE.md, .claude/CLAUDE.md or CLAUDE.local.md sits in that directory or above it, so one stray CLAUDE.md silently hides every AGENTS.md at and below it; Codex reads only AGENTS.md. A symlinked AGENTS.md is the retired CLAUDE.md layout."
is_vendored() { # <relative path>: 0 when it matches an --allow-vendored glob
  local g
  [ -n "$ALLOW_VENDORED" ] || return 1
  while IFS= read -r g; do
    [ -n "$g" ] || continue
    # shellcheck disable=SC2254
    case "$1" in $g) return 0;; esac
  done <<EOF
$ALLOW_VENDORED
EOF
  return 1
}
in_dir() { if [ "$1" = . ]; then printf '%s' "$2"; else printf '%s/%s' "$1" "$2"; fi; }
vendored_listed=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  in_skill_tree "$f" && continue
  if is_vendored "$f"; then vendored_listed="$vendored_listed $f"; continue; fi
  d=$(dirname "$f")
  case "$f" in
    .claude/CLAUDE.md|*/.claude/CLAUDE.md) owner=$(dirname "$d"); hint="move its text into $(in_dir "$owner" AGENTS.md), then git rm $f" ;;
    *CLAUDE.local.md) owner=$d; hint="git rm --cached $f; a personal file does not belong in the repo, and even untracked it hides AGENTS.md in that checkout" ;;
    *) owner=$d; a=$(in_dir "$d" AGENTS.md)
       if [ -L "$a" ]; then hint="the retired layout: git rm -q --cached $a && rm $a && git mv $f $a"
       elif [ -e "$a" ]; then hint="fold its text into $a, then git rm $f"
       else hint="git mv $f $a"; fi ;;
  esac
  where=$owner; [ "$where" = . ] && where="the repository root"
  fail "$f: committed; Claude Code ignores every AGENTS.md at or below $where while it exists ($hint)"
done <<EOF
$( { find_files CLAUDE.md; find_files CLAUDE.local.md; } | sort)
EOF
[ -n "$vendored_listed" ] && printf '    note: CLAUDE files allowed by --allow-vendored:%s\n' "$vendored_listed"
while IFS= read -r f; do
  [ -n "$f" ] || continue
  in_skill_tree "$f" && continue
  if [ -L "$f" ]; then
    fail "$f: is a symlink (-> $(readlink "$f")); AGENTS.md must be the real file holding the text"
  elif [ ! -f "$f" ]; then
    fail "$f: is not a regular file"
  fi
done <<EOF
$(find_files AGENTS.md)
EOF
# Not committed, so advisory: each still hides the root AGENTS.md from Claude Code in this checkout.
for f in CLAUDE.md .claude/CLAUDE.md CLAUDE.local.md; do
  if { [ -f "$f" ] || [ -L "$f" ]; } && git_ignored "$f"; then
    warn "$f: present locally (git-ignored); Claude Code ignores this repo's AGENTS.md in this checkout while it exists"
  fi
done
p=$(dirname "$ROOT")
while :; do
  for n in CLAUDE.md .claude/CLAUDE.md CLAUDE.local.md; do
    # ~/.claude/CLAUDE.md is the user-level file; it does not hide AGENTS.md.
    [ "$p/$n" = "${HOME:-/nonexistent}/.claude/CLAUDE.md" ] && continue
    [ -f "$p/$n" ] && warn "$p/$n: above the repository root; Claude Code ignores this repo's AGENTS.md in sessions started under it"
  done
  [ "$p" = "/" ] && break
  p=$(dirname "$p")
done
end_check

# ---------------------------------------------------------------------------------------------
begin_check 2 "root AGENTS.md ≤ $ROOT_LIMIT_LINES lines, ≤ $ROOT_LIMIT_BYTES bytes, no @path import lines" \
  "The root file loads in every session of both tools; Claude Code's guidance targets <200 lines, Codex truncates silently past its byte cap, and Codex shows a Claude @path import as plain text."
if [ -L AGENTS.md ]; then
  : # check 1 reports the symlink; there is no real root file to measure
elif [ ! -f AGENTS.md ]; then
  fail "AGENTS.md: missing at the root (every WaterX repo carries one; Claude Code and Codex both read it)"
else
  lines=$(file_lines AGENTS.md); bytes=$(file_bytes AGENTS.md)
  [ "$lines" -gt "$ROOT_LIMIT_LINES" ] && fail "AGENTS.md: $lines lines (limit $ROOT_LIMIT_LINES); move area-specific text to <area>/AGENTS.md, .claude/rules/, or a skill"
  [ "$bytes" -gt "$ROOT_LIMIT_BYTES" ] && fail "AGENTS.md: $bytes bytes (limit $ROOT_LIMIT_BYTES)"
  # An import is a line whose first token is @<path>, outside fenced code blocks.
  imports=$(awk '
    /^[[:space:]]*(```|~~~)/ { fence = !fence; next }
    !fence && $0 ~ /^[[:space:]]*@[A-Za-z0-9_~.\/-]/ { printf "%d:%s\n", NR, $0 }
  ' AGENTS.md)
  if [ -n "$imports" ]; then
    while IFS= read -r line; do
      fail "AGENTS.md:$line — @path import line; inline the text or link the file in prose"
    done <<EOF
$imports
EOF
  fi
fi
end_check

# ---------------------------------------------------------------------------------------------
begin_check 3 ".claude/skills and .agents/skills mirror each other by symlink" \
  "Claude Code discovers only .claude/skills/<name>/SKILL.md; Codex scans .agents/skills. Codex follows symlinked skill directories but skips a symlinked SKILL.md file and a symlinked .agents/skills directory."
if [ -L .agents/skills ]; then
  fail ".agents/skills: is itself a symlink; Codex does not discover a symlinked skills directory (make it a real directory of per-skill symlinks)"
fi
if [ -L .claude/skills ]; then
  fail ".claude/skills: is itself a symlink; make it a real directory"
fi
names=$( { [ -d .claude/skills ] && ls -1 .claude/skills; [ -d .agents/skills ] && ls -1 .agents/skills; } 2>/dev/null | sort -u )
for n in $names; do
  c=".claude/skills/$n"; a=".agents/skills/$n"
  # Regular files in either tree (README, lock files) are not skills.
  if [ ! -d "$c" ] && [ ! -L "$c" ] && [ ! -d "$a" ] && [ ! -L "$a" ]; then continue; fi
  if [ -L "$c" ] && [ ! -e "$c" ]; then fail "$c: dangling symlink ($(readlink "$c"))"; continue; fi
  if [ -L "$a" ] && [ ! -e "$a" ]; then fail "$a: dangling symlink ($(readlink "$a"))"; continue; fi
  if [ -L "$c" ] && [ -L "$a" ]; then fail "$n: both sides are symlinks; one must be the real directory"; continue; fi
  if [ ! -e "$c" ] && [ ! -L "$c" ]; then fail "$a: no .claude/skills/$n beside it, so Claude Code never loads this skill (ln -s ../../.agents/skills/$n $c for a vendored bundle)"; continue; fi
  if [ ! -e "$a" ] && [ ! -L "$a" ]; then fail "$c: no .agents/skills/$n, so Codex never loads this skill (ln -s ../../.claude/skills/$n $a)"; continue; fi
  if [ ! -L "$c" ] && [ ! -L "$a" ]; then fail "$n: two real copies (.claude/skills and .agents/skills); keep one and symlink the other, or the two drift apart"; continue; fi
  if [ -L "$c" ]; then link=$c; real=$a; else link=$a; real=$c; fi
  if [ ! -d "$real" ]; then fail "$real: expected a real directory"; continue; fi
  lp=$(phys "$link"); rp=$(phys "$real")
  if [ "$lp" != "$rp" ]; then fail "$link: points to $(readlink "$link"), not to $real"; continue; fi
  if [ ! -f "$real/SKILL.md" ]; then fail "$real/SKILL.md: missing"; continue; fi
  if [ -L "$real/SKILL.md" ]; then fail "$real/SKILL.md: is a file symlink; Codex skips symlinked SKILL.md files (symlink the directory instead)"; fi
done
end_check

# ---------------------------------------------------------------------------------------------
begin_check 4 "every .claude/skills/*/SKILL.md has a frontmatter description ≤ $DESCRIPTION_LIMIT_CHARS chars" \
  "Claude Code loads every skill's description into every session and caps it at 1,536 characters; the body loads only on trigger, so the description is what decides whether the skill fires."
if [ -d .claude/skills ]; then
  for s in .claude/skills/*/; do
    [ -d "$s" ] || continue
    sk="${s}SKILL.md"
    [ -f "$sk" ] || { fail "$sk: missing"; continue; }
    fm=$(awk '{ sub(/\r$/, "") } NR==1 && $0 != "---" { exit } NR>1 && $0 == "---" { exit } NR>1 { print }' "$sk")
    if [ -z "$fm" ]; then fail "$sk: no YAML frontmatter (needs name + description)"; continue; fi
    desc=$(printf '%s\n' "$fm" | awk '
      /^description:/ { on = 1; sub(/^description:[[:space:]]*/, ""); sub(/^[>|][-+]?[[:space:]]*$/, ""); if ($0 != "") print; next }
      on && /^[[:space:]]/ { sub(/^[[:space:]]+/, ""); print; next }
      on { exit }
    ')
    if [ -z "$(printf '%s' "$desc" | tr -d '[:space:]')" ]; then fail "$sk: frontmatter has no description"; continue; fi
    n=$(printf '%s' "$desc" | char_count)
    [ "$n" -gt "$DESCRIPTION_LIMIT_CHARS" ] && fail "$sk: description is $n chars (limit $DESCRIPTION_LIMIT_CHARS)"
  done
fi
end_check

# ---------------------------------------------------------------------------------------------
begin_check 5 ".codex/config.toml raises project_doc_max_bytes to ≥ $CODEX_REQUIRED_CAP" \
  "Codex concatenates AGENTS.md from the root down to the cwd and stops at project_doc_max_bytes (32 KiB by default), truncating the file that crosses it without any visible warning."
# Largest single file and largest root→dir chain.
max_single=0; max_chain=0; max_chain_dir=.
while IFS= read -r f; do
  [ -n "$f" ] || continue
  in_skill_tree "$f" && continue
  b=$(file_bytes "$f"); [ "$b" -gt "$max_single" ] && max_single=$b
  d=$(dirname "$f"); chain=0; p=$d
  while :; do
    [ -f "$p/AGENTS.md" ] && [ ! -L "$p/AGENTS.md" ] && chain=$((chain + $(file_bytes "$p/AGENTS.md")))
    [ "$p" = "." ] && break
    p=$(dirname "$p")
  done
  if [ "$chain" -gt "$max_chain" ]; then max_chain=$chain; max_chain_dir=$d; fi
done <<EOF
$(find_files AGENTS.md)
EOF
cap=""
if [ -f .codex/config.toml ]; then
  cap=$(sed -n 's/^[[:space:]]*project_doc_max_bytes[[:space:]]*=[[:space:]]*\([0-9_]*\).*/\1/p' .codex/config.toml | tr -d _ | head -1)
fi
needs_cap=0
[ "$max_single" -gt "$CODEX_WARN_BYTES" ] && needs_cap=1
[ "$max_chain" -gt "$CODEX_WARN_BYTES" ] && needs_cap=1
ignored_note=""
if git_ignored .codex/config.toml; then ignored_note=" (.codex/ is git-ignored here; add '!.codex/' or remove the ignore line so the file can be committed)"; fi
if [ ! -f .codex/config.toml ]; then
  if [ $needs_cap -eq 1 ]; then
    if [ -n "$ignored_note" ]; then warn ".codex/config.toml: missing while an AGENTS.md chain reaches $max_chain bytes (dir: $max_chain_dir) — Codex would truncate at $CODEX_DEFAULT_CAP$ignored_note"
    else fail ".codex/config.toml: missing while an AGENTS.md chain reaches $max_chain bytes (dir: $max_chain_dir) — Codex would truncate at $CODEX_DEFAULT_CAP; commit the file with project_doc_max_bytes = $CODEX_REQUIRED_CAP"; fi
  else
    warn ".codex/config.toml: missing; the standard commits it in every repo (largest chain today: $max_chain bytes, under the $CODEX_DEFAULT_CAP default)$ignored_note"
  fi
elif [ -z "$cap" ]; then
  fail ".codex/config.toml: no project_doc_max_bytes line (set it to $CODEX_REQUIRED_CAP)"
elif [ "$cap" -lt "$CODEX_REQUIRED_CAP" ]; then
  if [ $needs_cap -eq 1 ] || [ "$cap" -lt "$max_chain" ]; then
    fail ".codex/config.toml: project_doc_max_bytes = $cap, below $CODEX_REQUIRED_CAP while an AGENTS.md chain reaches $max_chain bytes"
  else
    warn ".codex/config.toml: project_doc_max_bytes = $cap; the standard sets $CODEX_REQUIRED_CAP"
  fi
fi
end_check

# ---------------------------------------------------------------------------------------------
begin_check 6 "Claude hooks and ask-permissions have Codex twins" \
  "A Claude Code hook never runs under Codex. Codex reads .codex/hooks.json with the same schema, so the same scripts should be wired there; a permissions.ask entry needs a .codex/rules prefix_rule with decision=\"prompt\"."
hook_scripts() { # <json file>: basenames of the scripts hook commands run
  # The script is the first word that is a path (`bash scripts/x.sh` -> x.sh), else the first word.
  if command -v jq >/dev/null 2>&1; then
    jq -r '.hooks // {} | to_entries[] | .value[]? | .hooks[]? | .command? // empty' "$1" 2>/dev/null
  else
    grep -o '"command"[[:space:]]*:[[:space:]]*"\([^"\\]\|\\.\)*"' "$1" | sed 's/^"command"[[:space:]]*:[[:space:]]*"//; s/"$//'
  fi | sed 's/\\"//g; s/"//g' |
    awk '{ w = $1; for (i = 1; i <= NF; i++) if ($i ~ /\//) { w = $i; break }; n = split(w, p, "/"); if (p[n] != "") print p[n] }' | sort -u
}
if [ -f .claude/settings.json ]; then
  claude_hooks=$(hook_scripts .claude/settings.json)
  if [ -n "$claude_hooks" ]; then
    ignored_note=""
    git_ignored .codex/hooks.json && ignored_note=" (.codex/ is git-ignored here; the team has to un-ignore it before the twin can be committed)"
    if [ ! -f .codex/hooks.json ]; then
      msg=".codex/hooks.json: missing while .claude/settings.json wires hooks ($(printf '%s' "$claude_hooks" | tr '\n' ' '))$ignored_note"
      if [ -n "$ignored_note" ]; then warn "$msg"; else fail "$msg"; fi
    else
      codex_hooks=$(hook_scripts .codex/hooks.json)
      for h in $claude_hooks; do
        printf '%s\n' "$codex_hooks" | grep -qx "$h" || fail ".codex/hooks.json: does not reference $h, which .claude/settings.json runs"
      done
      for h in $codex_hooks; do
        printf '%s\n' "$claude_hooks" | grep -qx "$h" || warn ".claude/settings.json: does not reference $h, which .codex/hooks.json runs"
      done
    fi
  fi
  if command -v jq >/dev/null 2>&1; then
    asks=$(jq -r '.permissions.ask[]? // empty' .claude/settings.json 2>/dev/null)
  else
    asks=$(tr -d '\n' < .claude/settings.json | grep -o '"ask"[[:space:]]*:[[:space:]]*\[[[:space:]]*"' 2>/dev/null)
  fi
  if [ -n "$asks" ]; then
    if ! ls .codex/rules/*.rules >/dev/null 2>&1 || ! grep -qs 'decision[[:space:]]*=[[:space:]]*"prompt"' .codex/rules/*.rules; then
      msg=".codex/rules/*.rules: no prefix_rule(..., decision=\"prompt\") twin for permissions.ask in .claude/settings.json"
      if git_ignored .codex/rules/x.rules; then warn "$msg (.codex/ is git-ignored here)"; else fail "$msg"; fi
    fi
  fi
fi
end_check

# ---------------------------------------------------------------------------------------------
begin_check 7 "relative paths (with a slash) in backticks inside AGENTS.md files exist (report-only)" \
  "A path the file names and the tree no longer has sends an agent looking for a file that is not there; this is a heuristic, so it never blocks."
while IFS= read -r f; do
  [ -n "$f" ] || continue
  in_skill_tree "$f" && continue
  d=$(dirname "$f")
  # Inline code spans outside fenced blocks; keep spans that look like a single relative path.
  spans=$(awk '
    /^[[:space:]]*(```|~~~)/ { fence = !fence; next }
    fence { next }
    { line = $0
      while (match(line, /`[^`]+`/)) {
        s = substr(line, RSTART + 1, RLENGTH - 2); line = substr(line, RSTART + RLENGTH)
        if (s ~ /^[A-Za-z0-9_.][A-Za-z0-9_.\/-]*(\/|\.[A-Za-z0-9]+)$/ && s ~ /[\/.]/ && s !~ /^\.\.?$/ && s !~ /^(http|www\.)/) print NR "\t" s
      }
    }' "$f")
  [ -n "$spans" ] || continue
  while IFS="$(printf '\t')" read -r ln s; do
    [ -n "$s" ] || continue
    case "$s" in *'*'*|*'<'*|*'>'*|*'{'*|*'$'*) continue;; esac
    # Skip things that are not paths even though they look like one: versions, domains.
    case "$s" in *.app|*.com|*.io|*.dev|*.org|*.net) continue;; esac
    printf '%s' "$s" | grep -Eq '^[0-9]+(\.[0-9]+)+' && continue
    # A bare name (`index.ts`, `knex.raw`) is as often a convention or an identifier as a file.
    case "$s" in */*) ;; *) continue ;; esac
    # Paths into build trees (node_modules/..., .next/) and submodules are outside this tree.
    first=${s%%/*}; skip=0; for pd in $PRUNE_DIRS; do [ "$first" = "$pd" ] && skip=1; done; [ $skip -eq 1 ] && continue
    is_submodule_path "${s%/}" && continue
    [ -e "$d/$s" ] && continue
    [ -e "$s" ] && continue
    # A path that exists nowhere under the root is the finding; one that exists elsewhere is a
    # relative-path imprecision the heuristic cannot judge, so it passes.
    base=$(basename "$s")
    if ! printf '%s\n' "$ALL_FILES" | awk -F/ -v n="$base" '{ for (i = 1; i <= NF; i++) if ($i == n) { f = 1; exit } } END { exit !f }'; then
      warn "$f:$ln: \`$s\` does not exist (relative to $d, the root, or anywhere in the tree)"
    fi
  done <<EOF
$spans
EOF
done <<EOF
$(find_files AGENTS.md)
EOF
end_check

# ---------------------------------------------------------------------------------------------
begin_check 8 "$HUB/README.md exists" \
  "The memory surface every root points agents at: one lesson per file in $HUB/ (schema in waterx-commons/knowledge-hub/SCHEMA.md), with a README that states the format."
if [ ! -f "$HUB/README.md" ]; then
  if [ -f docs/agent-notes/README.md ]; then
    fail "$HUB/README.md: missing; docs/agent-notes/ exists instead — rename it to $HUB/ and point the root AGENTS.md there (the standard names one directory so every repo's lessons can be read as one set)"
  else
    fail "$HUB/README.md: missing (copy harness/templates/docs/knowledge-hub/README.md from waterx-commons, or pass --hub <dir> when the hub lives elsewhere)"
  fi
fi
end_check

echo
echo "summary: $BLOCKING blocking, $ADVISORY advisory"
if [ $BLOCKING -gt 0 ]; then exit 1; fi
exit 0
