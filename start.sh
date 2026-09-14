#!/usr/bin/env bash
#
# Jobber - one-click launcher (Linux / WSL)
# =========================================
# Usage: ./start.sh
#
#   R  restart the server
#   O  open the app in your browser
#   L  tail recent server logs
#   I  (re)install dependencies
#   Q  stop the server and quit
#
set -u

# ---- paths -----------------------------------------------------------------
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$APP_DIR/.jobber-server.pid"
LOG_FILE="$APP_DIR/.jobber-server.log"
cd "$APP_DIR" || exit 1

# ---- colors ----------------------------------------------------------------
C_RST=$'\033[0m'; C_BOLD=$'\033[1m'
C_GRN=$'\033[0;32m'; C_CYN=$'\033[0;36m'
C_YEL=$'\033[1;33m'; C_RED=$'\033[0;31m'

log()  { printf '%b%s%b\n' "${C_GRN}[jobber]${C_RST} " "$*" "$C_RST"; }
ok()   { log "$*"; }
warn() { printf '%b%s%b\n' "${C_YEL}[jobber]${C_RST} " "$*" "$C_RST"; }
err()  { printf '%b%s%b\n' "${C_RED}[jobber]${C_RST} " "$*" "$C_RST"; }
info() { printf '%b%s%b\n' "${C_CYN}[jobber]${C_RST} " "$*" "$C_RST"; }

# ---- config ----------------------------------------------------------------
APP_PORT="${PORT:-}"
if [[ -z "$APP_PORT" ]] && [[ -f "$APP_DIR/.env" ]]; then
    APP_PORT="$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$APP_DIR/.env" | head -n1)"
fi
[[ -n "$APP_PORT" ]] || APP_PORT=5173

OLLAMA_BASE_URL="$(sed -n 's/^[[:space:]]*OLLAMA_BASE_URL[[:space:]]*=[[:space:]]*\(.*\)/\1/p' "$APP_DIR/.env" | tail -n1 | tr -d '\r' | xargs)"
[[ -n "$OLLAMA_BASE_URL" ]] || OLLAMA_BASE_URL="http://127.0.0.1:11434"

# ---- banner ----------------------------------------------------------------
banner() {
    cat <<'EOF'

    ██╗     ██████╗    ██████╗    ██████╗    ███████╗   ██████╗
    ██║    ██╔═══██╗   ██╔══██╗   ██╔══██╗   ██╔════╝   ██╔══██╗
    ██║    ██║   ██║   ██████╔╝   ██████╔╝   █████╗     ██████╔╝
    ██║    ██║   ██║   ██╔══██╗   ██╔══██╗   ██╔══╝     ██╔══██╗
 ██╗██║    ╚██████╔╝   ██████╔╝   ██████╔╝   ███████╗   ██║  ██║
 ╚═╝╚═╝     ╚═════╝    ╚═════╝    ╚═════╝    ╚══════╝   ╚═╝  ╚═╝
  privacy-first, evidence-based resume tailoring (powered by local Ollama)
EOF
}

# ---- runtime helpers --------------------------------------------------------
is_running() {
    [[ -f "$PID_FILE" ]] || return 1
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null)" || return 1
    [[ "$pid" =~ ^[0-9]+$ ]] || return 1
    kill -0 "$pid" 2>/dev/null
}

wait_for_port() {
    local tries=60
    while (( tries > 0 )); do
        if ( exec 3<>"/dev/tcp/127.0.0.1/$APP_PORT" ) 2>/dev/null; then
            return 0
        fi
        tries=$((tries - 1))
        sleep 0.5
    done
    return 1
}

start_server() {
    if is_running; then
        warn "Server is already running (pid $(cat "$PID_FILE"))"
        return
    fi
    info "Starting Jobber on port $APP_PORT ..."
    printf '%s\n' "========== Jobber started $(date '+%F %T') ==========" >> "$LOG_FILE"
    nohup node server/index.js >> "$LOG_FILE" 2>&1 &
    echo "$!" > "$PID_FILE"
    if wait_for_port; then
        ok "Server is up: http://localhost:$APP_PORT"
    else
        err "Server did not become ready within 30s. Check $LOG_FILE"
    fi
}

stop_server() {
    if [[ -f "$PID_FILE" ]]; then
        local pid
        pid="$(cat "$PID_FILE" 2>/dev/null)"
        if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
            info "Stopping server (pid $pid) ..."
            kill "$pid" 2>/dev/null
            for ((i = 0; i < 40; i++)); do
                kill -0 "$pid" 2>/dev/null || break
                sleep 0.25
            done
            if kill -0 "$pid" 2>/dev/null; then
                err "Force-killing server ..."
                kill -9 "$pid" 2>/dev/null
            fi
        fi
        rm -f "$PID_FILE"
    fi
}

restart_server() {
    info "Restarting server ..."
    stop_server
    start_server
}

open_browser() {
    local url="http://localhost:$APP_PORT"
    if grep -qi microsoft /proc/version 2>/dev/null; then
        cmd.exe /c start "" "$url" 2>/dev/null && return 0
    fi
    local b
    for b in xdg-open wslview sensible-browser x-www-browser gnome-open kde-open; do
        if command -v "$b" >/dev/null 2>&1; then
            "$b" "$url" >/dev/null 2>&1 &
            return 0
        fi
    done
    warn "No browser opener found. Open it manually: $url"
}

check_node() {
    if ! command -v node >/dev/null 2>&1; then
        err "Node.js not found. Install Node.js 20+ from https://nodejs.org"
        return 1
    fi
    local major
    major="$(node -e 'process.stdout.write(String(Number(process.versions.node.split(".")[0])))')"
    if (( major < 20 )); then
        err "Found Node $(node --version) - Jobber needs Node.js 20+."
        return 1
    fi
    ok "Node $(node --version) detected (need >= 20)"
}

ensure_deps() {
    if [[ ! -d "$APP_DIR/node_modules" ]]; then
        warn "node_modules missing - running npm install ..."
        npm install >/dev/null || { err "npm install failed."; return 1; }
    fi
}

check_ollama() {
    local hp host port
    hp="${OLLAMA_BASE_URL#*://}"
    hp="${hp%%/*}"
    if [[ "$hp" == *:* ]]; then
        host="${hp%%:*}"; port="${hp##*:}"
    else
        host="$hp"; port=11434
    fi
    if ( exec 3<>"/dev/tcp/$host/$port" ) 2>/dev/null; then
        ok "Ollama reachable at $OLLAMA_BASE_URL"
    else
        warn "Ollama is NOT reachable at $OLLAMA_BASE_URL (is it running?)"
    fi
}

show_status() {
    if is_running; then
        ok "Server RUNNING  (pid $(cat "$PID_FILE"))  ->  http://localhost:$APP_PORT"
    else
        warn "Server STOPPED"
    fi
}

show_logs() {
    if [[ -f "$LOG_FILE" ]]; then
        tail -n 30 "$LOG_FILE"
    else
        warn "No logs yet."
    fi
}

show_menu() {
    echo
    printf '%b\n' "${C_CYN}── MENU ───────────────────────────────────────────${C_RST}"
    printf '%b\n' "  ${C_BOLD}R${C_RST}  restart server"
    printf '%b\n' "  ${C_BOLD}O${C_RST}  open browser"
    printf '%b\n' "  ${C_BOLD}L${C_RST}  show recent logs"
    printf '%b\n' "  ${C_BOLD}I${C_RST}  (re)install dependencies"
    printf '%b\n' "  ${C_BOLD}Q${C_RST}  stop server and quit"
    echo
}

main_loop() {
    local key
    while true; do
        show_status
        show_menu
        printf '%b' "${C_GRN}jobber> ${C_RST}"
        read -r -n1 -s key || break
        echo
        case "$key" in
            r|R) restart_server; open_browser ;;
            o|O) open_browser ;;
            l|L) show_logs ;;
            i|I) ensure_deps ;;
            q|Q) break ;;
            *)  warn "Unknown option '$key'." ;;
        esac
    done
    ok "Goodbye!"
}

cleanup() {
    stop_server
}

main() {
    trap 'cleanup; exit 0' EXIT
    trap 'cleanup; printf "%b\n" "${C_YEL}[jobber] interrupted.${C_RST}"; exit 130' INT TERM

    banner

    [[ "$APP_DIR" == "$(pwd)" ]] || { cd "$APP_DIR" || exit 1; }

    check_node   || exit 1
    ensure_deps  || exit 1
    check_ollama
    start_server
    open_browser
    main_loop
}

main "$@"