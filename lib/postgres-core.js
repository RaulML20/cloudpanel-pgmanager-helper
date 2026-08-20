'use strict';

/*
 * Helpers shared by the HTTPS helper (server.js) and the daily backup runner
 * (bin/backup.js). server.js starts its listener as soon as it is loaded, so
 * the backup entrypoint cannot require it; keeping these functions here means
 * both processes validate identifiers, resolve site users and detect the
 * PostgreSQL cluster in exactly the same way instead of drifting apart.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const execOptions = {
            timeout: options.timeout || 60000,
            maxBuffer: 2 * 1024 * 1024,
            cwd: options.cwd,
            env: options.env || process.env
        };

        if(options.uid !== undefined) execOptions.uid = options.uid;
        if(options.gid !== undefined) execOptions.gid = options.gid;

        const child = execFile(command, args, execOptions, (error, stdout, stderr) => {
            if(error) {
                reject(new Error(`${stdout || ''}${stderr || ''}`.trim() || error.message));
                return;
            }
            resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
        });

        if(options.input !== undefined && child.stdin) child.stdin.end(String(options.input));
    });
}

async function commandExists(command) {
    try {
        await run('sh', ['-c', `command -v ${command}`]);
        return true;
    } catch(error) {
        return false;
    }
}

function getSystemUser(username) {
    try {
        for(const line of fs.readFileSync('/etc/passwd', 'utf8').split('\n')) {
            if(!line) continue;
            const fields = line.split(':');
            if(fields[0] === username) {
                return { username, uid: Number(fields[2]), gid: Number(fields[3]), home: fields[5] };
            }
        }
    } catch(error) {}

    return null;
}

function isSafeDomainName(domainName) {
    return typeof domainName === 'string'
        && domainName.length >= 3
        && domainName.length <= 253
        && /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(domainName)
        && !domainName.includes('..');
}

function isSafeSiteUser(siteUser) {
    return typeof siteUser === 'string' && /^[a-z_][a-z0-9_-]{0,31}$/.test(siteUser);
}

/*
 * CloudPanel places a site's document root below
 * /home/<site-user>/htdocs/<domain>. Resolving the owner on the server keeps
 * the browser from choosing an arbitrary PostgreSQL role and prevents one
 * site page from listing databases belonging to another customer.
 */
function findSiteUserForDomain(domainName) {
    if(!isSafeDomainName(domainName)) throw new ApiError(400, 'Invalid domain name');

    let homeEntries = [];
    try {
        homeEntries = fs.readdirSync('/home', { withFileTypes: true });
    } catch(error) {
        throw new ApiError(500, 'Unable to inspect CloudPanel site users');
    }

    for(const entry of homeEntries) {
        if(!entry.isDirectory() || !isSafeSiteUser(entry.name)) continue;
        const htdocsRoot = path.resolve('/home', entry.name, 'htdocs');
        const documentRoot = path.resolve(htdocsRoot, domainName);
        if(!documentRoot.startsWith(htdocsRoot + path.sep)) continue;

        try {
            if(fs.statSync(documentRoot).isDirectory()) return entry.name;
        } catch(error) {}
    }

    return null;
}

/*
 * The reverse of findSiteUserForDomain: given a site user, list the domains
 * whose document root lives in that home. The backup runner uses it to name
 * the site a database owned by that user belongs to.
 */
function findDomainsForSiteUser(siteUser) {
    if(!isSafeSiteUser(siteUser)) return [];
    const htdocsRoot = path.resolve('/home', siteUser, 'htdocs');
    let entries = [];
    try {
        entries = fs.readdirSync(htdocsRoot, { withFileTypes: true });
    } catch(error) {
        return [];
    }
    return entries
        .filter((entry) => entry.isDirectory() && isSafeDomainName(entry.name))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
}

function isSafePostgresIdentifier(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_]{1,63}$/.test(value);
}

function assertPostgresIdentifier(value, label) {
    value = String(value || '').trim();
    if(!isSafePostgresIdentifier(value)) {
        throw new ApiError(400, `${label} must contain only letters, numbers and underscores (maximum 63 characters)`);
    }
    return value;
}

function quotePostgresIdentifier(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

function quotePostgresLiteral(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

async function detectPostgresCluster() {
    if(!(await commandExists('psql'))) return { installed: false };

    if(await commandExists('pg_lsclusters')) {
        try {
            const { stdout } = await run('pg_lsclusters', ['--no-header'], { timeout: 10000 });
            const clusters = stdout.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
                const fields = line.split(/\s+/);
                return {
                    version: fields[0] || null,
                    name: fields[1] || null,
                    port: Number(fields[2]),
                    status: fields[3] || 'unknown'
                };
            }).filter((cluster) => Number.isInteger(cluster.port));

            if(clusters.length) {
                const cluster = clusters.find((item) => item.status === 'online') || clusters[0];
                return { installed: true, ...cluster };
            }

            // The client tools can be installed without a PostgreSQL server.
            // On Debian/Ubuntu, no pg_lsclusters rows means no local cluster.
            return { installed: false };
        } catch(error) {
            return { installed: true, port: 5432, status: 'unknown' };
        }
    }

    return (await commandExists('postgres'))
        ? { installed: true, port: 5432, status: 'unknown' }
        : { installed: false };
}

function postgresConnection(cluster, databaseName, postgresUser, sql) {
    return run('psql', [
        '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
        '-p', String(cluster.port || 5432), '-d', databaseName
    ], {
        timeout: 15000,
        uid: postgresUser.uid,
        gid: postgresUser.gid,
        input: `${sql}\n`
    });
}

async function queryPostgresDatabaseRows(cluster, postgresUser) {
    const query = [
        "SELECT COALESCE(json_agg(json_build_object('name', datname, 'owner', pg_get_userbyid(datdba)) ORDER BY datname), '[]'::json)",
        'FROM pg_database',
        'WHERE datistemplate = false AND datallowconn = true;'
    ].join(' ');
    const { stdout } = await postgresConnection(cluster, 'postgres', postgresUser, query);
    const rows = JSON.parse(stdout.trim() || '[]');
    return Array.isArray(rows) ? rows : [];
}

function postgresToolEnvironment() {
    return {
        PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        HOME: '/var/lib/postgresql',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        PGAPPNAME: 'cloudpanel-pgmanager-helper',
        PGCONNECT_TIMEOUT: '15'
    };
}

async function resolvePostgresTool(cluster, toolName) {
    if(!['pg_dump', 'pg_restore', 'psql'].includes(toolName)) {
        throw new ApiError(500, 'Unsupported PostgreSQL tool');
    }
    if(cluster.version && /^\d+(?:\.\d+)?$/.test(String(cluster.version))) {
        const versioned = `/usr/lib/postgresql/${cluster.version}/bin/${toolName}`;
        try {
            fs.accessSync(versioned, fs.constants.X_OK);
            return versioned;
        } catch(error) {}
    }
    if(await commandExists(toolName)) return toolName;
    throw new ApiError(409, `PostgreSQL client tool ${toolName} is not installed`);
}

/*
 * Writes JSON that may hold operational details through a temporary file in
 * the same directory, so a reader never observes a half-written registry.
 */
function writeJsonFile(filePath, value) {
    const temporary = `${filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, filePath);
}

/*
 * The registries live in DATA_DIR, which server.js and the backup runner
 * receive from their own configuration; binding them here keeps both readers
 * pointing at the same files.
 */
function createCore(options = {}) {
    const dataDir = options.dataDir || '/var/lib/cloudpanel-pgmanager-helper';
    const postgresSitesFile = path.join(dataDir, 'postgres-sites.json');

    function loadPostgresSites() {
        try {
            const parsed = JSON.parse(fs.readFileSync(postgresSitesFile, 'utf8'));
            if(!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

            const sites = {};
            for(const [domainName, databases] of Object.entries(parsed)) {
                if(!isSafeDomainName(domainName) || !Array.isArray(databases)) continue;
                sites[domainName] = databases.filter((name) => isSafePostgresIdentifier(name));
            }
            return sites;
        } catch(error) {
            return {};
        }
    }

    function savePostgresSites(sites) {
        writeJsonFile(postgresSitesFile, sites);
    }

    return {
        dataDir,
        postgresSitesFile,
        loadPostgresSites,
        savePostgresSites
    };
}

module.exports = {
    ApiError,
    run,
    commandExists,
    getSystemUser,
    isSafeDomainName,
    isSafeSiteUser,
    findSiteUserForDomain,
    findDomainsForSiteUser,
    isSafePostgresIdentifier,
    assertPostgresIdentifier,
    quotePostgresIdentifier,
    quotePostgresLiteral,
    detectPostgresCluster,
    postgresConnection,
    queryPostgresDatabaseRows,
    postgresToolEnvironment,
    resolvePostgresTool,
    writeJsonFile,
    createCore
};
