#!/bin/bash
# Start dashboard dev server with clean Vite cache
set -e

DASHBOARD_DIR="$(dirname "$0")/../packages/dashboard"
LOG_DIR="${HOME}/.orka/logs"
LOG_FILE="${LOG_DIR}/dashboard.log"

mkdir -p "$LOG_DIR"

# Kill existing Vite
pkill -f "vite.*--host" 2>/dev/null || true
sleep 1

# Clean Vite cache
rm -rf "${DASHBOARD_DIR}/node_modules/.vite"

# Start Vite
cd "$DASHBOARD_DIR"
exec bunx vite --host 0.0.0.0 >> "$LOG_FILE" 2>&1
