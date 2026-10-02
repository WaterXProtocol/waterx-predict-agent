#!/usr/bin/env bash
# waterx-commons/harness/lint/check-harness.sh v1.1.0
#
# Checks a repository against the WaterX agent-harness standard
# (Bucket-Protocol/waterx-commons, harness/STANDARD.md). Repos vendor this file as
# scripts/agent-hooks/check-harness.sh; keep the version line above intact so the
# "vendored copies" job in waterx-commons can tell which version a repo carries.
#
# Usage: check-harness.sh [--root <dir>] [--report-only] [--version] [--help]
#   --root <dir>    repository root to check (default: the git toplevel of the cwd, else cwd)
#   --report-only   print every finding but always exit 0
# Exit 1 when a blocking finding exists (and --report-only is not set), 0 otherwise.
#
# Portability: bash 3.2 (macOS /bin/bash) and up; coreutils, find, grep, awk, sed, git.
# jq is used for hook JSON when present; a grep fallback covers its absence.
set -u

VERSION="1.1.0"
ROOT=""
REPORT_ONLY=0
ROOT_LIMIT_LINES=200
ROOT_LIMIT_BYTES=24576
DESCRIPTION_LIMIT_CHARS=1536
CODEX_DEFAULT_CAP=32768
CODEX_WARN_BYTES=30720
CODEX_REQUIRED_CAP=131072

usage() { sed -n '2,13p' "$0"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT=${2:-}; shift 2 ;;
    --root=*) ROOT=${1#--root=}; shift ;;
    --report-only) REPORT_ONLY=1; shift ;;
    --version) echo "check-harness.sh v$VERSION"; exit 0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
done

if [ -z "$ROOT" ]; then
  ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
fi
ROOT=$(cd "$ROOT" 2>/dev/null && pwd -P) || { echo "root not found: $ROOT" >&2; exit 64; }
cd "$ROOT" || exit 64

BLOCKING=0
ADVISORY=0
CHECK_FINDINGS=0

# Directories never scanned: dependency and build trees, and the git store.
PRUNE_DIRS='.git node_modules target dist build .next vendor .venv'

prune_expr() {
  # Builds the find(1) prune expression from PRUNE_DIRS.
  local first=1 d
  for d in $PRUNE_DIRS; do
    if [ $first -eq 1 ]; then printf -- '-name %s' "$d"; first=0; else printf -- ' -o -name %s' "$d"; fi
  done
}

# find_files <name-pattern> [extra find args]: paths relative to ROOT, pruned, sorted.
find_files() {
  local name=$1; shift
  # shellcheck disable=SC2046
  find . \( $(prune_expr) \) -prune -o -name "$name" "$@" -print 2>/dev/null | sed 's|^\./||' | sort
}

phys() { # physical path of a directory, empty when it does not resolve
  (cd "$1" 2>/dev/null && pwd -P)
}

file_bytes() { wc -c < "$1" | tr -d ' '; }
file_lines() { wc -l < "$1" | tr -d ' '; }

char_count() {
  # Characters, not bytes, when a UTF-8 locale is available; bytes otherwise (conservative).
  local loc
  for loc in C.UTF-8 en_US.UTF-8; do
    if locale -a 2>/dev/null | grep -qi "^${loc}$"; then
      LC_ALL=$loc wc -m | tr -d ' '
      return
    fi
  done
  wc -c | tr -d ' '
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

# A directory under .claude/skills or .agents/skills belongs to check 3/4, not check 1:
# vendored skill bundles ship their own AGENTS.md / CLAUDE.md.
in_skill_tree() { case "$1" in .claude/skills/*|.agents/skills/*|*/.claude/skills/*|*/.agents/skills/*) return 0;; esac; return 1; }

echo "check-harness v$VERSION — root: $ROOT$( [ $REPORT_ONLY -eq 1 ] && printf ' (report-only)')"
echo

# ---------------------------------------------------------------------------------------------
begin_check 1 "CLAUDE.md is canonical; AGENTS.md beside it is a symlink to it" \
  "Claude Code reads CLAUDE.md and ignores AGENTS.md once a CLAUDE.md exists; Codex reads only AGENTS.md. One real file plus a symlink keeps both tools on the same text."
while IFS= read -r f; do
  [ -n "$f" ] || continue
  in_skill_tree "$f" && continue
  d=$(dirname "$f")
  if [ ! -L "$f" ]; then
    fail "$f: is a real file; it must be a symlink to CLAUDE.md in the same directory (fold its text into CLAUDE.md, then: ln -sf CLAUDE.md $f)"
    continue
  fi
  if [ ! -f "$d/CLAUDE.md" ] || [ -L "$d/CLAUDE.md" ]; then
    fail "$d/CLAUDE.md: missing or itself a symlink; CLAUDE.md must be the real file"
    continue
  fi
  target=$(readlink "$f")
  tdir=$(phys "$d/$(dirname "$target")"); ddir=$(phys "$d")
  if [ "$tdir/$(basename "$target")" != "$ddir/CLAUDE.md" ]; then
    fail "$f: symlink points to '$target', not to CLAUDE.md beside it"
  fi
done <<EOF
$(find_files AGENTS.md)
EOF
while IFS= read -r f; do
  [ -n "$f" ] || continue
  in_skill_tree "$f" && continue
  d=$(dirname "$f")
  if [ -L "$f" ]; then
    fail "$f: is a symlink; CLAUDE.md must be the real file (AGENTS.md is the symlink)"
  elif [ ! -e "$d/AGENTS.md" ] && [ ! -L "$d/AGENTS.md" ]; then
    fail "$d: CLAUDE.md has no AGENTS.md symlink beside it, so Codex users never see it (ln -s CLAUDE.md $d/AGENTS.md)"
  fi
done <<EOF
$(find_files CLAUDE.md)
EOF
end_check

# ---------------------------------------------------------------------------------------------
begin_check 2 "root CLAUDE.md ≤ $ROOT_LIMIT_LINES lines, ≤ $ROOT_LIMIT_BYTES bytes, no @path import lines" \
  "The root file loads in every session of both tools; Claude Code's guidance targets <200 lines, Codex truncates silently past its byte cap, and Codex shows a Claude @path import as plain text."
if [ ! -f CLAUDE.md ]; then
  fail "CLAUDE.md: missing at the root (every WaterX repo carries one; AGENTS.md is its symlink)"
else
  lines=$(file_lines CLAUDE.md); bytes=$(file_bytes CLAUDE.md)
  [ "$lines" -gt "$ROOT_LIMIT_LINES" ] && fail "CLAUDE.md: $lines lines (limit $ROOT_LIMIT_LINES); move area-specific text to <area>/CLAUDE.md, .claude/rules/, or a skill"
  [ "$bytes" -gt "$ROOT_LIMIT_BYTES" ] && fail "CLAUDE.md: $bytes bytes (limit $ROOT_LIMIT_BYTES)"
  # An import is a line whose first token is @<path>, outside fenced code blocks.
  imports=$(awk '
    /^[[:space:]]*(```|~~~)/ { fence = !fence; next }
    !fence && $0 ~ /^[[:space:]]*@[A-Za-z0-9_~.\/-]/ { printf "%d:%s\n", NR, $0 }
  ' CLAUDE.md)
  if [ -n "$imports" ]; then
    while IFS= read -r line; do
      fail "CLAUDE.md:$line — @path import line; inline the text or link the file in prose"
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
  if [ -L "$c" ] && [ -L "$a" ]; then fail "$n: both sides are symlinks; one must be the real directory"; continue; fi
  if [ ! -e "$c" ] && [ ! -L "$c" ]; then fail "$a: no .claude/skills/$n beside it, so Claude Code never loads this skill (ln -s ../../.agents/skills/$n $c for a vendored bundle)"; continue; fi
  if [ ! -e "$a" ] && [ ! -L "$a" ]; then fail "$c: no .agents/skills/$n, so Codex never loads this skill (ln -s ../../.claude/skills/$n $a)"; continue; fi
  if [ ! -L "$c" ] && [ ! -L "$a" ]; then fail "$n: two real copies (.claude/skills and .agents/skills); keep one and symlink the other, or the two drift apart"; continue; fi
  if [ -L "$c" ]; then link=$c; real=$a; else link=$a; real=$c; fi
  if [ ! -d "$real" ]; then fail "$real: expected a real directory"; continue; fi
  lp=$(phys "$link"); rp=$(phys "$real")
  if [ -z "$lp" ]; then fail "$link: dangling symlink ($(readlink "$link"))"; continue; fi
  if [ "$lp" != "$rp" ]; then fail "$link: points to $(readlink "$link"), not to $real"; continue; fi
  if [ ! -f "$real/SKILL.md" ]; then fail "$real/SKILL.md: missing"; continue; fi
  if [ -L "$real/SKILL.md" ]; then fail "$real/SKILL.md: is a file symlink; Codex skips symlinked SKILL.md files (symlink the directory instead)"; fi
done
end_check

# ---------------------------------------------------------------------------------------------
begin_check 4 "every .claude/skills/*/SKILL.md and plugins/*/skills/*/SKILL.md has a frontmatter description ≤ $DESCRIPTION_LIMIT_CHARS chars" \
  "Claude Code loads every skill's description into every session and caps it at 1,536 characters; the body loads only on trigger, so the description is what decides whether the skill fires."
# plugins/<plugin>/skills/ is a plugin marketplace's skill tree (waterx-commons itself has one).
if [ -d .claude/skills ] || ls -d plugins/*/skills >/dev/null 2>&1; then
  for s in .claude/skills/*/ plugins/*/skills/*/; do
    [ -d "$s" ] || continue
    sk="${s}SKILL.md"
    [ -f "$sk" ] || { fail "$sk: missing"; continue; }
    fm=$(awk 'NR==1 && $0 != "---" { exit } NR>1 && $0 == "---" { exit } NR>1 { print }' "$sk")
    if [ -z "$fm" ]; then fail "$sk: no YAML frontmatter (needs name + description)"; continue; fi
    desc=$(printf '%s\n' "$fm" | awk '
      /^description:/ { on = 1; sub(/^description:[[:space:]]*/, ""); sub(/^[>|][-+]?[[:space:]]*$/, ""); print; next }
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
    [ -f "$p/CLAUDE.md" ] && chain=$((chain + $(file_bytes "$p/CLAUDE.md")))
    [ "$p" = "." ] && break
    p=$(dirname "$p")
  done
  if [ "$chain" -gt "$max_chain" ]; then max_chain=$chain; max_chain_dir=$d; fi
done <<EOF
$(find_files CLAUDE.md)
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
    if [ -n "$ignored_note" ]; then warn ".codex/config.toml: missing while a CLAUDE.md chain reaches $max_chain bytes (dir: $max_chain_dir) — Codex would truncate at $CODEX_DEFAULT_CAP$ignored_note"
    else fail ".codex/config.toml: missing while a CLAUDE.md chain reaches $max_chain bytes (dir: $max_chain_dir) — Codex would truncate at $CODEX_DEFAULT_CAP; commit the file with project_doc_max_bytes = $CODEX_REQUIRED_CAP"; fi
  else
    warn ".codex/config.toml: missing; the standard commits it in every repo (largest chain today: $max_chain bytes, under the $CODEX_DEFAULT_CAP default)$ignored_note"
  fi
elif [ -z "$cap" ]; then
  fail ".codex/config.toml: no project_doc_max_bytes line (set it to $CODEX_REQUIRED_CAP)"
elif [ "$cap" -lt "$CODEX_REQUIRED_CAP" ]; then
  if [ $needs_cap -eq 1 ] || [ "$cap" -lt "$max_chain" ]; then
    fail ".codex/config.toml: project_doc_max_bytes = $cap, below $CODEX_REQUIRED_CAP while a CLAUDE.md chain reaches $max_chain bytes"
  else
    warn ".codex/config.toml: project_doc_max_bytes = $cap; the standard sets $CODEX_REQUIRED_CAP"
  fi
fi
end_check

# ---------------------------------------------------------------------------------------------
begin_check 6 "Claude hooks and ask-permissions have Codex twins" \
  "A Claude Code hook never runs under Codex. Codex reads .codex/hooks.json with the same schema, so the same scripts should be wired there; a permissions.ask entry needs a .codex/rules prefix_rule with decision=\"prompt\"."
hook_scripts() { # <json file>: basenames of command scripts referenced by hooks
  if command -v jq >/dev/null 2>&1; then
    jq -r '.hooks // {} | to_entries[] | .value[]? | .hooks[]? | .command? // empty' "$1" 2>/dev/null
  else
    grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' "$1" | sed 's/.*:[[:space:]]*"//; s/"$//'
  fi | sed 's/\\"//g; s/"//g' | awk '{ print $1 }' | xargs -n1 basename 2>/dev/null | sort -u
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
    asks=$(grep -c '"ask"' .claude/settings.json 2>/dev/null | grep -v '^0$')
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
begin_check 7 "relative paths in backticks inside CLAUDE.md files exist (report-only)" \
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
    # Without a slash, only a known file extension counts (`knex.raw`, `JSON.stringify` are identifiers).
    case "$s" in
      */*) ;;
      *.md|*.ts|*.tsx|*.js|*.mjs|*.cjs|*.json|*.yml|*.yaml|*.toml|*.sh|*.rs|*.move|*.sql|*.sol|*.py|*.rb|*.txt|*.env|*.example|*.lock|*.html|*.css|*.tf|*.hcl|*.rules) ;;
      *) continue ;;
    esac
    # Paths into pruned trees (node_modules/..., .next/) are outside what the lint sees.
    first=${s%%/*}; skip=0; for pd in $PRUNE_DIRS; do [ "$first" = "$pd" ] && skip=1; done; [ $skip -eq 1 ] && continue
    [ -e "$d/$s" ] && continue
    [ -e "$s" ] && continue
    # A path that exists nowhere under the root is the finding; one that exists elsewhere is a
    # relative-path imprecision the heuristic cannot judge, so it passes.
    base=$(basename "$s")
    # shellcheck disable=SC2046
    if [ -z "$(find . \( $(prune_expr) \) -prune -o -name "$base" -print 2>/dev/null | head -1)" ]; then
      warn "$f:$ln: \`$s\` does not exist (relative to $d, the root, or anywhere in the tree)"
    fi
  done <<EOF
$spans
EOF
done <<EOF
$(find_files CLAUDE.md)
EOF
end_check

# ---------------------------------------------------------------------------------------------
begin_check 8 "docs/knowledge-hub/README.md exists" \
  "The memory surface every root points agents at; lessons live in docs/knowledge-hub/ (one per file, schema in waterx-commons/knowledge-hub/SCHEMA.md) and the README states the format."
if [ ! -f docs/knowledge-hub/README.md ]; then
  if [ -f docs/agent-notes/README.md ]; then
    fail "docs/knowledge-hub/README.md: missing; docs/agent-notes/ exists instead — rename it to docs/knowledge-hub/ and point the root CLAUDE.md there (the standard names one directory so every repo's lessons can be read as one set)"
  else
    fail "docs/knowledge-hub/README.md: missing (copy harness/templates/docs/knowledge-hub/README.md from waterx-commons)"
  fi
fi
end_check

# ---------------------------------------------------------------------------------------------
begin_check 9 "no .claude/settings.local.json is committed" \
  "settings.local.json holds one person's overrides and the approvals Claude Code saves on \"don't ask again\"; committed, it grants those permissions to everyone who clones the repo."
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in .claude/settings.local.json|*/.claude/settings.local.json) ;; *) continue ;; esac
    fail "$f: is tracked by git; remove it from the index (git rm --cached $f) and keep it local; Claude Code puts it in your global git excludes when it creates the file"
  done <<EOF
$(git ls-files -- 'settings.local.json' '*/settings.local.json' 2>/dev/null)
EOF
fi
end_check

echo
echo "summary: $BLOCKING blocking, $ADVISORY advisory"
if [ $BLOCKING -gt 0 ]; then exit 1; fi
exit 0
