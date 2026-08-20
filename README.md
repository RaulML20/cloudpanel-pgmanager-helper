# CloudPanel PgManager Helper

First integration stage for managing Adminer releases from CloudPanel. It adds
an **Adminer Versions** card to **Admin Area > Instance > Services**, backed by
a root HTTPS helper on port `7881`.

On each site's **Databases** page, PostgreSQL is detected at runtime. When it is
not installed the native page is left unchanged. When present, the native card
is labelled **MariaDB Databases** and a **PostgreSQL Databases** card is added
with the local host, cluster port and databases owned by that site's Linux
user. Databases owned by other site users are never returned to the browser.

The native **New Database** form gains a MariaDB/PostgreSQL selector only while
a local PostgreSQL cluster is available. MariaDB continues through CloudPanel's
original Symfony form; PostgreSQL is created through the helper together with
its login role. The native **New Database User** selector also receives a
separate PostgreSQL option group. Selecting a native database keeps the normal
CloudPanel flow, while selecting PostgreSQL creates the role and applies its
read-only or read/write grants through the helper.

PostgreSQL databases created by the helper are recorded per domain in
`/var/lib/cloudpanel-pgmanager-helper/postgres-sites.json`. This association is
needed because PostgreSQL database owners are database roles and do not
necessarily have the same name as the site's Linux user.

When a site has PostgreSQL databases, its native **Database Users** card is
labelled **MariaDB Database Users** and a separate **PostgreSQL Database
Users** card is added. PostgreSQL rows provide the same three operations:

- Clicking the user opens an inline edit dialog for an optional new password
  and read-only/read-write permissions.
- **Manage** opens the selected database in Adminer without exposing its
  password to JavaScript, the URL, cookies or persistent storage.
- **Delete** confirms first, revokes the role's privileges and then removes the
  role through the helper.

PostgreSQL users are tracked in
`/var/lib/cloudpanel-pgmanager-helper/postgres-users.json`; passwords are never
stored there.

### Adminer and the backend `.env`

The expected backend configuration is exactly:

```text
/home/<site-user>/htdocs/<domain>/config/.env
```

The file must resolve inside the site's document root, belong to its Linux
user and be no larger than 256 KiB. The resolver understands PostgreSQL URLs
(`DATABASE_URL`, `POSTGRES_URL`, `DB_URL`) and the standard `PG*`,
`POSTGRES_*` and `DB_*` field groups. A `DB_CONNECTION`/`DB_DRIVER` value that
names another engine disables the `DB_*` group.

Before Adminer opens, the configured database must exactly match the row that
was clicked and the host/port must point to the detected local cluster. A
60-second, single-use ticket selects the target but contains no credential.
The PHP gateway then resolves the `.env` again on every Adminer request and
keeps the password only in that request's memory. It runs on loopback port
`7882`; only the authenticated Node HTTPS helper on `7881` proxies it.
If the server has no `php` command in `PATH`, set `PGMANAGER_PHP_BINARY` to the
CloudPanel PHP CLI binary before running the installer.
The installer verifies that this exact binary loads `pgsql` or `pdo_pgsql`. If
neither driver is available, it installs the matching `phpX.Y-pgsql` package
through APT and aborts if the module still cannot be loaded.
When a local PostgreSQL cluster exists, the installer likewise verifies
`pg_dump`, `pg_restore` and `psql`, installing the cluster's matching
`postgresql-client-X` package when necessary.

### Per-database environment variable names

Each PostgreSQL database row has a **Settings** action. Its modal
can map a connection URL, host, port, user, password and database name to the
exact variable names used by that backend, such as `PG_DATABASE_PROD`. Empty
fields retain the automatic `DATABASE_URL`, `PG*`, `POSTGRES_*` and PostgreSQL
`DB_*` conventions. If a custom URL variable is supplied, it is used alone;
the helper never mixes it with the separate fields or automatic guesses.

Mappings are per domain and database so production/staging databases can use
different conventions. Only variable names are stored in
`/var/lib/cloudpanel-pgmanager-helper/postgres-env-mappings.json` (mode 0600),
never their values or passwords. The modal's diagnostic is also redacted: it
reports the selected source and connection metadata, but only says whether a
password was found.

### Server-side export and import

Each PostgreSQL row also provides **Export** and **Import** actions. Export uses
the client tools belonging to the detected cluster and produces a compressed
custom-format dump with `pg_dump --no-owner --no-privileges`. The dump is
created outside the web root and downloaded only after `pg_dump` succeeds.

Import accepts PostgreSQL custom/tar archives and plain SQL. Archives are
restored with `pg_restore --clean --if-exists --no-owner --no-privileges`;
plain files are passed to `psql` with `ON_ERROR_STOP`. The process authenticates
as the application database user resolved from that database's `.env`, never
as the PostgreSQL superuser. Its password is supplied only through the child
process environment and is never placed in arguments, files, responses or
logs. The connection is tested before the upload, its role must own the target
database and superuser connections are refused. Existing managed-user
permissions are refreshed after a successful restore.

PostgreSQL archives can contain executable SQL, so imports must come from a
trusted source. Plain SQL imports additionally reject psql commands capable of
running programs or reading/writing server files; only the `\restrict`,
`\unrestrict` and COPY-data terminator commands emitted by `pg_dump` are
accepted.

Uploads are streamed to a private temporary directory rather than buffered in
Node or PHP. `PGMANAGER_MAX_IMPORT_BYTES` defaults to 20 GiB,
`PGMANAGER_DUMP_TIMEOUT_MS` to four hours and `PGMANAGER_DUMP_TEMP_DIR` to
`/var/tmp`. Temporary files are deleted after every operation; stale files
from an interrupted process are removed on the next operation. Only one dump
operation can run per database at a time.

### Daily backups

CloudPanel's remote backup copies each site home, but it only dumps MariaDB.
The helper can add a daily PostgreSQL dump inside that same home so the
existing remote backup carries it away without any change to CloudPanel.

Dumps are written to
`/home/<site-user>/backups/postgresql/<database>/<YYYY-MM-DD>/backup.dump`.
CloudPanel's own `backups/databases/` directory is treated as off limits and is
never read, written or deleted; rclone is never invoked, and CloudPanel's
crons, remotes, filters and retention are never modified. Removing the
extension leaves CloudPanel working exactly as before.

Each database is dumped with `pg_dump --format=custom --no-owner
--no-privileges` running as the `postgres` system user, so no password is ever
placed in arguments, in the environment or in a log. `pg_dump` writes to
`.backup.dump.tmp` in the destination directory and the file is renamed to
`backup.dump` only after it exits successfully, so a partial dump is never
visible as a valid backup. A failing database has its temporary file removed,
its error logged, and does not stop the remaining databases.

Databases reach the schedule through the site associations the extension
already maintains: ownership by a site user, or the domain/database registry.
A database belonging to no site is skipped and logged rather than backed up to
a shared location.

Retention defaults to seven days and is applied per database, only after that
day's dump succeeded, so a failed database keeps its older backups. Only dated
directories directly below that database's own directory can be deleted.

The runner is scheduled from its own
`/etc/cron.d/cloudpanel-pgmanager-helper-postgresql-backup`, wrapped in
`flock` so two runs never overlap. The installer reads CloudPanel's cron
schedule to place the dump two hours before the remote backup, falling back to
01:00 when it cannot be determined reliably. Writing the cron file is
idempotent: reinstalling never duplicates an entry.

The schedule and the retention window apply to every managed database on the
instance, so they are edited from the **PostgreSQL Daily Backups** card in
**Admin Area > Backups**, below CloudPanel's own Remote Backup settings. The
same card lists the last result and size of every database across all sites.
Activity is logged to `/var/log/cloudpanel-pgmanager-helper/backup.log`.

That card is the only optional patch: if the Remote Backup template cannot be
located, the installer logs it and continues, and the schedule stays reachable
through `bin/backup.js`. Set `CLOUDPANEL_TPL_REMOTE_BACKUP` to point at the
template explicitly.

```bash
# Run a backup immediately
flock -n /run/lock/cloudpanel-pgmanager-helper-backup.lock \
    node /opt/cloudpanel-pgmanager-helper/bin/backup.js

# Inspect the current schedule and last results
node /opt/cloudpanel-pgmanager-helper/bin/backup.js --status
```

## PostgreSQL API

All routes use the same IP, Origin and CloudPanel administrator-session checks
as the Adminer catalogue.

| Method and path | Purpose |
|---|---|
| `GET /api/postgresql?domainName=...` | Detect the cluster and list the site's databases |
| `GET /api/postgresql/mapping?domainName=...&databaseName=...` | Read one database's variable-name mapping and redacted diagnostic |
| `POST /api/postgresql/mapping` | Save one database's variable-name mapping |
| `POST /api/postgresql/databases` | Create a database and its first login role |
| `POST /api/postgresql/databases/delete` | Terminate its active sessions and delete a site database |
| `POST /api/postgresql/export-ticket` | Issue a session-bound, one-use database export ticket |
| `GET /api/postgresql/export?ticket=...` | Generate and download a custom PostgreSQL dump |
| `POST /api/postgresql/import?domainName=...&databaseName=...` | Stream and restore a PostgreSQL dump or plain SQL file |
| `POST /api/postgresql/users` | Create a login role and grant access to one site database |
| `POST /api/postgresql/users/update` | Change a managed role's password or permissions |
| `POST /api/postgresql/users/delete` | Revoke and remove a managed role |
| `POST /api/postgresql/adminer-ticket` | Validate the `.env` and issue a one-use Adminer target ticket |
| `GET /api/postgresql/backup-settings` | Read the instance-wide daily backup schedule and the last result of every database |
| `POST /api/postgresql/backup-settings` | Save the schedule and retention, rewriting only PgManager's own cron file |

Passwords are delivered to `psql` through standard input and are never placed
in process arguments or written to the helper's registry.

The database and database-user actions are shared between both engines. When
MariaDB has databases, CloudPanel's native forms remain in charge and the
database selector redirects PostgreSQL submissions to the helper. If a site
has only PostgreSQL databases and CloudPanel refuses to render its native user
form, the same **Add Database User** action opens a PostgreSQL modal instead.

## Safe template integration

The installer never replaces a CloudPanel template. It locates each template by
a signature of its own markup and injects the matching file from `blocks/`
immediately before that template's final Twig `endblock`: the site databases
page, the two database forms, `services.html.twig` for the Adminer catalogue
and the Remote Backup page for the daily backup schedule. The injected region
has unique markers:

```twig
{# BEGIN cloudpanel-pgmanager-helper #}
...
{# END cloudpanel-pgmanager-helper #}
```

Reinstalling first removes the previous marked region and then adds its new
copy, so blocks never stack. Uninstalling removes only that region from the
live template; it does not restore an old template and therefore does not erase
CloudPanel updates or changes made by other helpers. Its backup name, PM2 name,
port, data directories, firewall comment and cron markers are also unique.

## Installation

Once this directory is published as `RaulML20/cloudpanel-pgmanager-helper`:

```bash
curl -fsSL https://raw.githubusercontent.com/RaulML20/cloudpanel-pgmanager-helper/main/install.sh -o install.sh
PGMANAGER_HELPER_ALLOWED_CLIENT_IPS="YOUR_PUBLIC_IP" bash install.sh
```

The installer asks whether to enable the daily PostgreSQL backups. Pass
`--with-daily-backups` or `--no-daily-backups` to answer in advance; without a
terminal and without a flag they stay disabled. Re-running the installer never
overwrites a schedule changed from the panel.

Use `GITHUB_REPO=owner/repository` when publishing it under another repository
name. The CloudPanel URL is detected automatically; it can be overridden with
`PGMANAGER_HELPER_ALLOWED_ORIGIN` and `PGMANAGER_HELPER_PUBLIC_HOST`.

After installation, visit `https://SERVER:7881` once and accept the generated
self-signed certificate.

## Uninstallation

```bash
bash /opt/cloudpanel-pgmanager-helper/uninstall.sh
bash /opt/cloudpanel-pgmanager-helper/uninstall.sh --purge
```

The normal mode keeps installed Adminer versions and the GitHub catalogue
cache for a later reinstall. `--purge` removes those as well.

Both modes remove only the cron entry, lock and log the extension created, and
leave CloudPanel's crons untouched. Existing PostgreSQL dumps inside the site
homes are never deleted automatically; `--purge` offers to remove them only
after an explicit confirmation at the terminal.
