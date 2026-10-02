#!/usr/bin/env bash
# check-harness.sh v1.0.0 (WL-2804) — agent-harness layout guard.
#
# Keeps the repository's coding-agent files in the shape both tools read:
# Claude Code loads CLAUDE.md, Codex loads AGENTS.md, so AGENTS.md must be a
# symlink to a real CLAUDE.md beside it (one source, no divergent copies).
# Runs on bash 3.2 with coreutils + git only; no network, no package manager.
#
#   scripts/agent-hooks/check-harness.sh [--root <dir>] [--report-only]
#
# Blocking checks (exit 1 unless --report-only):
#   1. every AGENTS.md is a symlink to CLAUDE.md, and that CLAUDE.md is a real file
#   2. the root CLAUDE.md is <= 24,576 bytes and has no `@path` import lines
#      (Codex renders imports as text and truncates the file at its byte cap)
#   3. every entry under .agents/skills is a symlink to .claude/skills/<name>
#      (or the reverse for a vendored bundle), and every SKILL.md description
#      is <= 1,536 characters
#   4. .codex/config.toml exists and sets project_doc_max_bytes >= 131072
#   5. docs/knowledge-hub/README.md exists (the memory surface the root names)
# Report-only checks (printed, never fail the run):
#   6. the root CLAUDE.md is <= 200 lines
#   7. every backticked relative path in a CLAUDE.md resolves to a file or
#      directory (relative to that file's directory or the repo root)
set -u

ROOT="."
REPORT_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --report-only) REPORT_ONLY=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done
cd "$ROOT" || exit 64
ROOT="$(pwd)"

ROOT_BYTES_LIMIT=24576
ROOT_LINES_LIMIT=200
DESC_LIMIT=1536
CODEX_MIN_BYTES=131072

blocking=0
report=0
fail() { echo "FAIL: $1"; blocking=$((blocking + 1)); }
warn() { echo "WARN: $1"; report=$((report + 1)); }

# Files to inspect: tracked + untracked-but-not-ignored when inside git, else a walk.
list_files() {
  if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$ROOT" ls-files --cached --others --exclude-standard -- "$@"
  else
    find . -path ./node_modules -prune -o -path ./.git -prune -o -type f -print -o -type l -print | sed 's#^\./##'
  fi
}

# 1. AGENTS.md is a symlink to CLAUDE.md; CLAUDE.md is a regular file.
for agents in $(list_files | grep -E '(^|/)AGENTS\.md$' | grep -v '/node_modules/'); do
  dir=$(dirname "$agents")
  if [ ! -L "$agents" ]; then
    fail "$agents is not a symlink; make CLAUDE.md the file and run: ln -s CLAUDE.md $agents"
    continue
  fi
  target=$(readlink "$agents")
  if [ "$target" != "CLAUDE.md" ]; then
    fail "$agents links to '$target'; it must link to CLAUDE.md in the same directory"
  fi
  if [ ! -f "$dir/CLAUDE.md" ] || [ -L "$dir/CLAUDE.md" ]; then
    fail "$dir/CLAUDE.md is missing or is itself a symlink; the canonical file must be a regular CLAUDE.md"
  fi
done

# 2. Root CLAUDE.md size and no @imports. 6. line count (report-only).
if [ -f CLAUDE.md ]; then
  bytes=$(wc -c < CLAUDE.md | tr -d ' ')
  lines=$(wc -l < CLAUDE.md | tr -d ' ')
  if [ "$bytes" -gt "$ROOT_BYTES_LIMIT" ]; then
    fail "CLAUDE.md is $bytes bytes (limit $ROOT_BYTES_LIMIT); move area-specific content to <area>/CLAUDE.md"
  else
    echo "ok: CLAUDE.md is $bytes bytes, $lines lines"
  fi
  if [ "$lines" -gt "$ROOT_LINES_LIMIT" ]; then
    warn "CLAUDE.md is $lines lines (target $ROOT_LINES_LIMIT)"
  fi
  if grep -nE '^@[^ ]' CLAUDE.md >/dev/null 2>&1; then
    fail "CLAUDE.md has @import lines ($(grep -nE '^@[^ ]' CLAUDE.md | head -3 | tr '\n' ' ')); Codex shows them as text — inline the content or use a nested CLAUDE.md"
  fi
else
  fail "no root CLAUDE.md"
fi

# 3. Skills: .agents/skills/<name> <-> .claude/skills/<name>, description length.
if [ -d .agents/skills ]; then
  for entry in .agents/skills/*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    name=$(basename "$entry")
    if [ -L "$entry" ]; then
      case "$(readlink "$entry")" in
        *".claude/skills/$name"|*".claude/skills/$name/") : ;;
        *) fail "$entry links to '$(readlink "$entry")'; expected ../../.claude/skills/$name" ;;
      esac
    elif [ -L ".claude/skills/$name" ]; then
      : # vendored bundle lives under .agents/skills; .claude/skills/<name> is the symlink
    else
      fail "$entry is a real directory with no .claude/skills/$name symlink pointing at it"
    fi
  done
fi
for skill in $(list_files | grep -E '^\.claude/skills/[^/]+/SKILL\.md$'); do
  desc=$(awk 'NR==1 && $0!="---"{exit} NR>1 && $0=="---"{exit} /^description:/{sub(/^description:[ ]*/,""); print}' "$skill")
  n=${#desc}
  if [ "$n" -eq 0 ]; then
    fail "$skill has no frontmatter description"
  elif [ "$n" -gt "$DESC_LIMIT" ]; then
    fail "$skill description is $n chars (limit $DESC_LIMIT)"
  fi
done

# 4. .codex/config.toml raises Codex's project-doc cap.
if [ -f .codex/config.toml ]; then
  cap=$(grep -E '^[[:space:]]*project_doc_max_bytes[[:space:]]*=' .codex/config.toml | head -1 | sed -E 's/.*=[[:space:]]*([0-9]+).*/\1/')
  if [ -z "$cap" ]; then
    fail ".codex/config.toml does not set project_doc_max_bytes (Codex truncates at 32 KiB without it)"
  elif [ "$cap" -lt "$CODEX_MIN_BYTES" ]; then
    fail ".codex/config.toml sets project_doc_max_bytes = $cap; it must be >= $CODEX_MIN_BYTES"
  fi
else
  fail "missing .codex/config.toml (project_doc_max_bytes = $CODEX_MIN_BYTES)"
fi

# 5. Memory surface.
if [ ! -f docs/knowledge-hub/README.md ]; then
  fail "missing docs/knowledge-hub/README.md (the lesson store the root CLAUDE.md points at)"
fi

# 7. Backticked relative paths in every CLAUDE.md resolve (report-only).
for md in $(list_files | grep -E '(^|/)CLAUDE\.md$' | grep -v '/node_modules/'); do
  dir=$(dirname "$md")
  grep -oE '`[A-Za-z0-9_./-]+`' "$md" | tr -d '`' | sort -u | while read -r tok; do
    case "$tok" in
      */*) : ;;
      *.md|*.sh|*.ts|*.rs|*.sol|*.toml|*.json|*.yml|*.yaml|*.mjs|*.lock) : ;;
      *) continue ;;
    esac
    case "$tok" in
      http*|*//*|*..*|.|./|*.rs.bk) continue ;;
    esac
    [ -e "$dir/$tok" ] && continue
    [ -e "$ROOT/$tok" ] && continue
    echo "WARN: $md names \`$tok\`, which does not exist here (fine for an external path; a typo otherwise)"
  done
done

echo
if [ "$blocking" -gt 0 ]; then
  echo "$blocking blocking violation(s)."
  [ "$REPORT_ONLY" -eq 1 ] && { echo "(report-only mode: exit 0)"; exit 0; }
  exit 1
fi
echo "harness layout OK"
exit 0
