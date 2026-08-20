#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-cloudpanel-pgmanager-helper}"
INSTALL_DIR="${INSTALL_DIR:-/opt/cloudpanel-pgmanager-helper}"
GITHUB_REPO="${GITHUB_REPO:-RaulML20/cloudpanel-pgmanager-helper}"
REPO_BRANCH="${REPO_BRANCH:-main}"
ARCHIVE_URL="${ARCHIVE_URL:-https://github.com/$GITHUB_REPO/archive/refs/heads/$REPO_BRANCH.tar.gz}"

PGMANAGER_HELPER_PORT="${PGMANAGER_HELPER_PORT:-7881}"
PGMANAGER_HELPER_HOST="${PGMANAGER_HELPER_HOST:-0.0.0.0}"
PGMANAGER_HELPER_PUBLIC_HOST="${PGMANAGER_HELPER_PUBLIC_HOST:-}"
PGMANAGER_HELPER_SSL_DIR="${PGMANAGER_HELPER_SSL_DIR:-$INSTALL_DIR/ssl}"
PGMANAGER_HELPER_ALLOWED_ORIGIN="${PGMANAGER_HELPER_ALLOWED_ORIGIN:-}"
PGMANAGER_HELPER_ALLOWED_CLIENT_IPS="${PGMANAGER_HELPER_ALLOWED_CLIENT_IPS:-}"
PGMANAGER_HELPER_CERT_CN="${PGMANAGER_HELPER_CERT_CN:-}"
PGMANAGER_HELPER_CERT_SAN="${PGMANAGER_HELPER_CERT_SAN:-}"
PGMANAGER_HELPER_DATA_DIR="${PGMANAGER_HELPER_DATA_DIR:-/var/lib/cloudpanel-pgmanager-helper}"
ADMINER_ROOT="${ADMINER_ROOT:-/opt/adminer}"
PGMANAGER_ADMINER_PHP_HOST="${PGMANAGER_ADMINER_PHP_HOST:-127.0.0.1}"
PGMANAGER_ADMINER_PHP_PORT="${PGMANAGER_ADMINER_PHP_PORT:-7882}"
PGMANAGER_PHP_BINARY="${PGMANAGER_PHP_BINARY:-php}"
PGMANAGER_DUMP_TEMP_DIR="${PGMANAGER_DUMP_TEMP_DIR:-/var/tmp}"
PGMANAGER_DUMP_TIMEOUT_MS="${PGMANAGER_DUMP_TIMEOUT_MS:-14400000}"
PGMANAGER_MAX_IMPORT_BYTES="${PGMANAGER_MAX_IMPORT_BYTES:-21474836480}"
PGMANAGER_BACKUP_TIMEOUT_MS="${PGMANAGER_BACKUP_TIMEOUT_MS:-14400000}"

# Empty means "not decided yet": the installer asks when it has a terminal and
# otherwise leaves the daily PostgreSQL backups switched off.
PGMANAGER_DAILY_BACKUPS="${PGMANAGER_DAILY_BACKUPS:-}"

while [ "$#" -gt 0 ]; do
    case "$1" in
        --with-daily-backups) PGMANAGER_DAILY_BACKUPS=1 ;;
        --no-daily-backups) PGMANAGER_DAILY_BACKUPS=0 ;;
        -h|--help)
            echo "Usage: install.sh [--with-daily-backups|--no-daily-backups]"
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            echo "Usage: install.sh [--with-daily-backups|--no-daily-backups]" >&2
            exit 1
            ;;
    esac
    shift
done

CLOUDPANEL_ROOT="${CLOUDPANEL_ROOT:-/home/clp/htdocs/app/files}"
CLOUDPANEL_TEMPLATES_DIR="${CLOUDPANEL_TEMPLATES_DIR:-$CLOUDPANEL_ROOT/templates}"
CLOUDPANEL_CACHE_DIR="${CLOUDPANEL_CACHE_DIR:-$CLOUDPANEL_ROOT/var/cache}"
CLOUDPANEL_FILE_OWNER="${CLOUDPANEL_FILE_OWNER:-clp:clp}"
CLOUDPANEL_FILE_MODE="${CLOUDPANEL_FILE_MODE:-770}"
CLOUDPANEL_TPL_SERVICES="${CLOUDPANEL_TPL_SERVICES:-}"
CLOUDPANEL_TPL_DATABASES="${CLOUDPANEL_TPL_DATABASES:-}"
CLOUDPANEL_TPL_NEW_DATABASE="${CLOUDPANEL_TPL_NEW_DATABASE:-}"
CLOUDPANEL_TPL_NEW_DATABASE_USER="${CLOUDPANEL_TPL_NEW_DATABASE_USER:-}"
BACKUP_SUFFIX=".cloudpanel-pgmanager-helper.bak"
BLOCK_MARKER="BEGIN cloudpanel-pgmanager-helper"
APT_UPDATED=0

if [ "$(id -u)" -ne 0 ]; then
    echo "Please run this installer as root." >&2
    exit 1
fi

if ! echo "$PGMANAGER_HELPER_PORT" | grep -Eq '^[0-9]+$' ||
   [ "$PGMANAGER_HELPER_PORT" -lt 1 ] || [ "$PGMANAGER_HELPER_PORT" -gt 65535 ]; then
    echo "PGMANAGER_HELPER_PORT must be a valid TCP port." >&2
    exit 1
fi

if ! echo "$PGMANAGER_ADMINER_PHP_PORT" | grep -Eq '^[0-9]+$' ||
   [ "$PGMANAGER_ADMINER_PHP_PORT" -lt 1 ] || [ "$PGMANAGER_ADMINER_PHP_PORT" -gt 65535 ]; then
    echo "PGMANAGER_ADMINER_PHP_PORT must be a valid TCP port." >&2
    exit 1
fi

if [ "$PGMANAGER_ADMINER_PHP_HOST" != "127.0.0.1" ] && [ "$PGMANAGER_ADMINER_PHP_HOST" != "::1" ]; then
    echo "PGMANAGER_ADMINER_PHP_HOST must be a loopback address." >&2
    exit 1
fi

if [ ! -d "$PGMANAGER_DUMP_TEMP_DIR" ]; then
    echo "PGMANAGER_DUMP_TEMP_DIR must be an existing directory." >&2
    exit 1
fi

if ! echo "$PGMANAGER_DUMP_TIMEOUT_MS" | grep -Eq '^[0-9]+$' ||
   [ "$PGMANAGER_DUMP_TIMEOUT_MS" -lt 60000 ]; then
    echo "PGMANAGER_DUMP_TIMEOUT_MS must be an integer of at least 60000." >&2
    exit 1
fi

if ! echo "$PGMANAGER_MAX_IMPORT_BYTES" | grep -Eq '^[0-9]+$' ||
   [ "$PGMANAGER_MAX_IMPORT_BYTES" -lt 1048576 ]; then
    echo "PGMANAGER_MAX_IMPORT_BYTES must be an integer of at least 1048576." >&2
    exit 1
fi

if [ -z "$PGMANAGER_HELPER_ALLOWED_CLIENT_IPS" ]; then
    echo "PGMANAGER_HELPER_ALLOWED_CLIENT_IPS is required." >&2
    echo 'Example: PGMANAGER_HELPER_ALLOWED_CLIENT_IPS="YOUR_PUBLIC_IP" bash install.sh' >&2
    exit 1
fi

log() {
    printf '\n[%s] %s\n' "$APP_NAME" "$*"
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }
}

apt_update_once() {
    if [ "$APT_UPDATED" -eq 0 ]; then
        apt-get update
        APT_UPDATED=1
    fi
}

check_cloudpanel() {
    for unit in clp-php-fpm.service clp-nginx.service; do
        if [ "$(systemctl show -p LoadState --value "$unit" 2>/dev/null)" != "loaded" ]; then
            echo "CloudPanel service not found: $unit" >&2
            exit 1
        fi
    done

    [ -d "$CLOUDPANEL_TEMPLATES_DIR" ] || {
        echo "CloudPanel templates directory not found: $CLOUDPANEL_TEMPLATES_DIR" >&2
        exit 1
    }
}

check_node_pm2() {
    require_command node
    require_command npm
    require_command pm2
}

check_php() {
    require_command "$PGMANAGER_PHP_BINARY"
    if ! "$PGMANAGER_PHP_BINARY" -r 'exit(version_compare(PHP_VERSION, "7.4.0", ">=") ? 0 : 1);'; then
        echo "PHP 7.4 or newer is required for the Adminer gateway." >&2
        exit 1
    fi
}

php_has_postgresql_driver() {
    "$PGMANAGER_PHP_BINARY" -r \
        'exit((extension_loaded("pdo_pgsql") || extension_loaded("pgsql")) ? 0 : 1);'
}

ensure_php_postgresql_driver() {
    if php_has_postgresql_driver; then
        log "PHP PostgreSQL driver already available"
        return
    fi

    require_command apt-get
    require_command apt-cache

    local php_version package
    php_version="$("$PGMANAGER_PHP_BINARY" -r 'echo PHP_MAJOR_VERSION, ".", PHP_MINOR_VERSION;')"
    if ! echo "$php_version" | grep -Eq '^[0-9]+\.[0-9]+$'; then
        echo "Could not determine the PHP version used by $PGMANAGER_PHP_BINARY." >&2
        exit 1
    fi
    package="php${php_version}-pgsql"

    log "Installing PostgreSQL support for PHP $php_version ($package)"
    apt_update_once
    if ! apt-cache show "$package" >/dev/null 2>&1; then
        echo "No APT package named $package is available for $PGMANAGER_PHP_BINARY." >&2
        echo "Install the pgsql or pdo_pgsql extension for that exact PHP binary, then run this installer again." >&2
        exit 1
    fi
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$package"

    if ! php_has_postgresql_driver; then
        echo "$package was installed, but $PGMANAGER_PHP_BINARY still does not load pgsql or pdo_pgsql." >&2
        echo "Loaded configuration files:" >&2
        "$PGMANAGER_PHP_BINARY" --ini >&2 || true
        exit 1
    fi
    log "PHP PostgreSQL driver installed successfully"
}

ensure_postgresql_dump_tools() {
    # Installing the extension on a server without PostgreSQL is supported.
    # When PostgreSQL is added later, its server package normally installs the
    # matching client package as a dependency.
    if ! command -v pg_lsclusters >/dev/null 2>&1; then
        if command -v pg_dump >/dev/null 2>&1 &&
           command -v pg_restore >/dev/null 2>&1 &&
           command -v psql >/dev/null 2>&1; then
            log "PostgreSQL dump and restore tools already available"
        else
            log "No local PostgreSQL cluster detected; client-tool installation skipped"
        fi
        return
    fi

    require_command apt-get
    require_command apt-cache
    local cluster_version package
    cluster_version="$(pg_lsclusters --no-header 2>/dev/null | awk '$4 == "online" { print $1; exit }')"
    if [ -z "$cluster_version" ]; then
        cluster_version="$(pg_lsclusters --no-header 2>/dev/null | awk 'NR == 1 { print $1 }')"
    fi
    if ! echo "$cluster_version" | grep -Eq '^[0-9]+(\.[0-9]+)?$'; then
        echo "PostgreSQL is present, but its cluster version could not be determined." >&2
        exit 1
    fi
    package="postgresql-client-$cluster_version"

    local all_tools_available=1 tool cluster_major client_major
    for tool in pg_dump pg_restore psql; do
        if [ ! -x "/usr/lib/postgresql/$cluster_version/bin/$tool" ]; then
            all_tools_available=0
        fi
    done
    if [ "$all_tools_available" -ne 1 ] &&
       command -v pg_dump >/dev/null 2>&1 &&
       command -v pg_restore >/dev/null 2>&1 &&
       command -v psql >/dev/null 2>&1; then
        cluster_major="${cluster_version%%.*}"
        client_major="$(pg_dump --version 2>/dev/null | sed -E 's/.* ([0-9]+)(\.[0-9]+)?.*/\1/' || true)"
        if echo "$client_major" | grep -Eq '^[0-9]+$' && [ "$client_major" -ge "$cluster_major" ]; then
            all_tools_available=1
        fi
    fi
    if [ "$all_tools_available" -eq 1 ]; then
        log "PostgreSQL dump and restore tools already available for cluster $cluster_version"
        return
    fi

    log "Installing PostgreSQL dump and restore tools ($package)"
    apt_update_once
    if ! apt-cache show "$package" >/dev/null 2>&1; then
        echo "No APT package named $package is available for the detected PostgreSQL cluster." >&2
        exit 1
    fi
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$package"

    for tool in pg_dump pg_restore psql; do
        if ! command -v "$tool" >/dev/null 2>&1 &&
           [ ! -x "/usr/lib/postgresql/$cluster_version/bin/$tool" ]; then
            echo "$package was installed, but required tool $tool is still unavailable." >&2
            exit 1
        fi
    done
    log "PostgreSQL dump and restore tools installed successfully"
}

detect_public_host() {
    if [ -n "$PGMANAGER_HELPER_PUBLIC_HOST" ]; then
        echo "$PGMANAGER_HELPER_PUBLIC_HOST"
        return
    fi

    curl -fsS https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}'
}

make_subject_alt_name() {
    if echo "$1" | grep -Eq '^[0-9]+(\.[0-9]+){3}$'; then
        echo "IP:$1"
    else
        echo "DNS:$1"
    fi
}

locate_template() {
    local name="$1" signature="$2" override="$3" matches count

    if [ -n "$override" ]; then
        [ -f "$override" ] || { echo "Template override not found: $override" >&2; exit 1; }
        echo "$override"
        return
    fi

    matches="$(grep -rl --include="$name" -F "$signature" "$CLOUDPANEL_TEMPLATES_DIR" 2>/dev/null || true)"
    count="$(printf '%s' "$matches" | grep -c . || true)"

    if [ "$count" -eq 0 ]; then
        echo "Could not locate CloudPanel template '$name' (signature: $signature)." >&2
        echo "Set the corresponding CLOUDPANEL_TPL_* variable explicitly and re-run." >&2
        exit 1
    fi

    if [ "$count" -gt 1 ]; then
        echo "Several CloudPanel templates match '$name':" >&2
        echo "$matches" >&2
        echo "Set the corresponding CLOUDPANEL_TPL_* variable explicitly and re-run." >&2
        exit 1
    fi

    echo "$matches"
}

fetch_app() {
    log "Installing application in $INSTALL_DIR"
    local temporary archive extracted backup
    temporary="$(mktemp -d)"
    archive="$temporary/app.tar.gz"

    curl -fsSL "$ARCHIVE_URL" -o "$archive"
    tar -xzf "$archive" -C "$temporary"
    extracted="$(find "$temporary" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
    [ -n "$extracted" ] || { echo "Unable to extract application archive." >&2; exit 1; }

    if [ -d "$INSTALL_DIR" ] && [ "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 | head -n 1)" ]; then
        backup="${INSTALL_DIR}.bak.$(date +%Y%m%d%H%M%S)"
        mv "$INSTALL_DIR" "$backup"
        log "Previous helper installation moved to $backup"

        if [ -d "$backup/ssl" ]; then
            mkdir -p "$INSTALL_DIR"
            cp -a "$backup/ssl" "$INSTALL_DIR/ssl"
        fi
    fi

    mkdir -p "$INSTALL_DIR"
    cp -a "$extracted"/. "$INSTALL_DIR"
    rm -rf "$temporary"
}

install_node_dependencies() {
    log "Installing production dependencies"
    cd "$INSTALL_DIR"
    npm install --omit=dev
}

write_env_file() {
    local detected_host
    detected_host="$(detect_public_host)"
    [ -n "$detected_host" ] || {
        echo "Unable to detect the server host. Set PGMANAGER_HELPER_PUBLIC_HOST." >&2
        exit 1
    }

    [ -n "$PGMANAGER_HELPER_ALLOWED_ORIGIN" ] || PGMANAGER_HELPER_ALLOWED_ORIGIN="https://${detected_host}:8443"
    [ -n "$PGMANAGER_HELPER_CERT_CN" ] || PGMANAGER_HELPER_CERT_CN="$detected_host"
    [ -n "$PGMANAGER_HELPER_CERT_SAN" ] || PGMANAGER_HELPER_CERT_SAN="$(make_subject_alt_name "$detected_host")"

    log "Writing runtime configuration"
    cat > "$INSTALL_DIR/.env" <<EOF
PGMANAGER_HELPER_PORT=$PGMANAGER_HELPER_PORT
PGMANAGER_HELPER_HOST=$PGMANAGER_HELPER_HOST
PGMANAGER_HELPER_SSL_DIR=$PGMANAGER_HELPER_SSL_DIR
PGMANAGER_HELPER_ALLOWED_ORIGIN=$PGMANAGER_HELPER_ALLOWED_ORIGIN
PGMANAGER_HELPER_ALLOWED_CLIENT_IPS=$PGMANAGER_HELPER_ALLOWED_CLIENT_IPS
PGMANAGER_HELPER_DATA_DIR=$PGMANAGER_HELPER_DATA_DIR
ADMINER_ROOT=$ADMINER_ROOT
PGMANAGER_ADMINER_PHP_HOST=$PGMANAGER_ADMINER_PHP_HOST
PGMANAGER_ADMINER_PHP_PORT=$PGMANAGER_ADMINER_PHP_PORT
PGMANAGER_PHP_BINARY=$PGMANAGER_PHP_BINARY
PGMANAGER_DUMP_TEMP_DIR=$PGMANAGER_DUMP_TEMP_DIR
PGMANAGER_DUMP_TIMEOUT_MS=$PGMANAGER_DUMP_TIMEOUT_MS
PGMANAGER_MAX_IMPORT_BYTES=$PGMANAGER_MAX_IMPORT_BYTES
PGMANAGER_BACKUP_TIMEOUT_MS=$PGMANAGER_BACKUP_TIMEOUT_MS
EOF
    chmod 0600 "$INSTALL_DIR/.env"
}

create_certificate() {
    log "Creating HTTPS certificate"
    mkdir -p "$PGMANAGER_HELPER_SSL_DIR"

    if [ ! -f "$PGMANAGER_HELPER_SSL_DIR/pgmanager-helper.key" ] ||
       [ ! -f "$PGMANAGER_HELPER_SSL_DIR/pgmanager-helper.crt" ]; then
        openssl req -x509 -newkey rsa:2048 -nodes \
            -keyout "$PGMANAGER_HELPER_SSL_DIR/pgmanager-helper.key" \
            -out "$PGMANAGER_HELPER_SSL_DIR/pgmanager-helper.crt" \
            -days 1825 \
            -subj "/CN=$PGMANAGER_HELPER_CERT_CN" \
            -addext "subjectAltName=$PGMANAGER_HELPER_CERT_SAN"
    fi
}

inject_block() {
    local target="$1" block="$2" backup="${1}${BACKUP_SUFFIX}"

    # Backups are insurance only. Reinstall and uninstall always operate on
    # our own marked block in the live template, never restore an old template.
    if ! grep -q "$BLOCK_MARKER" "$target"; then
        cp "$target" "$backup"
        chown "$CLOUDPANEL_FILE_OWNER" "$backup"
        chmod "$CLOUDPANEL_FILE_MODE" "$backup"
    fi

    node "$INSTALL_DIR/tools/patch-template.js" "$target" "$block" "$PGMANAGER_HELPER_PORT"
    chown "$CLOUDPANEL_FILE_OWNER" "$target"
    chmod "$CLOUDPANEL_FILE_MODE" "$target"
    log "Patched: $target"
}

install_templates() {
    log "Patching CloudPanel Twig templates"
    local services_template databases_template new_database_template new_database_user_template
    services_template="$(locate_template 'services.html.twig' 'clp_admin_service_restart' "$CLOUDPANEL_TPL_SERVICES")"
    databases_template="$(locate_template 'databases.html.twig' 'database-server-information' "$CLOUDPANEL_TPL_DATABASES")"
    new_database_template="$(locate_template 'new-database.html.twig' 'site_database_userPassword' "$CLOUDPANEL_TPL_NEW_DATABASE")"
    new_database_user_template="$(locate_template 'new-database-user.html.twig' 'site_database_user_password' "$CLOUDPANEL_TPL_NEW_DATABASE_USER")"
    inject_block "$services_template" "$INSTALL_DIR/blocks/instance-services.html"
    inject_block "$databases_template" "$INSTALL_DIR/blocks/site-databases.html"
    inject_block "$new_database_template" "$INSTALL_DIR/blocks/new-database.html"
    inject_block "$new_database_user_template" "$INSTALL_DIR/blocks/new-database-user.html"
}

configure_firewall() {
    command -v ufw >/dev/null 2>&1 || return
    log "Configuring UFW"

    IFS=',' read -ra ips <<< "$PGMANAGER_HELPER_ALLOWED_CLIENT_IPS"
    for ip in "${ips[@]}"; do
        ip="${ip#"${ip%%[![:space:]]*}"}"
        ip="${ip%"${ip##*[![:space:]]}"}"
        [ -z "$ip" ] || ufw allow from "$ip" to any port "$PGMANAGER_HELPER_PORT" proto tcp comment 'PgManager Helper' || true
    done
    ufw reload || true
}

start_pm2() {
    log "Starting helper with PM2"
    mkdir -p "$ADMINER_ROOT" "$PGMANAGER_HELPER_DATA_DIR"
    chmod 0755 "$ADMINER_ROOT"
    chmod 0700 "$PGMANAGER_HELPER_DATA_DIR"
    cd "$INSTALL_DIR"
    pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
    pm2 start npm --name "$APP_NAME" -- start
    pm2 save
}

configure_pm2_cron() {
    command -v crontab >/dev/null 2>&1 || return

    # PM2's dump is global. If another helper already restores it, adding a
    # second reboot command would only create a race, so leave that owner alone.
    local cron_file pm2_path node_path
    cron_file="$(mktemp)"
    crontab -l 2>/dev/null > "$cron_file" || true

    if ! grep -q 'pm2 resurrect' "$cron_file"; then
        pm2_path="$(command -v pm2)"
        node_path="$(dirname "$(command -v node)")"
        {
            echo '# cloudpanel-pgmanager-helper pm2 start'
            echo "PATH=$node_path:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
            echo "@reboot $pm2_path resurrect &> /dev/null"
            echo '# cloudpanel-pgmanager-helper pm2 end'
        } >> "$cron_file"
        crontab "$cron_file"
    fi

    rm -f "$cron_file"
}

# Daily PostgreSQL backups are optional and entirely self-contained: they add
# one /etc/cron.d file of their own and write only below
# /home/<site-user>/backups/postgresql/. CloudPanel's crons, its rclone setup
# and its backups/databases directory are never read for anything but the
# schedule, and never modified.
configure_postgresql_backup() {
    local answer suggested

    if [ -z "$PGMANAGER_DAILY_BACKUPS" ]; then
        if [ -t 0 ]; then
            # Read-only: this only parses CloudPanel's cron schedule to propose
            # an hour, it never writes to it.
            suggested="$(node -e "console.log(require('$INSTALL_DIR/lib/backup-config').suggestBackupHour())" 2>/dev/null || echo 1)"
            printf '\n[%s] Daily PostgreSQL backups\n' "$APP_NAME"
            echo "  Dumps every managed PostgreSQL database to"
            echo "  /home/<site-user>/backups/postgresql/<database>/<date>/backup.dump so that"
            echo "  the CloudPanel remote backup picks them up with the rest of the site home."
            echo "  Proposed schedule: ${suggested}:00 daily, keeping 7 days. Both are"
            echo "  configurable later from the site's databases page."
            read -r -p "  Enable daily PostgreSQL backups now? [y/N] " answer || answer=""
            case "$answer" in
                [yY]|[yY][eE][sS]) PGMANAGER_DAILY_BACKUPS=1 ;;
                *) PGMANAGER_DAILY_BACKUPS=0 ;;
            esac
        else
            PGMANAGER_DAILY_BACKUPS=0
        fi
    fi

    chmod 0755 "$INSTALL_DIR/bin/backup.js"

    if [ "$PGMANAGER_DAILY_BACKUPS" -ne 1 ]; then
        log "Daily PostgreSQL backups are disabled"
        node "$INSTALL_DIR/bin/backup.js" --disable >/dev/null
        return
    fi

    command -v flock >/dev/null 2>&1 || {
        echo "flock is required for the daily PostgreSQL backups; install util-linux." >&2
        exit 1
    }

    log "Enabling daily PostgreSQL backups"
    node "$INSTALL_DIR/bin/backup.js" --enable >/dev/null
}

restart_cloudpanel() {
    log "Clearing CloudPanel cache and restarting panel services"
    if [ -d "$CLOUDPANEL_CACHE_DIR" ]; then
        find "$CLOUDPANEL_CACHE_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
    fi
    systemctl restart clp-php-fpm
    systemctl restart clp-nginx
}

require_command curl
require_command tar
require_command openssl
require_command systemctl
check_cloudpanel
check_node_pm2
check_php

# Locate first: an incompatible CloudPanel version fails before any file in
# the panel or an existing helper installation is touched.
locate_template 'services.html.twig' 'clp_admin_service_restart' "$CLOUDPANEL_TPL_SERVICES" >/dev/null
locate_template 'databases.html.twig' 'database-server-information' "$CLOUDPANEL_TPL_DATABASES" >/dev/null
locate_template 'new-database.html.twig' 'site_database_userPassword' "$CLOUDPANEL_TPL_NEW_DATABASE" >/dev/null
locate_template 'new-database-user.html.twig' 'site_database_user_password' "$CLOUDPANEL_TPL_NEW_DATABASE_USER" >/dev/null
ensure_php_postgresql_driver
ensure_postgresql_dump_tools
fetch_app
install_node_dependencies
write_env_file
create_certificate
install_templates
configure_firewall
start_pm2
configure_pm2_cron
configure_postgresql_backup
restart_cloudpanel

log "Installation completed"
echo "Adminer helper API: https://$(detect_public_host):$PGMANAGER_HELPER_PORT"
echo "Adminer versions directory: $ADMINER_ROOT"
echo "Open the API URL once and accept its self-signed certificate."
if [ "${PGMANAGER_DAILY_BACKUPS:-0}" -eq 1 ]; then
    echo "Daily PostgreSQL backups: /home/<site-user>/backups/postgresql/<database>/<date>/backup.dump"
    echo "Backup log: /var/log/cloudpanel-pgmanager-helper/backup.log"
fi
