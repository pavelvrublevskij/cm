#!/usr/bin/env bash
# CM — run script
#
# Usage:
#   ./run.sh     # Start the server
#   ./run.sh 1   # Same, non-interactive

set -e

GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=3000
URL="http://127.0.0.1:$PORT"
MIN_NODE=16

IS_WINDOWS=false
if printf '%s' "$OSTYPE" | grep -qE "msys|mingw|cygwin"; then
  IS_WINDOWS=true
fi

print_header() {
    printf "\n"
    printf "${BOLD}${CYAN}╔══════════════════════════════════════════════╗${NC}\n"
    printf "${BOLD}${CYAN}║          CM                                  ║${NC}\n"
    printf "${BOLD}${CYAN}╚══════════════════════════════════════════════╝${NC}\n"
    printf "\n"
}

print_menu() {
    printf "  ${BOLD}1)${NC}  ${GREEN}Start${NC}       Install deps, start server, open browser\n"
    printf "  ${BOLD}2)${NC}  ${RED}Stop${NC}        Stop the running server\n"
    printf "  ${BOLD}3)${NC}  ${CYAN}Update git${NC}  Pull latest from GitHub (requires git)\n"
    printf "  ${BOLD}4)${NC}  ${CYAN}Update zip${NC}  Download latest release zip from GitHub\n"
    printf "\n"
    printf "  ${BOLD}0)${NC}  ${DIM}Exit${NC}\n"
    printf "\n"
}

open_browser() {
    if $IS_WINDOWS; then
        cmd.exe /c "start \"\" $1" >/dev/null 2>&1 &
    elif [ "$(uname)" = "Darwin" ]; then
        open "$1" 2>/dev/null || true
    elif [ "$(uname)" = "Linux" ]; then
        if command -v wslview >/dev/null 2>&1; then
            wslview "$1" 2>/dev/null || true
        elif command -v xdg-open >/dev/null 2>&1; then
            xdg-open "$1" 2>/dev/null || true
        fi
    fi
}

wait_for_url() {
    local target_url="$1"
    local attempts=0
    printf "  Waiting for server"
    while ! curl -s -o /dev/null "$target_url" 2>/dev/null; do
        printf "."
        sleep 1
        attempts=$((attempts + 1))
        if [ "$attempts" -ge 30 ]; then
            printf "\n"
            printf "  ${RED}Server did not respond within 30 seconds.${NC}\n"
            return 1
        fi
    done
    printf " ${GREEN}ready!${NC}\n"
}

do_local_start() {
    printf "${BOLD}${GREEN}▶ Start${NC}\n\n"

    if command -v node >/dev/null 2>&1; then
        NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
        if [ "$NODE_VER" -lt "$MIN_NODE" ]; then
            printf "${RED}Node.js v${MIN_NODE}+ required (found $(node -v))${NC}\n"
            printf "Please update Node.js: https://nodejs.org\n"
            return 1
        fi
        printf "  ${GREEN}✓${NC} Node.js $(node -v)\n"
    else
        printf "${RED}Node.js not found.${NC}\n"
        printf "Install Node.js: https://nodejs.org\n"
        return 1
    fi

    local PID=""
    if $IS_WINDOWS; then
        PID=$(netstat.exe -aon 2>/dev/null | grep "127.0.0.1:$PORT " | grep LISTENING | awk '{print $NF}' | head -1 || true)
        if [ -n "$PID" ]; then
            printf "  Port $PORT in use (PID $PID), stopping previous instance...\n"
            taskkill.exe //PID "$PID" //F >/dev/null 2>&1 || true
            sleep 2
        fi
    elif command -v lsof >/dev/null 2>&1; then
        PID=$(lsof -ti tcp:$PORT 2>/dev/null || true)
    elif command -v ss >/dev/null 2>&1; then
        PID=$(ss -tlnp "sport = :$PORT" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1 || true)
    elif command -v fuser >/dev/null 2>&1; then
        PID=$(fuser $PORT/tcp 2>/dev/null || true)
    fi
    if [ -n "$PID" ] && ! $IS_WINDOWS; then
        printf "  Port $PORT in use (PID $PID), stopping previous instance...\n"
        kill "$PID" 2>/dev/null || true
        sleep 1
    fi

    cd "$SCRIPT_DIR"
    if [ ! -d "node_modules" ]; then
        printf "  Installing dependencies...\n"
        npm install
    else
        printf "  ${GREEN}✓${NC} Dependencies installed\n"
    fi

    printf "\n"

    if $IS_WINDOWS; then
        powershell.exe -command "Start-Process node -ArgumentList 'server.js' -WorkingDirectory '$(pwd -W)' -WindowStyle Hidden"
    else
        nohup node server.js > /dev/null 2>&1 &
    fi

    wait_for_url "$URL" && open_browser "$URL" || true

    printf "\n${GREEN}${BOLD}✓ CM is running at ${URL}${NC}\n"
    printf "  To stop: run ./run.sh 2\n\n"
}

do_stop() {
    printf "${BOLD}${RED}▶ Stop${NC}\n\n"

    local PID=""
    if $IS_WINDOWS; then
        PID=$(netstat.exe -aon 2>/dev/null | grep "127.0.0.1:$PORT " | grep LISTENING | awk '{print $NF}' | head -1 || true)
        if [ -n "$PID" ]; then
            printf "  Stopping server (PID $PID)...\n"
            taskkill.exe //PID "$PID" //F >/dev/null 2>&1 || true
        else
            printf "  Server is not running.\n"
        fi
    elif command -v lsof >/dev/null 2>&1; then
        PID=$(lsof -ti tcp:$PORT 2>/dev/null || true)
    elif command -v ss >/dev/null 2>&1; then
        PID=$(ss -tlnp "sport = :$PORT" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1 || true)
    elif command -v fuser >/dev/null 2>&1; then
        PID=$(fuser $PORT/tcp 2>/dev/null || true)
    fi
    if ! $IS_WINDOWS; then
        if [ -n "$PID" ]; then
            printf "  Stopping server (PID $PID)...\n"
            kill "$PID" 2>/dev/null || true
        else
            printf "  Server is not running.\n"
        fi
    fi
    printf "\n"
}

do_update_git() {
    printf "${BOLD}${CYAN}▶ Update (git)${NC}\n\n"

    if ! command -v git >/dev/null 2>&1; then
        printf "${RED}git is not installed.${NC}\n\n"
        return 1
    fi

    cd "$SCRIPT_DIR"
    printf "  Pulling latest changes...\n"
    git pull
    printf "  Updating dependencies...\n"
    npm install
    printf "\n${GREEN}${BOLD}✓ Update complete. Restart the server to apply changes.${NC}\n\n"
}

do_update_zip() {
    printf "${BOLD}${CYAN}▶ Update (release zip)${NC}\n\n"

    if ! command -v curl >/dev/null 2>&1; then
        printf "${RED}curl is not installed.${NC}\n\n"
        return 1
    fi
    if ! command -v unzip >/dev/null 2>&1; then
        printf "${RED}unzip is not installed.${NC}\n\n"
        return 1
    fi

    local REPO="pavelvrublevskij/cm"
    printf "  Fetching latest release info...\n"
    local ZIP_URL
    ZIP_URL=$(curl -sf "https://api.github.com/repos/$REPO/releases/latest" \
        | grep '"zipball_url"' | head -1 | cut -d'"' -f4 || true)

    if [ -z "$ZIP_URL" ]; then
        printf "  No release found, using main branch...\n"
        ZIP_URL="https://github.com/$REPO/archive/refs/heads/main.zip"
    fi

    local TMP_DIR
    TMP_DIR=$(mktemp -d)

    printf "  Downloading...\n"
    if ! curl -L -o "$TMP_DIR/update.zip" "$ZIP_URL" 2>/dev/null; then
        printf "${RED}Download failed.${NC}\n\n"
        rm -rf "$TMP_DIR"
        return 1
    fi

    printf "  Extracting...\n"
    if ! unzip -q "$TMP_DIR/update.zip" -d "$TMP_DIR/out"; then
        printf "${RED}Extraction failed.${NC}\n\n"
        rm -rf "$TMP_DIR"
        return 1
    fi

    local EXTRACTED
    EXTRACTED=$(find "$TMP_DIR/out" -maxdepth 1 -mindepth 1 -type d | head -1)
    if [ -z "$EXTRACTED" ]; then
        printf "${RED}Could not find extracted directory.${NC}\n\n"
        rm -rf "$TMP_DIR"
        return 1
    fi

    printf "  Copying files...\n"
    cp -r "$EXTRACTED/." "$SCRIPT_DIR/"
    rm -rf "$TMP_DIR"

    cd "$SCRIPT_DIR"
    printf "  Updating dependencies...\n"
    npm install
    printf "\n${GREEN}${BOLD}✓ Update complete. Restart the server to apply changes.${NC}\n\n"
}

# ─── Main ───────────────────────────────────────────────────────────

print_header

CHOICE=$(printf '%s' "${1:-}" | tr -d '\r')

if [ -z "$CHOICE" ]; then
    print_menu
    printf "  ${BOLD}Select option:${NC} "
    read -r CHOICE
    CHOICE=$(printf '%s' "$CHOICE" | tr -d '\r')
    printf "\n"
fi

case "$CHOICE" in
    1) do_local_start ;;
    2) do_stop ;;
    3) do_update_git ;;
    4) do_update_zip ;;
    0) printf "Bye!\n" ;;
    *) printf "${RED}Invalid option: $CHOICE${NC}\n" ;;
esac
