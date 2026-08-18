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
| `POST /api/postgresql/users` | Create a login role and grant access to one site database |
| `POST /api/postgresql/users/update` | Change a managed role's password or permissions |
| `POST /api/postgresql/users/delete` | Revoke and remove a managed role |
| `POST /api/postgresql/adminer-ticket` | Validate the `.env` and issue a one-use Adminer target ticket |

Passwords are delivered to `psql` through standard input and are never placed
in process arguments or written to the helper's registry.

The database and database-user actions are shared between both engines. When
MariaDB has databases, CloudPanel's native forms remain in charge and the
database selector redirects PostgreSQL submissions to the helper. If a site
has only PostgreSQL databases and CloudPanel refuses to render its native user
form, the same **Add Database User** action opens a PostgreSQL modal instead.

## Safe template integration

The installer never replaces a CloudPanel template. It locates the current
`services.html.twig` and injects `blocks/instance-services.html` immediately
before its final Twig `endblock`. The injected region has unique markers:

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
