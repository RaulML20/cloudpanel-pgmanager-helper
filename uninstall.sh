#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-cloudpanel-pgmanager-helper}"
INSTALL_DIR="${INSTALL_DIR:-/opt/cloudpanel-pgmanager-helper}"
ADMINER_ROOT="${ADMINER_ROOT:-/opt/adminer}"
PGMANAGER_HELPER_DATA_DIR="${PGMANAGER_HELPER_DATA_DIR:-/var/lib/cloudpanel-pgmanager-helper}"
PGMANAGER_HELPER_PORT="${PGMANAGER_HELPER_PORT:-7881}"
CLOUDPANEL_ROOT="${CLOUDPANEL_ROOT:-/home/clp/htdocs/app/files}"
CLOUDPANEL_TEMPLATES_DIR="${CLOUDPANEL_TEMPLATES_DIR:-$CLOUDPANEL_ROOT/templates}"
CLOUDPANEL_CACHE_DIR="${CLOUDPANEL_CACHE_DIR:-$CLOUDPANEL_ROOT/var/cache}"
CLOUDPANEL_FILE_OWNER="${CLOUDPANEL_FILE_OWNER:-clp:clp}"
CLOUDPANEL_FILE_MODE="${CLOUDPANEL_FILE_MODE:-770}"
BACKUP_SUFFIX=".cloudpanel-pgmanager-helper.bak"
BLOCK_MARKER="BEGIN cloudpanel-pgmanager-helper"
PG_BACKUP_CRON="/etc/cron.d/cloudpanel-pgmanager-helper-postgresql-backup"
PG_BACKUP_LOCK="/run/lock/cloudpanel-pgmanager-helper-backup.lock"
PG_BACKUP_LOG_DIR="/var/log/cloudpanel-pgmanager-helper"
PURGE=0

[ "${1:-}" != "--purge" ] || PURGE=1
[ "$(id -u)" -eq 0 ] || { echo "Please run this uninstaller as root." >&2; exit 1; }

log() { printf '\n[%s] %s\n' "$APP_NAME" "$*"; }

strip_blocks() {
    log "Removing only PgManager template blocks"
    local target

    while IFS= read -r target; do
        [ -z "$target" ] && continue

        if [ -f "$INSTALL_DIR/tools/patch-template.js" ] && command -v node >/dev/null 2>&1; then
            node "$INSTALL_DIR/tools/patch-template.js" "$target" --remove
        else
            echo "Cannot clean automatically; remove the block marked by '$BLOCK_MARKER' from $target" >&2
            continue
        fi

        chown "$CLOUDPANEL_FILE_OWNER" "$target"
        chmod "$CLOUDPANEL_FILE_MODE" "$target"
        log "Cleaned: $target"
    done < <(grep -rl "$BLOCK_MARKER" "$CLOUDPANEL_TEMPLATES_DIR" 2>/dev/null || true)
}

remove_backups() {
    local backup
    while IFS= read -r backup; do
        [ -z "$backup" ] || rm -f "$backup"
    done < <(find "$CLOUDPANEL_TEMPLATES_DIR" -name "*$BACKUP_SUFFIX" 2>/dev/null || true)
}

remove_firewall_rules() {
    command -v ufw >/dev/null 2>&1 || return
    local port rule
    port="$(grep -E '^PGMANAGER_HELPER_PORT=' "$INSTALL_DIR/.env" 2>/dev/null | cut -d= -f2 || true)"
    [ -n "$port" ] || port="$PGMANAGER_HELPER_PORT"

    while ufw status numbered 2>/dev/null | grep -q "$port/tcp.*PgManager Helper"; do
        rule="$(ufw status numbered | grep "$port/tcp.*PgManager Helper" | head -n 1 | sed -E 's/^\[\s*([0-9]+)\].*/\1/')"
        [ -n "$rule" ] || break
        ufw --force delete "$rule" || break
    done
    ufw reload >/dev/null 2>&1 || true
}

# Only the cron entry, lock and log this extension created are removed.
# CloudPanel's own crons are never touched, and the dumps themselves stay where
# they are so a restore is still possible after the extension is gone.
remove_postgresql_backup_cron() {
    [ ! -f "$PG_BACKUP_CRON" ] || {
        rm -f "$PG_BACKUP_CRON"
        log "Removed the daily PostgreSQL backup cron entry"
    }
    rm -f "$PG_BACKUP_LOCK"
    rm -rf "$PG_BACKUP_LOG_DIR"
}

# Dumps live inside each site home, which belongs to the customer, so they are
# never deleted without an explicit answer at the terminal.
remove_postgresql_dumps() {
    local answer directory found=0

    while IFS= read -r directory; do
        [ -z "$directory" ] && continue
        found=1
        break
    done < <(find /home -mindepth 3 -maxdepth 3 -type d -path '/home/*/backups/postgresql' 2>/dev/null || true)

    [ "$found" -eq 1 ] || return

    log "PostgreSQL dumps created by PgManager remain in /home/<site-user>/backups/postgresql/"

    if [ "$PURGE" -ne 1 ] || [ ! -t 0 ]; then
        echo "  They were left untouched. Remove them manually if you no longer need them."
        return
    fi

    read -r -p "  Delete these PostgreSQL dump directories as well? [y/N] " answer || answer=""
    case "$answer" in
        [yY]|[yY][eE][sS]) ;;
        *) echo "  Keeping the PostgreSQL dumps."; return ;;
    esac

    while IFS= read -r directory; do
        [ -z "$directory" ] && continue
        case "$directory" in
            /home/*/backups/postgresql) rm -rf -- "$directory"; log "Removed $directory" ;;
            *) echo "Refusing to remove unexpected directory: $directory" >&2 ;;
        esac
    done < <(find /home -mindepth 3 -maxdepth 3 -type d -path '/home/*/backups/postgresql' 2>/dev/null || true)
}

remove_own_cron() {
    command -v crontab >/dev/null 2>&1 || return
    local cron_file remaining_processes

    # pm2 resurrect restores the global PM2 dump, not just this helper. When
    # another helper/application is still registered, keep this one generic
    # reboot entry: removing it could stop that unrelated service after reboot.
    if command -v pm2 >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
        remaining_processes="$(pm2 jlist 2>/dev/null | node -e '
            let raw = "";
            process.stdin.on("data", (chunk) => raw += chunk);
            process.stdin.on("end", () => {
                const start = raw.indexOf("[");
                if(start === -1) return console.log(0);
                try { console.log(JSON.parse(raw.slice(start)).length); }
                catch(error) { console.log(0); }
            });
        ' 2>/dev/null || echo 0)"

        if [ "${remaining_processes:-0}" -gt 0 ]; then
            log "Keeping the shared PM2 reboot entry because other PM2 applications remain"
            return
        fi
    fi

    cron_file="$(mktemp)"
    crontab -l 2>/dev/null | awk '
        /# cloudpanel-pgmanager-helper pm2 start/ { skip=1; next }
        /# cloudpanel-pgmanager-helper pm2 end/ { skip=0; next }
        skip != 1 { print }
    ' > "$cron_file" || true
    crontab "$cron_file"
    rm -f "$cron_file"
}

if command -v pm2 >/dev/null 2>&1; then
    pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
    pm2 save >/dev/null 2>&1 || true
fi

remove_firewall_rules
strip_blocks
remove_backups
remove_own_cron
remove_postgresql_backup_cron

safe_remove_tree() {
    local target="$1"
    case "$target" in
        ''|'/'|'/opt'|'/var'|'/var/lib'|'/home'|'/home/'*'/backups'|'/home/'*'/backups/'*|"$CLOUDPANEL_ROOT"|"$CLOUDPANEL_TEMPLATES_DIR")
            echo "Refusing to remove unsafe directory: $target" >&2
            exit 1
            ;;
    esac
    rm -rf -- "$target"
}

safe_remove_tree "$INSTALL_DIR"
if [ "$PURGE" -eq 1 ]; then
    safe_remove_tree "$ADMINER_ROOT"
    safe_remove_tree "$PGMANAGER_HELPER_DATA_DIR"
else
    log "Keeping installed Adminer versions and catalogue cache for a future reinstall"
fi

remove_postgresql_dumps

if [ -d "$CLOUDPANEL_CACHE_DIR" ]; then
    find "$CLOUDPANEL_CACHE_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
fi
systemctl restart clp-php-fpm
systemctl restart clp-nginx
log "Uninstall completed"
