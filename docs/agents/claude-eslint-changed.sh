#!/usr/bin/env bash
set -euo pipefail

# Claude passes hook input on stdin; this hook only needs repo state.
cat >/dev/null || true

project_dir="${CLAUDE_PROJECT_DIR:-$(pwd)}"

if ! command -v eslint >/dev/null 2>&1; then
  exit 0
fi

has_config=0
for config_path in \
  "$project_dir/eslint.config.js" \
  "$project_dir/eslint.config.cjs" \
  "$project_dir/eslint.config.mjs" \
  "$project_dir/eslint.config.ts" \
  "$project_dir/eslint.config.cts" \
  "$project_dir/eslint.config.mts" \
  "$project_dir/.eslintrc" \
  "$project_dir/.eslintrc.js" \
  "$project_dir/.eslintrc.cjs" \
  "$project_dir/.eslintrc.json" \
  "$project_dir/.eslintrc.yaml" \
  "$project_dir/.eslintrc.yml"
do
  if [ -e "$config_path" ]; then
    has_config=1
    break
  fi
done

if [ "$has_config" -eq 0 ] && [ -f "$project_dir/package.json" ] && grep -q '"eslintConfig"' "$project_dir/package.json"; then
  has_config=1
fi

if [ "$has_config" -eq 0 ]; then
  exit 0
fi

mapfile -t files < <(
  {
    git -C "$project_dir" diff --name-only --diff-filter=ACMR
    git -C "$project_dir" diff --cached --name-only --diff-filter=ACMR
    git -C "$project_dir" ls-files --others --exclude-standard
  } | sort -u | grep -E '\.(cjs|cts|js|jsx|mjs|mts|ts|tsx)$' || true
)

if [ "${#files[@]}" -eq 0 ]; then
  exit 0
fi

if ! (
  cd "$project_dir"
  eslint --no-warn-ignored "${files[@]}"
); then
  echo "ESLint failed on changed files. Fix lint issues before continuing." >&2
  exit 2
fi
