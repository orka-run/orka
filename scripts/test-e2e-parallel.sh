#!/usr/bin/env bash
# Run E2E test files in parallel with process isolation.
# Each file gets its own bun process — no shared module cache or env.
# Usage: ./scripts/test-e2e-parallel.sh [--verbose]
#
# Performance budget: warns if total wall time exceeds E2E_BUDGET_MS (default 5000ms).
# Set E2E_BUDGET_MS=0 to disable.
set -euo pipefail

VERBOSE="${1:-}"
E2E_BUDGET_MS="${E2E_BUDGET_MS:-5000}"
TMPDIR_BASE=$(mktemp -d)
trap 'rm -rf "$TMPDIR_BASE"' EXIT
START_MS=$(($(date +%s%N) / 1000000))

files=($(find tests/e2e -name '*.test.ts' | sort))
pids=()
total_pass=0
total_fail=0
total_files=${#files[@]}
failed_files=()

for f in "${files[@]}"; do
  outfile="$TMPDIR_BASE/$(echo "$f" | tr '/' '_').out"
  bun test "$f" > "$outfile" 2>&1 &
  pids+=("$!:$f:$outfile")
done

# Wait for all and collect results
for entry in "${pids[@]}"; do
  IFS=: read -r pid file outfile <<< "$entry"
  if wait "$pid" 2>/dev/null; then
    pass=$(grep -oP '\d+ pass' "$outfile" | grep -oP '\d+' || echo 0)
    total_pass=$((total_pass + pass))
    elapsed=$(grep -oP '\[[\d.]+s\]' "$outfile" | tr -d '[]' || echo "?")
    printf "  ✓ %-55s %s  (%s pass)\n" "$file" "$elapsed" "$pass"
  else
    fail=$(grep -oP '\d+ fail' "$outfile" | grep -oP '\d+' || echo "?")
    pass=$(grep -oP '\d+ pass' "$outfile" | grep -oP '\d+' || echo 0)
    total_pass=$((total_pass + pass))
    total_fail=$((total_fail + fail))
    failed_files+=("$file")
    elapsed=$(grep -oP '\[[\d.]+s\]' "$outfile" | tr -d '[]' || echo "?")
    printf "  ✗ %-55s %s  (%s pass, %s fail)\n" "$file" "$elapsed" "$pass" "$fail"
  fi
done

END_MS=$(($(date +%s%N) / 1000000))
ELAPSED_MS=$((END_MS - START_MS))

echo ""
echo "  ${total_files} files, $((total_pass + total_fail)) tests: ${total_pass} pass, ${total_fail} fail  (${ELAPSED_MS}ms)"

if [ "$E2E_BUDGET_MS" -gt 0 ] && [ "$ELAPSED_MS" -gt "$E2E_BUDGET_MS" ]; then
  echo ""
  echo "  ⚠ E2E performance budget exceeded: ${ELAPSED_MS}ms > ${E2E_BUDGET_MS}ms"
  echo "  Set E2E_BUDGET_MS=0 to disable or E2E_BUDGET_MS=<new_limit> to adjust."
fi

if [ ${#failed_files[@]} -gt 0 ]; then
  echo ""
  echo "  Failed files:"
  for f in "${failed_files[@]}"; do
    echo "    - $f"
    outfile="$TMPDIR_BASE/$(echo "$f" | tr '/' '_').out"
    if [ "$VERBOSE" = "--verbose" ] || [ "$VERBOSE" = "-v" ]; then
      echo ""
      cat "$outfile"
      echo ""
    else
      # Show just the error lines
      grep -A2 'error:' "$outfile" 2>/dev/null | head -10
    fi
  done
  exit 1
fi
