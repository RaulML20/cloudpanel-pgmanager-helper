'use strict';

const https = require('https');
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '.env') });

const PORT = Number(process.env.PGMANAGER_HELPER_PORT || 7881);
const HOST = process.env.PGMANAGER_HELPER_HOST || '0.0.0.0';
const SESSION_DIR = process.env.PGMANAGER_HELPER_SESSION_DIR || '/home/clp/htdocs/app/files/var/sessions';
const SESSION_COOKIE_NAME = process.env.PGMANAGER_HELPER_SESSION_COOKIE_NAME || 'cloudpanel';
const MAX_SESSION_AGE_SECONDS = Number(process.env.PGMANAGER_HELPER_MAX_SESSION_AGE_SECONDS || (24 * 60 * 60));
const ALLOWED_ORIGIN = process.env.PGMANAGER_HELPER_ALLOWED_ORIGIN || '';
const ALLOWED_CLIENT_IPS = new Set(
    (process.env.PGMANAGER_HELPER_ALLOWED_CLIENT_IPS || '')
        .split(',')
        .map((ip) => ip.trim())
        .filter(Boolean)
);
const SSL_DIR = process.env.PGMANAGER_HELPER_SSL_DIR || '/opt/cloudpanel-pgmanager-helper/ssl';
const ADMINER_ROOT = process.env.ADMINER_ROOT || '/opt/adminer';
const DATA_DIR = process.env.PGMANAGER_HELPER_DATA_DIR || '/var/lib/cloudpanel-pgmanager-helper';
const CATALOG_CACHE_FILE = path.join(DATA_DIR, 'releases-cache.json');
const POSTGRES_SITES_FILE = path.join(DATA_DIR, 'postgres-sites.json');
const POSTGRES_USERS_FILE = path.join(DATA_DIR, 'postgres-users.json');
const POSTGRES_MAPPINGS_FILE = path.join(DATA_DIR, 'postgres-env-mappings.json');
const CATALOG_TTL_SECONDS = Number(process.env.PGMANAGER_HELPER_CATALOG_TTL_SECONDS || 86400);
const GITHUB_API_URL = 'https://api.github.com/repos/vrana/adminer/releases?per_page=30';
const GITHUB_DOWNLOAD_BASE = 'https://github.com/vrana/adminer/releases/download';
const INSTALL_TIMEOUT = Number(process.env.PGMANAGER_HELPER_INSTALL_TIMEOUT_MS || 360000);
const ADMINER_PHP_HOST = process.env.PGMANAGER_ADMINER_PHP_HOST || '127.0.0.1';
const ADMINER_PHP_PORT = Number(process.env.PGMANAGER_ADMINER_PHP_PORT || 7882);
const PHP_BINARY = process.env.PGMANAGER_PHP_BINARY || 'php';
const DUMP_TEMP_DIR = process.env.PGMANAGER_DUMP_TEMP_DIR || '/var/tmp';
const DUMP_TIMEOUT = Number(process.env.PGMANAGER_DUMP_TIMEOUT_MS || (4 * 60 * 60 * 1000));
const MAX_IMPORT_BYTES = Number(process.env.PGMANAGER_MAX_IMPORT_BYTES || (20 * 1024 * 1024 * 1024));
const operations = new Set();
const adminerTickets = new Map();
const dumpTickets = new Map();
const databaseOperations = new Set();

if(process.getuid && process.getuid() !== 0) {
    console.error('CloudPanel PgManager Helper must run as root.');
    process.exit(1);
}

if(!ALLOWED_ORIGIN) {
    console.error('PGMANAGER_HELPER_ALLOWED_ORIGIN is required.');
    process.exit(1);
}

if(!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    console.error('PGMANAGER_HELPER_PORT must be a valid TCP port.');
    process.exit(1);
}

if(!Number.isInteger(ADMINER_PHP_PORT) || ADMINER_PHP_PORT < 1 || ADMINER_PHP_PORT > 65535) {
    console.error('PGMANAGER_ADMINER_PHP_PORT must be a valid TCP port.');
    process.exit(1);
}

if(!['127.0.0.1', '::1'].includes(ADMINER_PHP_HOST)) {
    console.error('PGMANAGER_ADMINER_PHP_HOST must be a loopback address.');
    process.exit(1);
}

if(!Number.isSafeInteger(DUMP_TIMEOUT) || DUMP_TIMEOUT < 60000) {
    console.error('PGMANAGER_DUMP_TIMEOUT_MS must be an integer of at least 60000.');
    process.exit(1);
}

if(!Number.isSafeInteger(MAX_IMPORT_BYTES) || MAX_IMPORT_BYTES < 1024 * 1024) {
    console.error('PGMANAGER_MAX_IMPORT_BYTES must be an integer of at least 1048576.');
    process.exit(1);
}

try {
    const dumpTempStat = fs.statSync(fs.realpathSync(DUMP_TEMP_DIR));
    if(!dumpTempStat.isDirectory()) throw new Error('not a directory');
} catch(error) {
    console.error(`PGMANAGER_DUMP_TEMP_DIR is not an accessible directory: ${DUMP_TEMP_DIR}`);
    process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(ADMINER_ROOT, { recursive: true, mode: 0o755 });
fs.chmodSync(DATA_DIR, 0o700);
fs.chmodSync(ADMINER_ROOT, 0o755);

class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function normalizeClientIp(ip) {
    if(!ip) return '';
    return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function validateClientIp(req) {
    const clientIp = normalizeClientIp(req.socket.remoteAddress);

    if(ALLOWED_CLIENT_IPS.size === 0) {
        return { ok: false, reason: 'No allowed client IPs configured' };
    }

    if(!ALLOWED_CLIENT_IPS.has(clientIp)) {
        return { ok: false, reason: `IP not allowed: ${clientIp || 'unknown'}` };
    }

    return { ok: true };
}

function getCookieValue(cookieHeader, name) {
    if(!cookieHeader) return null;

    for(const cookie of cookieHeader.split(';')) {
        const [rawName, ...rawValue] = cookie.trim().split('=');
        if(rawName === name) return decodeURIComponent(rawValue.join('='));
    }

    return null;
}

function validateCloudPanelSession(req, options = {}) {
    if(options.requireOrigin !== false && req.headers.origin !== ALLOWED_ORIGIN) {
        return { ok: false, reason: 'Invalid origin' };
    }

    const sessionId = getCookieValue(req.headers.cookie, SESSION_COOKIE_NAME);
    if(!sessionId) return { ok: false, reason: 'Missing session cookie' };
    if(!/^[a-zA-Z0-9,-]{16,128}$/.test(sessionId)) return { ok: false, reason: 'Invalid session id' };

    const normalizedSessionDir = path.resolve(SESSION_DIR);
    const sessionFile = path.resolve(SESSION_DIR, `sess_${sessionId}`);
    if(!sessionFile.startsWith(normalizedSessionDir + path.sep)) return { ok: false, reason: 'Invalid session path' };
    if(!fs.existsSync(sessionFile)) return { ok: false, reason: 'Session not found' };

    const stat = fs.statSync(sessionFile);
    if((Date.now() - stat.mtimeMs) / 1000 > MAX_SESSION_AGE_SECONDS) {
        return { ok: false, reason: 'Session expired' };
    }

    const content = fs.readFileSync(sessionFile, 'utf8');
    if(!content.includes('_security_main') || !content.includes('PostAuthenticationToken')) {
        return { ok: false, reason: 'Not authenticated' };
    }
    if(!content.includes('ROLE_ADMIN')) return { ok: false, reason: 'Admin role required' };

    return { ok: true, sessionId };
}

function isSafeVersion(version) {
    return typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version);
}

function compareVersionsDesc(a, b) {
    const left = a.split('.').map(Number);
    const right = b.split('.').map(Number);

    for(let index = 0; index < 3; index++) {
        if(left[index] !== right[index]) return right[index] - left[index];
    }

    return 0;
}

function adminerPath(version) {
    return path.join(ADMINER_ROOT, `adminer-${version}.php`);
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

async function phpPostgresqlDriverAvailable() {
    try {
        await run(PHP_BINARY, [
            '-r',
            'exit((extension_loaded("pdo_pgsql") || extension_loaded("pgsql")) ? 0 : 1);'
        ], { timeout: 10000 });
        return true;
    } catch(error) {
        return false;
    }
}

async function assertPhpPostgresqlDriver() {
    if(await phpPostgresqlDriverAvailable()) return;
    throw new ApiError(409,
        `PHP binary ${PHP_BINARY} does not load pgsql or pdo_pgsql. Re-run the PgManager installer to install its PHP PostgreSQL dependency.`);
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
        if(!entry.isDirectory() || !/^[a-z_][a-z0-9_-]{0,31}$/.test(entry.name)) continue;
        const htdocsRoot = path.resolve('/home', entry.name, 'htdocs');
        const documentRoot = path.resolve(htdocsRoot, domainName);
        if(!documentRoot.startsWith(htdocsRoot + path.sep)) continue;

        try {
            if(fs.statSync(documentRoot).isDirectory()) return entry.name;
        } catch(error) {}
    }

    return null;
}

function loadPostgresSites() {
    try {
        const parsed = JSON.parse(fs.readFileSync(POSTGRES_SITES_FILE, 'utf8'));
        if(!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

        const sites = {};
        for(const [domainName, databases] of Object.entries(parsed)) {
            if(!isSafeDomainName(domainName) || !Array.isArray(databases)) continue;
            sites[domainName] = databases.filter((name) => typeof name === 'string' && /^[A-Za-z0-9_]{1,63}$/.test(name));
        }
        return sites;
    } catch(error) {
        return {};
    }
}

function savePostgresSites(sites) {
    const temporary = `${POSTGRES_SITES_FILE}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(sites, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, POSTGRES_SITES_FILE);
}

function registerPostgresDatabase(domainName, databaseName) {
    const sites = loadPostgresSites();
    const databases = new Set(Array.isArray(sites[domainName]) ? sites[domainName] : []);
    databases.add(databaseName);
    sites[domainName] = [...databases].sort((a, b) => a.localeCompare(b));
    savePostgresSites(sites);
}

function unregisterPostgresDatabase(domainName, databaseName) {
    const sites = loadPostgresSites();
    sites[domainName] = (sites[domainName] || []).filter((name) => name !== databaseName);
    savePostgresSites(sites);
}

function loadPostgresUsers() {
    try {
        const parsed = JSON.parse(fs.readFileSync(POSTGRES_USERS_FILE, 'utf8'));
        if(!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const sites = {};

        for(const [domainName, users] of Object.entries(parsed)) {
            if(!isSafeDomainName(domainName) || !Array.isArray(users)) continue;
            sites[domainName] = users.filter((item) => item
                && isSafePostgresIdentifier(item.userName)
                && isSafePostgresIdentifier(item.databaseName)
                && ['read_only', 'read_write'].includes(item.permissions));
        }
        return sites;
    } catch(error) {
        return {};
    }
}

function savePostgresUsers(users) {
    const temporary = `${POSTGRES_USERS_FILE}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(users, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, POSTGRES_USERS_FILE);
}

function registerPostgresUser(domainName, databaseName, userName, permissions) {
    const sites = loadPostgresUsers();
    const users = Array.isArray(sites[domainName]) ? sites[domainName] : [];
    const withoutExisting = users.filter((item) => item.userName !== userName);
    withoutExisting.push({ userName, databaseName, permissions });
    withoutExisting.sort((a, b) => a.userName.localeCompare(b.userName));
    sites[domainName] = withoutExisting;
    savePostgresUsers(sites);
}

function unregisterPostgresUser(domainName, userName) {
    const sites = loadPostgresUsers();
    sites[domainName] = (sites[domainName] || []).filter((item) => item.userName !== userName);
    savePostgresUsers(sites);
}

function unregisterPostgresDatabaseUsers(domainName, databaseName) {
    const sites = loadPostgresUsers();
    const removed = (sites[domainName] || []).filter((item) => item.databaseName === databaseName);
    sites[domainName] = (sites[domainName] || []).filter((item) => item.databaseName !== databaseName);
    if(!sites[domainName].length) delete sites[domainName];
    savePostgresUsers(sites);
    return removed;
}

const POSTGRES_MAPPING_FIELDS = ['url', 'host', 'port', 'user', 'password', 'dbname'];

function isSafeEnvironmentName(value) {
    return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function emptyPostgresMapping() {
    return { url: null, host: null, port: null, user: null, password: null, dbname: null };
}

function loadPostgresMappings() {
    try {
        const parsed = JSON.parse(fs.readFileSync(POSTGRES_MAPPINGS_FILE, 'utf8'));
        if(!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        return parsed;
    } catch(error) {
        return {};
    }
}

function getPostgresMapping(domainName, databaseName) {
    const stored = loadPostgresMappings();
    const candidate = stored[domainName] && stored[domainName][databaseName];
    const mapping = emptyPostgresMapping();
    if(!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return mapping;

    for(const field of POSTGRES_MAPPING_FIELDS) {
        if(isSafeEnvironmentName(candidate[field])) mapping[field] = candidate[field];
    }
    return mapping;
}

function mappingIsEmpty(mapping) {
    return POSTGRES_MAPPING_FIELDS.every((field) => !mapping[field]);
}

function savePostgresMapping(domainName, databaseName, values) {
    const mapping = emptyPostgresMapping();
    for(const field of POSTGRES_MAPPING_FIELDS) {
        const name = String(values[field] || '').trim();
        if(name && !isSafeEnvironmentName(name)) {
            throw new ApiError(400, `Invalid environment variable name for ${field}: ${name}`);
        }
        mapping[field] = name || null;
    }

    const stored = loadPostgresMappings();
    if(!stored[domainName] || typeof stored[domainName] !== 'object' || Array.isArray(stored[domainName])) {
        stored[domainName] = {};
    }
    if(mappingIsEmpty(mapping)) delete stored[domainName][databaseName];
    else stored[domainName][databaseName] = mapping;
    if(!Object.keys(stored[domainName]).length) delete stored[domainName];

    const temporary = `${POSTGRES_MAPPINGS_FILE}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(stored, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, POSTGRES_MAPPINGS_FILE);
    return mapping;
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

function assertPostgresPassword(value) {
    value = String(value || '');
    if(value.length < 1 || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) {
        throw new ApiError(400, 'Password must contain between 1 and 256 printable characters');
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

async function queryPostgresRoleNames(cluster, postgresUser) {
    const query = "SELECT COALESCE(json_agg(rolname ORDER BY rolname), '[]'::json) FROM pg_roles;";
    const { stdout } = await postgresConnection(cluster, 'postgres', postgresUser, query);
    const roles = JSON.parse(stdout.trim() || '[]');
    return new Set(Array.isArray(roles) ? roles : []);
}

async function getPostgresqlDatabases(domainName) {
    const cluster = await detectPostgresCluster();
    if(!cluster.installed) return { installed: false };

    const siteUser = findSiteUserForDomain(domainName);
    const postgresUser = getSystemUser('postgres');

    if(!postgresUser) {
        return {
            installed: true,
            available: false,
            host: '127.0.0.1',
            port: cluster.port || 5432,
            databases: [],
            error: 'PostgreSQL is installed but its postgres system user was not found'
        };
    }

    if(cluster.status && cluster.status !== 'online' && cluster.status !== 'unknown') {
        return {
            installed: true,
            available: false,
            host: '127.0.0.1',
            port: cluster.port || 5432,
            databases: [],
            error: `PostgreSQL cluster ${cluster.version || ''}/${cluster.name || ''} is ${cluster.status}`.trim()
        };
    }

    try {
        const rows = await queryPostgresDatabaseRows(cluster, postgresUser);
        const mapped = new Set(loadPostgresSites()[domainName] || []);
        const databases = rows.filter((database) => database
            && (database.owner === siteUser || mapped.has(database.name)));
        const databaseNames = new Set(databases.map((database) => database.name));
        const liveRoles = await queryPostgresRoleNames(cluster, postgresUser);
        const storedUsers = loadPostgresUsers();
        const domainUsers = storedUsers[domainName] || [];
        let usersChanged = false;
        for(const database of databases) {
            if(!database.owner || database.owner === 'postgres' || !liveRoles.has(database.owner)) continue;
            if(domainUsers.some((item) => item.userName === database.owner)) continue;
            domainUsers.push({
                userName: database.owner,
                databaseName: database.name,
                permissions: 'read_write'
            });
            usersChanged = true;
        }
        if(usersChanged) {
            domainUsers.sort((a, b) => a.userName.localeCompare(b.userName));
            storedUsers[domainName] = domainUsers;
            savePostgresUsers(storedUsers);
        }
        const users = domainUsers.filter((item) =>
            databaseNames.has(item.databaseName) && liveRoles.has(item.userName));

        return {
            installed: true,
            available: true,
            host: '127.0.0.1',
            port: cluster.port || 5432,
            siteUser,
            databases,
            users
        };
    } catch(error) {
        console.error(`Could not list PostgreSQL databases: ${error.message}`);
        return {
            installed: true,
            available: false,
            host: '127.0.0.1',
            port: cluster.port || 5432,
            siteUser,
            databases: [],
            error: 'PostgreSQL is installed but the helper could not query it'
        };
    }
}

async function getWritablePostgresContext(domainName) {
    if(!isSafeDomainName(domainName)) throw new ApiError(400, 'Invalid domain name');
    const siteUser = findSiteUserForDomain(domainName);
    if(!siteUser) throw new ApiError(404, 'CloudPanel site user not found for this domain');

    const cluster = await detectPostgresCluster();
    if(!cluster.installed) throw new ApiError(409, 'PostgreSQL is not installed');
    if(cluster.status && cluster.status !== 'online' && cluster.status !== 'unknown') {
        throw new ApiError(409, `PostgreSQL cluster is ${cluster.status}`);
    }

    const postgresUser = getSystemUser('postgres');
    if(!postgresUser) throw new ApiError(500, 'PostgreSQL system user not found');
    return { cluster, postgresUser, siteUser };
}

async function createPostgresDatabase(domainName, values) {
    const databaseName = assertPostgresIdentifier(values.databaseName, 'Database name');
    const userName = assertPostgresIdentifier(values.userName, 'Database user name');
    const password = assertPostgresPassword(values.password);
    const { cluster, postgresUser } = await getWritablePostgresContext(domainName);
    const existenceSql = [
        "SELECT json_build_object(",
        `'database', EXISTS(SELECT 1 FROM pg_database WHERE datname = ${quotePostgresLiteral(databaseName)}),`,
        `'role', EXISTS(SELECT 1 FROM pg_roles WHERE rolname = ${quotePostgresLiteral(userName)}));`
    ].join(' ');
    const { stdout } = await postgresConnection(cluster, 'postgres', postgresUser, existenceSql);
    const existence = JSON.parse(stdout.trim() || '{}');
    if(existence.database) throw new ApiError(409, `PostgreSQL database ${databaseName} already exists`);
    if(existence.role) throw new ApiError(409, `PostgreSQL role ${userName} already exists`);

    const role = quotePostgresIdentifier(userName);
    const database = quotePostgresIdentifier(databaseName);
    let roleCreated = false;
    let databaseCreated = false;

    try {
        await postgresConnection(cluster, 'postgres', postgresUser,
            `CREATE ROLE ${role} LOGIN PASSWORD ${quotePostgresLiteral(password)};`);
        roleCreated = true;
        await postgresConnection(cluster, 'postgres', postgresUser,
            `CREATE DATABASE ${database} OWNER ${role};`);
        databaseCreated = true;
        registerPostgresDatabase(domainName, databaseName);
        registerPostgresUser(domainName, databaseName, userName, 'read_write');
        return { name: databaseName, owner: userName };
    } catch(error) {
        unregisterPostgresUser(domainName, userName);
        unregisterPostgresDatabase(domainName, databaseName);
        if(databaseCreated) {
            try { await postgresConnection(cluster, 'postgres', postgresUser, `DROP DATABASE ${database};`); }
            catch(cleanupError) {}
        }
        if(roleCreated) {
            try { await postgresConnection(cluster, 'postgres', postgresUser, `DROP ROLE ${role};`); }
            catch(cleanupError) {}
        }
        if(error instanceof ApiError) throw error;
        throw new ApiError(500, 'Could not create the PostgreSQL database and user');
    }
}

async function deletePostgresDatabase(domainName, values) {
    const databaseName = assertPostgresIdentifier(values.databaseName, 'Database name');
    const databaseWasCreatedByHelper = new Set(loadPostgresSites()[domainName] || []).has(databaseName);
    const context = await getPostgresDatabaseForSite(domainName, databaseName);
    const database = quotePostgresIdentifier(databaseName);
    const managedUsers = databaseWasCreatedByHelper
        ? (loadPostgresUsers()[domainName] || []).filter((item) => item.databaseName === databaseName)
        : [];

    await postgresConnection(context.cluster, 'postgres', context.postgresUser,
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${quotePostgresLiteral(databaseName)} AND pid <> pg_backend_pid();`);
    await postgresConnection(context.cluster, 'postgres', context.postgresUser,
        `DROP DATABASE ${database};`);

    unregisterPostgresDatabase(domainName, databaseName);
    unregisterPostgresDatabaseUsers(domainName, databaseName);
    savePostgresMapping(domainName, databaseName, {});
    for(const [ticket, target] of adminerTickets) {
        if(target.domainName === domainName && target.databaseName === databaseName) {
            adminerTickets.delete(ticket);
        }
    }
    for(const [ticket, target] of dumpTickets) {
        if(target.domainName === domainName && target.databaseName === databaseName) {
            dumpTickets.delete(ticket);
        }
    }

    const remainingUsers = loadPostgresUsers();
    const referencedRoles = new Set(Object.values(remainingUsers).flatMap((items) =>
        Array.isArray(items) ? items.map((item) => item.userName) : []));
    const roleCleanupWarnings = [];
    let databaseOwners;
    let liveRoles;
    try {
        const remainingDatabases = await queryPostgresDatabaseRows(context.cluster, context.postgresUser);
        databaseOwners = new Set(remainingDatabases.map((item) => item && item.owner).filter(Boolean));
        liveRoles = await queryPostgresRoleNames(context.cluster, context.postgresUser);
    } catch(error) {
        roleCleanupWarnings.push(...managedUsers.map((item) => item.userName));
        console.error(`Database ${databaseName} was deleted, but its PostgreSQL roles could not be checked`);
        return { name: databaseName, roleCleanupWarnings: [...new Set(roleCleanupWarnings)] };
    }

    for(const item of managedUsers) {
        const userName = item.userName;
        if(!isSafePostgresIdentifier(userName) || userName === 'postgres'
            || referencedRoles.has(userName) || databaseOwners.has(userName) || !liveRoles.has(userName)) continue;
        const role = quotePostgresIdentifier(userName);
        try {
            await postgresConnection(context.cluster, 'postgres', context.postgresUser,
                `REASSIGN OWNED BY ${role} TO postgres;\nDROP OWNED BY ${role};\nDROP ROLE ${role};`);
        } catch(error) {
            roleCleanupWarnings.push(userName);
            console.error(`Database ${databaseName} was deleted, but PostgreSQL role ${userName} is still in use`);
        }
    }

    return { name: databaseName, roleCleanupWarnings: [...new Set(roleCleanupWarnings)] };
}

async function createPostgresDatabaseUser(domainName, values) {
    const databaseName = assertPostgresIdentifier(values.databaseName, 'Database name');
    const userName = assertPostgresIdentifier(values.userName, 'Database user name');
    const password = assertPostgresPassword(values.password);
    const permissions = String(values.permissions || '');
    if(!['read_only', 'read_write'].includes(permissions)) throw new ApiError(400, 'Invalid permissions');

    const { cluster, postgresUser, siteUser } = await getWritablePostgresContext(domainName);
    const rows = await queryPostgresDatabaseRows(cluster, postgresUser);
    const databaseRow = rows.find((database) => database && database.name === databaseName);
    const mapped = new Set(loadPostgresSites()[domainName] || []);
    if(!databaseRow || (databaseRow.owner !== siteUser && !mapped.has(databaseName))) {
        throw new ApiError(404, 'PostgreSQL database not found for this site');
    }

    const roleCheck = `SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = ${quotePostgresLiteral(userName)});`;
    const { stdout } = await postgresConnection(cluster, 'postgres', postgresUser, roleCheck);
    if(stdout.trim() === 't') throw new ApiError(409, `PostgreSQL role ${userName} already exists`);

    const role = quotePostgresIdentifier(userName);
    let roleCreated = false;

    try {
        await postgresConnection(cluster, 'postgres', postgresUser,
            `CREATE ROLE ${role} LOGIN PASSWORD ${quotePostgresLiteral(password)};`);
        roleCreated = true;
        await applyPostgresPermissions(cluster, postgresUser, databaseName, databaseRow.owner, userName, permissions);
        registerPostgresUser(domainName, databaseName, userName, permissions);
        return { userName, databaseName, permissions };
    } catch(error) {
        if(roleCreated) {
            try { await postgresConnection(cluster, databaseName, postgresUser, `DROP OWNED BY ${role};`); }
            catch(cleanupError) {}
            try { await postgresConnection(cluster, 'postgres', postgresUser, `DROP OWNED BY ${role};`); }
            catch(cleanupError) {}
            try { await postgresConnection(cluster, 'postgres', postgresUser, `DROP ROLE ${role};`); }
            catch(cleanupError) {}
        }
        if(error instanceof ApiError) throw error;
        throw new ApiError(500, 'Could not create the PostgreSQL database user');
    }
}

async function applyPostgresPermissions(cluster, postgresUser, databaseName, ownerName, userName, permissions) {
    const role = quotePostgresIdentifier(userName);
    const database = quotePostgresIdentifier(databaseName);
    const owner = quotePostgresIdentifier(ownerName);
    const tablePrivileges = permissions === 'read_write'
        ? 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
        : 'SELECT';
    const sequencePrivileges = permissions === 'read_write' ? 'USAGE, SELECT, UPDATE' : 'USAGE, SELECT';
    const schemaPrivileges = permissions === 'read_write' ? 'USAGE, CREATE' : 'USAGE';

    await postgresConnection(cluster, 'postgres', postgresUser, [
        `REVOKE ALL PRIVILEGES ON DATABASE ${database} FROM ${role};`,
        `GRANT CONNECT ON DATABASE ${database} TO ${role};`
    ].join('\n'));

    await postgresConnection(cluster, databaseName, postgresUser, [
        `REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${role};`,
        `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${role};`,
        `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${role};`,
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM ${role};`,
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM ${role};`,
        `GRANT ${schemaPrivileges} ON SCHEMA public TO ${role};`,
        `GRANT ${tablePrivileges} ON ALL TABLES IN SCHEMA public TO ${role};`,
        `GRANT ${sequencePrivileges} ON ALL SEQUENCES IN SCHEMA public TO ${role};`,
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT ${tablePrivileges} ON TABLES TO ${role};`,
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT ${sequencePrivileges} ON SEQUENCES TO ${role};`
    ].join('\n'));
}

async function getManagedPostgresUserContext(domainName, databaseName, userName) {
    databaseName = assertPostgresIdentifier(databaseName, 'Database name');
    userName = assertPostgresIdentifier(userName, 'Database user name');
    const context = await getWritablePostgresContext(domainName);
    const managed = (loadPostgresUsers()[domainName] || []).find((item) =>
        item.databaseName === databaseName && item.userName === userName);
    if(!managed) throw new ApiError(404, 'PostgreSQL database user not found for this site');

    const rows = await queryPostgresDatabaseRows(context.cluster, context.postgresUser);
    const database = rows.find((item) => item && item.name === databaseName);
    if(!database) throw new ApiError(404, 'PostgreSQL database no longer exists');
    return { ...context, database, managed, databaseName, userName };
}

async function updatePostgresDatabaseUser(domainName, values) {
    const permissions = String(values.permissions || '');
    if(!['read_only', 'read_write'].includes(permissions)) throw new ApiError(400, 'Invalid permissions');
    const context = await getManagedPostgresUserContext(
        domainName, String(values.databaseName || ''), String(values.userName || ''));
    const password = values.password === undefined || values.password === ''
        ? null : assertPostgresPassword(values.password);

    let ownerName = context.database.owner;
    if(ownerName === context.userName && permissions === 'read_only') {
        const role = quotePostgresIdentifier(context.userName);
        const database = quotePostgresIdentifier(context.databaseName);
        await postgresConnection(context.cluster, 'postgres', context.postgresUser,
            `ALTER DATABASE ${database} OWNER TO postgres;`);
        await postgresConnection(context.cluster, context.databaseName, context.postgresUser,
            `REASSIGN OWNED BY ${role} TO postgres;\nDROP OWNED BY ${role};`);
        ownerName = 'postgres';
    }

    if(password !== null) {
        await postgresConnection(context.cluster, 'postgres', context.postgresUser,
            `ALTER ROLE ${quotePostgresIdentifier(context.userName)} PASSWORD ${quotePostgresLiteral(password)};`);
    }
    await applyPostgresPermissions(
        context.cluster, context.postgresUser, context.databaseName,
        ownerName, context.userName, permissions);
    registerPostgresUser(domainName, context.databaseName, context.userName, permissions);
    return { userName: context.userName, databaseName: context.databaseName, permissions };
}

async function deletePostgresDatabaseUser(domainName, values) {
    const context = await getManagedPostgresUserContext(
        domainName, String(values.databaseName || ''), String(values.userName || ''));
    const role = quotePostgresIdentifier(context.userName);
    const database = quotePostgresIdentifier(context.databaseName);

    if(context.database.owner === context.userName) {
        await postgresConnection(context.cluster, 'postgres', context.postgresUser,
            `ALTER DATABASE ${database} OWNER TO postgres;`);
        await postgresConnection(context.cluster, context.databaseName, context.postgresUser,
            `REASSIGN OWNED BY ${role} TO postgres;\nDROP OWNED BY ${role};`);
    } else {
        await postgresConnection(context.cluster, context.databaseName, context.postgresUser,
            `DROP OWNED BY ${role};`);
    }

    await postgresConnection(context.cluster, 'postgres', context.postgresUser,
        `DROP OWNED BY ${role};\nDROP ROLE ${role};`);
    unregisterPostgresUser(domainName, context.userName);
    return { userName: context.userName, databaseName: context.databaseName };
}

function firstEnvironmentValue(values, names) {
    for(const name of names) {
        if(values[name] !== undefined && String(values[name]).trim() !== '') return String(values[name]).trim();
    }
    return null;
}

function normalizePostgresConnection(connection, source) {
    const port = Number(connection.port || 5432);
    if(!connection.dbname || !connection.user || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return {
        host: String(connection.host || 'localhost').trim() || 'localhost',
        port,
        user: String(connection.user),
        password: String(connection.password || ''),
        dbname: String(connection.dbname),
        source
    };
}

function postgresConnectionFromUrl(raw, source) {
    try {
        const parsed = new URL(String(raw));
        if(!['postgres:', 'postgresql:', 'pgsql:'].includes(parsed.protocol)) return null;
        return normalizePostgresConnection({
            host: parsed.hostname || 'localhost',
            port: parsed.port || 5432,
            user: decodeURIComponent(parsed.username || ''),
            password: decodeURIComponent(parsed.password || ''),
            dbname: decodeURIComponent(parsed.pathname.replace(/^\//, ''))
        }, source);
    } catch(error) {
        return null;
    }
}

function interpretPostgresEnvironment(values, mapping = emptyPostgresMapping()) {
    if(!mappingIsEmpty(mapping)) {
        if(mapping.url) {
            const rawUrl = firstEnvironmentValue(values, [mapping.url]);
            return rawUrl ? postgresConnectionFromUrl(rawUrl, mapping.url) : null;
        }

        const dbname = mapping.dbname ? firstEnvironmentValue(values, [mapping.dbname]) : null;
        const user = mapping.user ? firstEnvironmentValue(values, [mapping.user]) : null;
        if(!dbname || !user) return null;
        return normalizePostgresConnection({
            host: mapping.host ? firstEnvironmentValue(values, [mapping.host]) : 'localhost',
            port: mapping.port ? firstEnvironmentValue(values, [mapping.port]) : 5432,
            user,
            password: mapping.password ? firstEnvironmentValue(values, [mapping.password]) : '',
            dbname
        }, mapping.dbname);
    }

    for(const key of ['DATABASE_URL', 'POSTGRES_URL', 'DB_URL']) {
        if(!values[key]) continue;
        const connection = postgresConnectionFromUrl(values[key], key);
        if(connection) return connection;
    }

    const driver = firstEnvironmentValue(values, ['DB_CONNECTION', 'DB_DRIVER']);
    const groups = [
        {
            source: 'PGDATABASE', host: ['PGHOST'], port: ['PGPORT'], user: ['PGUSER'],
            password: ['PGPASSWORD'], dbname: ['PGDATABASE']
        },
        {
            source: 'POSTGRES_DB', host: ['POSTGRES_HOST'], port: ['POSTGRES_PORT'], user: ['POSTGRES_USER'],
            password: ['POSTGRES_PASSWORD'], dbname: ['POSTGRES_DB', 'POSTGRES_DATABASE']
        },
        {
            source: 'DB_DATABASE', host: ['DB_HOST'], port: ['DB_PORT'], user: ['DB_USERNAME', 'DB_USER'],
            password: ['DB_PASSWORD', 'DB_PASS'], dbname: ['DB_DATABASE', 'DB_NAME'], dbGroup: true
        }
    ];

    for(const group of groups) {
        if(group.dbGroup && driver && !['pgsql', 'postgres', 'postgresql'].includes(driver.toLowerCase())) continue;
        const dbname = firstEnvironmentValue(values, group.dbname);
        const user = firstEnvironmentValue(values, group.user);
        if(!dbname || !user) continue;
        return normalizePostgresConnection({
            host: firstEnvironmentValue(values, group.host) || 'localhost',
            port: firstEnvironmentValue(values, group.port) || 5432,
            user,
            password: firstEnvironmentValue(values, group.password) || '',
            dbname
        }, group.source);
    }
    return null;
}

async function getPostgresDatabaseForSite(domainName, databaseName) {
    databaseName = assertPostgresIdentifier(databaseName, 'Database name');
    const { cluster, postgresUser, siteUser } = await getWritablePostgresContext(domainName);
    const rows = await queryPostgresDatabaseRows(cluster, postgresUser);
    const database = rows.find((item) => item && item.name === databaseName);
    const mapped = new Set(loadPostgresSites()[domainName] || []);
    if(!database || (database.owner !== siteUser && !mapped.has(databaseName))) {
        throw new ApiError(404, 'PostgreSQL database not found for this site');
    }
    return { cluster, postgresUser, siteUser, database };
}

function resolveBackendEnvironment(domainName) {
    const siteUser = findSiteUserForDomain(domainName);
    if(!siteUser) throw new ApiError(404, 'CloudPanel site user not found for this domain');
    const user = getSystemUser(siteUser);
    if(!user) throw new ApiError(404, 'CloudPanel system user no longer exists');

    const documentRoot = path.resolve('/home', siteUser, 'htdocs', domainName);
    const expectedEnvironment = path.resolve(documentRoot, 'config', '.env');
    let realDocumentRoot;
    let realEnvironment;

    try {
        realDocumentRoot = fs.realpathSync(documentRoot);
        realEnvironment = fs.realpathSync(expectedEnvironment);
    } catch(error) {
        throw new ApiError(404, `PostgreSQL configuration was not found at ${expectedEnvironment}`);
    }

    if(!realEnvironment.startsWith(realDocumentRoot + path.sep)) {
        throw new ApiError(403, 'The backend .env resolves outside the site document root');
    }

    const stat = fs.statSync(realEnvironment);
    if(!stat.isFile() || stat.size > 256 * 1024) throw new ApiError(400, 'The backend .env is not a valid configuration file');
    if(stat.uid !== user.uid) throw new ApiError(403, `The backend .env does not belong to ${siteUser}`);

    const values = dotenv.parse(fs.readFileSync(realEnvironment));
    return { siteUser, documentRoot: realDocumentRoot, envPath: realEnvironment, values };
}

async function resolveAdminerConnection(domainName, databaseName) {
    databaseName = assertPostgresIdentifier(databaseName, 'Database name');
    const { cluster } = await getPostgresDatabaseForSite(domainName, databaseName);

    const backend = resolveBackendEnvironment(domainName);
    const mapping = getPostgresMapping(domainName, databaseName);
    const connection = interpretPostgresEnvironment(backend.values, mapping);
    if(!connection) {
        const detail = mappingIsEmpty(mapping)
            ? 'No PostgreSQL connection was found'
            : 'The configured PostgreSQL variable names did not produce a valid connection';
        throw new ApiError(422, `${detail} in ${backend.envPath}`);
    }
    if(connection.dbname !== databaseName) {
        throw new ApiError(409,
            `The selected database is ${databaseName}, but ${backend.envPath} configures ${connection.dbname}`);
    }

    const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
    if(!localHosts.has(connection.host.toLowerCase()) || connection.port !== (cluster.port || 5432)) {
        throw new ApiError(409, 'The backend .env does not point to this server\'s local PostgreSQL cluster');
    }
    return { connection, envPath: backend.envPath, mapping };
}

async function buildPostgresMappingReport(domainName, databaseName) {
    try {
        const resolved = await resolveAdminerConnection(domainName, databaseName);
        return {
            ok: true,
            envPath: resolved.envPath,
            source: resolved.connection.source,
            host: resolved.connection.host,
            port: resolved.connection.port,
            user: resolved.connection.user,
            dbname: resolved.connection.dbname,
            passwordConfigured: resolved.connection.password.length > 0
        };
    } catch(error) {
        let envPath = null;
        try { envPath = resolveBackendEnvironment(domainName).envPath; } catch(ignored) {}
        return { ok: false, envPath, error: error.message || 'Connection could not be resolved' };
    }
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

function postgresClientEnvironment(connection, systemUser) {
    return {
        ...postgresToolEnvironment(),
        HOME: systemUser.home,
        PGPASSWORD: connection.password
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

async function withDatabaseOperation(domainName, databaseName, operation) {
    const key = `${domainName}\u0000${databaseName}`;
    if(databaseOperations.has(key)) {
        throw new ApiError(409, `Another import or export is already running for ${databaseName}`);
    }
    databaseOperations.add(key);
    try {
        return await operation();
    } finally {
        databaseOperations.delete(key);
    }
}

function createDumpTempDirectory(postgresUser) {
    const base = fs.realpathSync(DUMP_TEMP_DIR);
    const staleBefore = Date.now() - DUMP_TIMEOUT - (60 * 60 * 1000);
    try {
        for(const entry of fs.readdirSync(base, { withFileTypes: true })) {
            if(!entry.isDirectory() || !entry.name.startsWith('cloudpanel-pgmanager-')) continue;
            const candidate = path.join(base, entry.name);
            const stat = fs.lstatSync(candidate);
            if(stat.uid === postgresUser.uid && stat.mtimeMs < staleBefore) {
                removeDumpTempDirectory(candidate);
            }
        }
    } catch(error) {
        console.error(`Could not inspect stale PostgreSQL dump files: ${error.message}`);
    }
    const directory = fs.mkdtempSync(path.join(base, 'cloudpanel-pgmanager-'));
    try {
        fs.chownSync(directory, postgresUser.uid, postgresUser.gid);
        fs.chmodSync(directory, 0o700);
        return directory;
    } catch(error) {
        try { fs.rmSync(directory, { recursive: true, force: true }); } catch(ignored) {}
        throw error;
    }
}

function removeDumpTempDirectory(directory) {
    if(!directory) return;
    let base;
    try { base = fs.realpathSync(DUMP_TEMP_DIR); } catch(error) {
        console.error(`Could not resolve dump temporary directory during cleanup: ${error.message}`);
        return;
    }
    const resolved = path.resolve(directory);
    if(!resolved.startsWith(base + path.sep) || !path.basename(resolved).startsWith('cloudpanel-pgmanager-')) {
        console.error(`Refusing to remove unexpected dump directory: ${resolved}`);
        return;
    }
    try { fs.rmSync(resolved, { recursive: true, force: true }); } catch(error) {
        console.error(`Could not remove PostgreSQL dump directory ${resolved}: ${error.message}`);
    }
}

function receivePostgresImport(req, postgresUser, directory) {
    const contentLength = Number(req.headers['content-length'] || 0);
    if(!Number.isSafeInteger(contentLength) || contentLength < 0) {
        throw new ApiError(400, 'Invalid upload size');
    }
    if(contentLength > MAX_IMPORT_BYTES) {
        throw new ApiError(413, `Import exceeds the configured limit of ${MAX_IMPORT_BYTES} bytes`);
    }

    const destination = path.join(directory, 'import.upload');
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
        let size = 0;
        let uploadError = null;
        let ended = false;
        let settled = false;

        const rejectOnce = (error) => {
            if(settled) return;
            settled = true;
            reject(error);
        };

        output.on('error', (error) => {
            uploadError = uploadError || new ApiError(500, `Could not store the import: ${error.message}`);
            req.resume();
            if(ended) rejectOnce(uploadError);
        });
        output.on('finish', () => {
            if(settled) return;
            if(uploadError) return rejectOnce(uploadError);
            if(size === 0) return rejectOnce(new ApiError(400, 'The import file is empty'));
            try {
                fs.chownSync(destination, postgresUser.uid, postgresUser.gid);
                fs.chmodSync(destination, 0o600);
            } catch(error) {
                return rejectOnce(new ApiError(500, `Could not secure the import file: ${error.message}`));
            }
            settled = true;
            resolve({ path: destination, size });
        });
        req.on('data', (chunk) => {
            if(uploadError) return;
            size += chunk.length;
            if(size > MAX_IMPORT_BYTES) {
                uploadError = new ApiError(413, `Import exceeds the configured limit of ${MAX_IMPORT_BYTES} bytes`);
                output.destroy();
                req.resume();
                return;
            }
            if(!output.write(chunk)) {
                req.pause();
                output.once('drain', () => req.resume());
            }
        });
        req.on('end', () => {
            ended = true;
            if(uploadError) return rejectOnce(uploadError);
            output.end();
        });
        req.on('aborted', () => {
            uploadError = new ApiError(400, 'Import upload was interrupted');
            output.destroy();
            rejectOnce(uploadError);
        });
        req.on('error', (error) => {
            uploadError = new ApiError(400, `Import upload failed: ${error.message}`);
            output.destroy();
            rejectOnce(uploadError);
        });
    });
}

function looksLikePlainPostgresSql(filePath) {
    const descriptor = fs.openSync(filePath, 'r');
    try {
        const sample = Buffer.alloc(16384);
        const bytesRead = fs.readSync(descriptor, sample, 0, sample.length, 0);
        const content = sample.subarray(0, bytesRead);
        if(!content.length || content.includes(0)) return false;
        const text = content.toString('utf8').replace(/^\uFEFF/, '').trimStart();
        return /^(--|\/\*|\\|SET\b|SELECT\b|CREATE\b|INSERT\b|UPDATE\b|DELETE\b|DROP\b|ALTER\b|BEGIN\b)/i.test(text);
    } finally {
        fs.closeSync(descriptor);
    }
}

async function assertSafePlainPostgresSql(filePath) {
    const maxScannedLineBytes = 64 * 1024;
    let line = '';
    let overflow = false;
    let inCopyData = false;
    let pendingCopyStatement = false;

    const inspectLine = () => {
        const normalized = line.replace(/\r$/, '');
        if(inCopyData) {
            if(!overflow && normalized === '\\.') inCopyData = false;
            line = '';
            overflow = false;
            return;
        }

        const trimmed = normalized.trimStart();
        if(trimmed.startsWith('\\')) {
            const match = /^\\([^\s]+)/.exec(trimmed);
            const command = match ? match[1].toLowerCase() : '';
            if(!['restrict', 'unrestrict'].includes(command)) {
                throw new ApiError(400, 'Unsafe psql meta-command detected in plain SQL import');
            }
        }
        if(/^COPY\b/i.test(trimmed)) pendingCopyStatement = true;
        if(pendingCopyStatement) {
            if(overflow) throw new ApiError(400, 'COPY statement is too long to validate safely');
            if(/\bFROM\s+stdin\s*;\s*$/i.test(trimmed)) {
                inCopyData = true;
                pendingCopyStatement = false;
            } else if(/;\s*$/.test(trimmed)) {
                pendingCopyStatement = false;
            }
        }
        line = '';
        overflow = false;
    };

    for await (const chunk of fs.createReadStream(filePath)) {
        for(const byte of chunk) {
            if(byte === 10) {
                inspectLine();
                continue;
            }
            if(line.length < maxScannedLineBytes) line += String.fromCharCode(byte);
            else overflow = true;
        }
    }
    if(line.length || overflow) inspectLine();
    if(inCopyData) throw new ApiError(400, 'Plain SQL import contains an unterminated COPY data section');
}

async function createPostgresExport(domainName, databaseName) {
    return withDatabaseOperation(domainName, databaseName, async () => {
        const context = await getPostgresDatabaseForSite(domainName, databaseName);
        const pgDump = await resolvePostgresTool(context.cluster, 'pg_dump');
        const directory = createDumpTempDirectory(context.postgresUser);
        const filePath = path.join(directory, 'database.dump');
        try {
            await run(pgDump, [
                '--format=custom', '--compress=6', '--no-owner', '--no-privileges', '--no-password',
                '--port', String(context.cluster.port || 5432), '--dbname', databaseName,
                '--file', filePath
            ], {
                uid: context.postgresUser.uid,
                gid: context.postgresUser.gid,
                timeout: DUMP_TIMEOUT,
                env: postgresToolEnvironment()
            });
            const stat = fs.statSync(filePath);
            if(!stat.isFile() || stat.size < 1) throw new ApiError(500, 'pg_dump created an empty export');
            const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
            return {
                directory,
                filePath,
                size: stat.size,
                downloadName: `${databaseName}-${timestamp}.dump`
            };
        } catch(error) {
            removeDumpTempDirectory(directory);
            if(error instanceof ApiError) throw error;
            throw new ApiError(500, `PostgreSQL export failed: ${error.message}`);
        }
    });
}

async function importPostgresDatabase(req, domainName, databaseName) {
    return withDatabaseOperation(domainName, databaseName, async () => {
        const context = await getPostgresDatabaseForSite(domainName, databaseName);
        const resolvedConnection = await resolveAdminerConnection(domainName, databaseName);
        const connection = resolvedConnection.connection;
        const siteSystemUser = getSystemUser(context.siteUser);
        if(!siteSystemUser) throw new ApiError(404, 'CloudPanel site user no longer exists');
        const pgRestore = await resolvePostgresTool(context.cluster, 'pg_restore');
        const psql = await resolvePostgresTool(context.cluster, 'psql');
        try {
            const ownership = await run(psql, [
                '-X', '-q', '-A', '-t', '--no-password',
                '--host', connection.host, '--port', String(connection.port),
                '--username', connection.user, '--dbname', databaseName,
                '--command', "SELECT json_build_object('owner', pg_get_userbyid(datdba) = current_user, 'superuser', (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)) FROM pg_database WHERE datname = current_database();"
            ], {
                uid: siteSystemUser.uid,
                gid: siteSystemUser.gid,
                timeout: 15000,
                env: postgresClientEnvironment(connection, siteSystemUser)
            });
            const roleState = JSON.parse(ownership.stdout.trim() || '{}');
            if(roleState.superuser) {
                throw new ApiError(409, 'Import through a PostgreSQL superuser is refused; configure the non-superuser database owner in the .env');
            }
            if(!roleState.owner) {
                throw new ApiError(409, 'The PostgreSQL user configured in the .env must own the target database before it can import a dump');
            }
        } catch(error) {
            if(error instanceof ApiError) throw error;
            throw new ApiError(409, 'The PostgreSQL connection configured in the .env could not authenticate for import');
        }
        const directory = createDumpTempDirectory(siteSystemUser);
        try {
            const upload = await receivePostgresImport(req, siteSystemUser, directory);
            let format = 'archive';
            try {
                await run(pgRestore, ['--list', upload.path], {
                    uid: siteSystemUser.uid,
                    gid: siteSystemUser.gid,
                    timeout: 60000,
                    env: postgresToolEnvironment()
                });
            } catch(error) {
                if(!looksLikePlainPostgresSql(upload.path)) {
                    throw new ApiError(400, 'Unsupported import file. Use a PostgreSQL custom/tar dump or plain SQL file');
                }
                format = 'plain';
            }

            if(format === 'archive') {
                await run(pgRestore, [
                    '--exit-on-error', '--clean', '--if-exists', '--no-owner', '--no-privileges',
                    '--no-password', '--host', connection.host, '--port', String(connection.port),
                    '--username', connection.user, '--dbname', databaseName,
                    upload.path
                ], {
                    uid: siteSystemUser.uid,
                    gid: siteSystemUser.gid,
                    timeout: DUMP_TIMEOUT,
                    env: postgresClientEnvironment(connection, siteSystemUser)
                });
            } else {
                await assertSafePlainPostgresSql(upload.path);
                await run(psql, [
                    '-X', '--set', 'ON_ERROR_STOP=1', '--no-password',
                    '--host', connection.host, '--port', String(connection.port),
                    '--username', connection.user, '--dbname', databaseName,
                    '--file', upload.path
                ], {
                    uid: siteSystemUser.uid,
                    gid: siteSystemUser.gid,
                    timeout: DUMP_TIMEOUT,
                    env: postgresClientEnvironment(connection, siteSystemUser)
                });
            }

            const permissionWarnings = [];
            for(const item of (loadPostgresUsers()[domainName] || []).filter((user) => user.databaseName === databaseName)) {
                try {
                    await applyPostgresPermissions(context.cluster, context.postgresUser, databaseName,
                        context.database.owner, item.userName, item.permissions);
                } catch(error) {
                    permissionWarnings.push(item.userName);
                }
            }
            return { name: databaseName, format, size: upload.size, permissionWarnings };
        } catch(error) {
            if(error instanceof ApiError) throw error;
            throw new ApiError(500, `PostgreSQL import failed: ${error.message}`);
        } finally {
            removeDumpTempDirectory(directory);
        }
    });
}

function createAdminerTicket(sessionId, domainName, databaseName) {
    const now = Date.now();
    for(const [ticket, entry] of adminerTickets) {
        if(entry.expiresAt <= now) adminerTickets.delete(ticket);
    }

    const ticket = crypto.randomBytes(32).toString('base64url');
    adminerTickets.set(ticket, {
        sessionId,
        domainName,
        databaseName,
        expiresAt: now + 60000
    });
    return ticket;
}

function consumeAdminerTicket(ticket, sessionId) {
    const entry = adminerTickets.get(String(ticket || ''));
    if(!entry) return null;
    adminerTickets.delete(String(ticket));
    if(entry.expiresAt <= Date.now() || entry.sessionId !== sessionId) return null;
    return entry;
}

function createDumpTicket(sessionId, domainName, databaseName) {
    const now = Date.now();
    for(const [ticket, entry] of dumpTickets) {
        if(entry.expiresAt <= now) dumpTickets.delete(ticket);
    }
    const ticket = crypto.randomBytes(32).toString('base64url');
    dumpTickets.set(ticket, { sessionId, domainName, databaseName, expiresAt: now + 60000 });
    return ticket;
}

function consumeDumpTicket(ticket, sessionId) {
    const key = String(ticket || '');
    const entry = dumpTickets.get(key);
    if(!entry) return null;
    dumpTickets.delete(key);
    if(entry.expiresAt <= Date.now() || entry.sessionId !== sessionId) return null;
    return entry;
}

async function downloadPostgresExport(req, res, target) {
    const dump = await createPostgresExport(target.domainName, target.databaseName);
    let cleaned = false;
    const cleanup = () => {
        if(cleaned) return;
        cleaned = true;
        removeDumpTempDirectory(dump.directory);
    };
    if(res.destroyed) {
        cleanup();
        return;
    }
    const stream = fs.createReadStream(dump.filePath);
    stream.on('error', (error) => {
        console.error(`Could not stream PostgreSQL export ${target.databaseName}: ${error.message}`);
        cleanup();
        res.destroy(error);
    });
    stream.on('close', cleanup);
    res.on('close', cleanup);
    res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': dump.size,
        'Content-Disposition': `attachment; filename="${dump.downloadName}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });
    stream.pipe(res);
}

function httpsGetJson(requestUrl) {
    return new Promise((resolve, reject) => {
        const request = https.get(requestUrl, {
            headers: {
                'User-Agent': 'cloudpanel-pgmanager-helper',
                'Accept': 'application/vnd.github+json'
            },
            timeout: 20000
        }, (response) => {
            if(response.statusCode !== 200) {
                response.resume();
                reject(new Error(`GitHub API returned HTTP ${response.statusCode}`));
                return;
            }

            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { body += chunk; });
            response.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch(error) {
                    reject(new Error('GitHub API returned invalid JSON'));
                }
            });
        });

        request.on('timeout', () => request.destroy(new Error('GitHub API request timed out')));
        request.on('error', reject);
    });
}

function readCatalogCache() {
    try {
        const cache = JSON.parse(fs.readFileSync(CATALOG_CACHE_FILE, 'utf8'));
        if(Array.isArray(cache.versions) && Number.isInteger(cache.ts)) return cache;
    } catch(error) {}

    return null;
}

function writeCatalogCache(versions, timestamp) {
    const temporary = `${CATALOG_CACHE_FILE}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ versions, ts: timestamp }), { mode: 0o600 });
    fs.renameSync(temporary, CATALOG_CACHE_FILE);
}

function releaseHasFullAdminerAsset(release, version) {
    const expected = `adminer-${version}.php`;
    return Array.isArray(release.assets) && release.assets.some((asset) => asset && asset.name === expected);
}

async function getAvailableVersions(forceRefresh = false) {
    const cached = readCatalogCache();
    const fresh = cached && ((Date.now() / 1000) - cached.ts) < CATALOG_TTL_SECONDS;
    if(!forceRefresh && fresh) return cached;

    try {
        const releases = await httpsGetJson(GITHUB_API_URL);
        const versions = [];

        for(const release of releases) {
            if(!release || release.draft || release.prerelease) continue;
            const match = /^v(\d+\.\d+\.\d+)$/.exec(release.tag_name || '');
            if(match && releaseHasFullAdminerAsset(release, match[1])) versions.push(match[1]);
        }

        if(!versions.length) throw new Error('No published Adminer versions found');
        versions.sort(compareVersionsDesc);

        const unique = [...new Set(versions)];
        const ts = Math.floor(Date.now() / 1000);
        writeCatalogCache(unique, ts);
        return { versions: unique, ts };
    } catch(error) {
        console.error(`Could not query the Adminer catalogue: ${error.message}`);
        return cached || { versions: [], ts: null };
    }
}

function listInstalledVersions() {
    const installed = [];

    for(const entry of fs.readdirSync(ADMINER_ROOT, { withFileTypes: true })) {
        if(!entry.isFile()) continue;
        const match = /^adminer-(\d+\.\d+\.\d+)\.php$/.exec(entry.name);
        if(!match) continue;

        const file = adminerPath(match[1]);
        const stat = fs.statSync(file);
        installed.push({ version: match[1], path: file, size: stat.size });
    }

    installed.sort((a, b) => compareVersionsDesc(a.version, b.version));
    return installed;
}

async function withVersionOperation(version, operation) {
    if(operations.has(version)) throw new ApiError(409, `An operation for Adminer ${version} is already running`);
    operations.add(version);

    try {
        return await operation();
    } finally {
        operations.delete(version);
    }
}

async function installVersion(version) {
    if(!isSafeVersion(version)) throw new ApiError(400, `Invalid version: ${version}`);
    await assertPhpPostgresqlDriver();

    return withVersionOperation(version, async () => {
        const destination = adminerPath(version);
        if(fs.existsSync(destination)) return `Adminer ${version} is already installed`;
        if(!(await commandExists('curl'))) throw new ApiError(500, 'Missing required tool on the server: curl');

        // Keep the temporary file on the same filesystem as its destination,
        // so the final rename is atomic even when /tmp is a separate mount.
        const temporaryDirectory = fs.mkdtempSync(path.join(ADMINER_ROOT, '.install-'));
        const temporaryFile = path.join(temporaryDirectory, 'adminer.php');
        const downloadUrl = `${GITHUB_DOWNLOAD_BASE}/v${version}/adminer-${version}.php`;

        try {
            try {
                await run('curl', [
                    '-fsSL', '--retry', '3', '--retry-delay', '2',
                    '--connect-timeout', '20', '--max-time', '300',
                    '-o', temporaryFile, downloadUrl
                ], { timeout: INSTALL_TIMEOUT });
            } catch(error) {
                throw new ApiError(502, `Could not download Adminer ${version} from GitHub`);
            }

            const stat = fs.statSync(temporaryFile);
            if(stat.size < 10000 || stat.size > 10 * 1024 * 1024) {
                throw new ApiError(502, 'The downloaded Adminer file has an unexpected size');
            }

            const contents = fs.readFileSync(temporaryFile, 'utf8');
            if(!contents.startsWith('<?php') || !contents.includes('Adminer')) {
                throw new ApiError(502, 'The downloaded file does not look like Adminer');
            }

            if(await commandExists('php')) {
                try {
                    await run('php', ['-l', temporaryFile], { timeout: 30000 });
                } catch(error) {
                    throw new ApiError(502, 'The downloaded Adminer file is not valid PHP');
                }
            }

            fs.chmodSync(temporaryFile, 0o644);
            fs.renameSync(temporaryFile, destination);
            return `Installed Adminer ${version}`;
        } finally {
            fs.rmSync(temporaryDirectory, { recursive: true, force: true });
        }
    });
}

async function removeVersion(version) {
    if(!isSafeVersion(version)) throw new ApiError(400, `Invalid version: ${version}`);

    return withVersionOperation(version, async () => {
        const destination = adminerPath(version);
        if(!fs.existsSync(destination)) throw new ApiError(404, `Adminer ${version} is not installed`);
        fs.unlinkSync(destination);
        return `Removed Adminer ${version}`;
    });
}

async function buildVersionsPayload(forceRefresh) {
    const catalog = await getAvailableVersions(forceRefresh);
    const installed = listInstalledVersions();
    const installedByVersion = new Map(installed.map((item) => [item.version, item]));
    const versions = [...new Set([...catalog.versions, ...installed.map((item) => item.version)])];
    versions.sort(compareVersionsDesc);

    return {
        cacheTimestamp: catalog.ts,
        versions: versions.map((version) => {
            const item = installedByVersion.get(version);
            return {
                version,
                installed: Boolean(item),
                path: item ? item.path : null,
                size: item ? item.size : null
            };
        })
    };
}

function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
}

function sendJsonResponse(res, status, payload) {
    setCorsHeaders(res);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        let size = 0;

        req.on('data', (chunk) => {
            size += chunk.length;
            if(size > 64 * 1024) {
                reject(new ApiError(413, 'Request body too large'));
                req.destroy();
                return;
            }
            body += chunk;
        });

        req.on('end', () => {
            if(!body) return resolve({});
            try {
                const parsed = JSON.parse(body);
                resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
            } catch(error) {
                reject(new ApiError(400, 'Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

function proxyAdminerRequest(req, res, target) {
    const requestedUrl = new URL(req.url, 'https://pgmanager.invalid');
    requestedUrl.searchParams.delete('ticket');
    const headers = { ...req.headers, host: `${ADMINER_PHP_HOST}:${ADMINER_PHP_PORT}` };
    delete headers['content-length'];
    delete headers['x-pgmanager-domain'];
    delete headers['x-pgmanager-database'];
    if(target) {
        headers['x-pgmanager-domain'] = target.domainName;
        headers['x-pgmanager-database'] = target.databaseName;
    }

    return new Promise((resolve, reject) => {
        const proxy = http.request({
            host: ADMINER_PHP_HOST,
            port: ADMINER_PHP_PORT,
            method: req.method,
            path: `/adminer.php${requestedUrl.search}`,
            headers
        }, (response) => {
            res.writeHead(response.statusCode || 502, response.headers);
            response.pipe(res);
            response.on('end', resolve);
        });
        proxy.on('error', reject);
        req.pipe(proxy);
    });
}

async function handleAdminerRequest(req, res) {
    const ipCheck = validateClientIp(req);
    if(!ipCheck.ok) return sendJsonResponse(res, 403, { ok: false, error: ipCheck.reason });
    const auth = validateCloudPanelSession(req, { requireOrigin: false });
    if(!auth.ok) return sendJsonResponse(res, 401, { ok: false, error: auth.reason });

    const parsed = url.parse(req.url, true);
    let target = null;
    if(parsed.query.ticket) {
        target = consumeAdminerTicket(parsed.query.ticket, auth.sessionId);
        if(!target) return sendJsonResponse(res, 403, { ok: false, error: 'Adminer link expired or already used' });
    }
    await proxyAdminerRequest(req, res, target);
}

async function handleRequest(req, res) {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname.replace(/\/+$/, '') || '/';

    if(req.method === 'OPTIONS') {
        if(req.headers.origin !== ALLOWED_ORIGIN) {
            res.writeHead(403);
            res.end();
            return;
        }
        setCorsHeaders(res);
        res.writeHead(204);
        res.end();
        return;
    }

    if(req.method === 'GET' && pathname === '/internal/adminer-connection') {
        const clientIp = normalizeClientIp(req.socket.remoteAddress);
        if(clientIp !== '127.0.0.1' && clientIp !== '::1') {
            return sendJsonResponse(res, 404, { ok: false, error: 'Not found' });
        }

        const internalAuth = validateCloudPanelSession(req);
        if(!internalAuth.ok) return sendJsonResponse(res, 401, { ok: false, error: internalAuth.reason });
        const domainName = String(parsedUrl.query.domainName || '').trim().toLowerCase();
        const databaseName = String(parsedUrl.query.databaseName || '').trim();
        const resolved = await resolveAdminerConnection(domainName, databaseName);
        return sendJsonResponse(res, 200, {
            ok: true,
            connection: resolved.connection,
            envPath: resolved.envPath
        });
    }

    const ipCheck = validateClientIp(req);
    if(!ipCheck.ok) return sendJsonResponse(res, 403, { ok: false, error: ipCheck.reason });

    if(pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('CloudPanel PgManager Helper OK\n');
        return;
    }

    if(req.method === 'GET' && pathname === '/api/postgresql/export') {
        const downloadAuth = validateCloudPanelSession(req, { requireOrigin: false });
        if(!downloadAuth.ok) return sendJsonResponse(res, 401, { ok: false, error: downloadAuth.reason });
        const target = consumeDumpTicket(parsedUrl.query.ticket, downloadAuth.sessionId);
        if(!target) return sendJsonResponse(res, 403, { ok: false, error: 'Export link expired or already used' });
        await downloadPostgresExport(req, res, target);
        return;
    }

    const auth = validateCloudPanelSession(req);
    if(!auth.ok) return sendJsonResponse(res, 401, { ok: false, error: auth.reason });

    if(req.method === 'GET' && pathname === '/api/versions') {
        const payload = await buildVersionsPayload(parsedUrl.query.refresh === '1');
        return sendJsonResponse(res, 200, { ok: true, ...payload });
    }

    if(req.method === 'GET' && pathname === '/api/postgresql') {
        const domainName = String(parsedUrl.query.domainName || '').trim().toLowerCase();
        const postgresql = await getPostgresqlDatabases(domainName);
        postgresql.maxImportBytes = MAX_IMPORT_BYTES;
        return sendJsonResponse(res, 200, { ok: true, postgresql });
    }

    if(req.method === 'GET' && pathname === '/api/postgresql/mapping') {
        const domainName = String(parsedUrl.query.domainName || '').trim().toLowerCase();
        const databaseName = String(parsedUrl.query.databaseName || '').trim();
        await getPostgresDatabaseForSite(domainName, databaseName);
        return sendJsonResponse(res, 200, {
            ok: true,
            mapping: getPostgresMapping(domainName, databaseName),
            report: await buildPostgresMappingReport(domainName, databaseName)
        });
    }

    if(req.method === 'POST' && pathname === '/api/postgresql/mapping') {
        const body = await readJsonBody(req);
        const domainName = String(body.domainName || '').trim().toLowerCase();
        const databaseName = String(body.databaseName || '').trim();
        await getPostgresDatabaseForSite(domainName, databaseName);
        const mapping = savePostgresMapping(domainName, databaseName,
            body.mapping && typeof body.mapping === 'object' ? body.mapping : {});
        return sendJsonResponse(res, 200, {
            ok: true,
            mapping,
            report: await buildPostgresMappingReport(domainName, databaseName)
        });
    }

    if(req.method === 'POST' && pathname === '/api/postgresql/databases') {
        const body = await readJsonBody(req);
        const domainName = String(body.domainName || '').trim().toLowerCase();
        const database = await createPostgresDatabase(domainName, body);
        return sendJsonResponse(res, 201, { ok: true, database });
    }

    if(req.method === 'POST' && pathname === '/api/postgresql/databases/delete') {
        const body = await readJsonBody(req);
        const domainName = String(body.domainName || '').trim().toLowerCase();
        const databaseName = String(body.databaseName || '').trim();
        const database = await withDatabaseOperation(domainName, databaseName,
            () => deletePostgresDatabase(domainName, body));
        return sendJsonResponse(res, 200, { ok: true, database });
    }

    if(req.method === 'POST' && pathname === '/api/postgresql/export-ticket') {
        const body = await readJsonBody(req);
        const domainName = String(body.domainName || '').trim().toLowerCase();
        const databaseName = String(body.databaseName || '').trim();
        const context = await getPostgresDatabaseForSite(domainName, databaseName);
        await resolvePostgresTool(context.cluster, 'pg_dump');
        const ticket = createDumpTicket(auth.sessionId, domainName, databaseName);
        return sendJsonResponse(res, 201, {
            ok: true,
            exportPath: `/api/postgresql/export?ticket=${encodeURIComponent(ticket)}`
        });
    }

    if(req.method === 'POST' && pathname === '/api/postgresql/import') {
        const domainName = String(parsedUrl.query.domainName || '').trim().toLowerCase();
        const databaseName = String(parsedUrl.query.databaseName || '').trim();
        const database = await importPostgresDatabase(req, domainName, databaseName);
        return sendJsonResponse(res, 200, { ok: true, database });
    }

    if(req.method === 'POST' && pathname === '/api/postgresql/users') {
        const body = await readJsonBody(req);
        const domainName = String(body.domainName || '').trim().toLowerCase();
        const databaseUser = await createPostgresDatabaseUser(domainName, body);
        return sendJsonResponse(res, 201, { ok: true, databaseUser });
    }

    if(req.method === 'POST' && pathname === '/api/postgresql/users/update') {
        const body = await readJsonBody(req);
        const domainName = String(body.domainName || '').trim().toLowerCase();
        const databaseUser = await updatePostgresDatabaseUser(domainName, body);
        return sendJsonResponse(res, 200, { ok: true, databaseUser });
    }

    if(req.method === 'POST' && pathname === '/api/postgresql/users/delete') {
        const body = await readJsonBody(req);
        const domainName = String(body.domainName || '').trim().toLowerCase();
        const databaseUser = await deletePostgresDatabaseUser(domainName, body);
        return sendJsonResponse(res, 200, { ok: true, databaseUser });
    }

    if(req.method === 'POST' && pathname === '/api/postgresql/adminer-ticket') {
        const body = await readJsonBody(req);
        const domainName = String(body.domainName || '').trim().toLowerCase();
        const databaseName = String(body.databaseName || '').trim();
        const compatibleAdminer = listInstalledVersions().some((item) =>
            compareVersionsDesc(item.version, '5.0.0') <= 0);
        if(!compatibleAdminer) throw new ApiError(409, 'Adminer 5.0.0 or newer must be installed');
        await assertPhpPostgresqlDriver();
        // Resolve once before opening a tab, so missing/mismatched .env files
        // are reported on the CloudPanel page. Credentials are not retained.
        await resolveAdminerConnection(domainName, databaseName);
        const ticket = createAdminerTicket(auth.sessionId, domainName, databaseName);
        return sendJsonResponse(res, 201, {
            ok: true,
            adminerPath: `/adminer?ticket=${encodeURIComponent(ticket)}`
        });
    }

    if(req.method === 'POST' && pathname === '/api/versions/install') {
        const body = await readJsonBody(req);
        const message = await installVersion(String(body.version || ''));
        return sendJsonResponse(res, 200, { ok: true, message });
    }

    if(req.method === 'POST' && pathname === '/api/versions/remove') {
        const body = await readJsonBody(req);
        const message = await removeVersion(String(body.version || ''));
        return sendJsonResponse(res, 200, { ok: true, message });
    }

    sendJsonResponse(res, 404, { ok: false, error: 'Not found' });
}

let phpServer = null;
let stopping = false;

function startAdminerPhpServer() {
    const clpUser = getSystemUser('clp');
    if(!clpUser) {
        console.error('Cannot start the Adminer gateway: CloudPanel user clp was not found.');
        return;
    }

    phpServer = spawn(PHP_BINARY, [
        '-S', `${ADMINER_PHP_HOST}:${ADMINER_PHP_PORT}`,
        '-t', path.join(__dirname, 'php-public')
    ], {
        cwd: __dirname,
        uid: clpUser.uid,
        gid: clpUser.gid,
        env: {
            PATH: process.env.PATH,
            LANG: process.env.LANG || 'C.UTF-8',
            TMPDIR: process.env.TMPDIR || '/tmp',
            PGMANAGER_HELPER_PORT: String(PORT),
            PGMANAGER_HELPER_ALLOWED_ORIGIN: ALLOWED_ORIGIN,
            ADMINER_ROOT
        },
        stdio: ['ignore', 'ignore', 'pipe']
    });

    phpServer.stderr.on('data', (chunk) => {
        const message = String(chunk || '').trim();
        if(message && !message.includes('Accepted') && !message.includes('Closing')) {
            console.error(`Adminer PHP gateway: ${message}`);
        }
    });
    phpServer.on('error', (error) => console.error(`Could not start the Adminer PHP gateway: ${error.message}`));
    phpServer.on('exit', (code, signal) => {
        phpServer = null;
        if(stopping) return;
        console.error(`Adminer PHP gateway stopped (${signal || code}); restarting.`);
        setTimeout(startAdminerPhpServer, 1000);
    });
}

function shutdown() {
    if(stopping) return;
    stopping = true;
    if(phpServer) phpServer.kill('SIGTERM');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const server = https.createServer({
    key: fs.readFileSync(path.join(SSL_DIR, 'pgmanager-helper.key')),
    cert: fs.readFileSync(path.join(SSL_DIR, 'pgmanager-helper.crt'))
}, (req, res) => {
    const pathname = (url.parse(req.url).pathname || '').replace(/\/+$/, '') || '/';
    const handler = pathname === '/adminer' ? handleAdminerRequest : handleRequest;
    handler(req, res).catch((error) => {
        const status = error instanceof ApiError ? error.status : 500;
        const message = error instanceof ApiError ? error.message : 'Internal server error';
        if(!(error instanceof ApiError)) console.error(error);
        if(!res.headersSent) sendJsonResponse(res, status, { ok: false, error: message });
        else res.end();
    });
});

server.requestTimeout = Math.max(INSTALL_TIMEOUT + 60000, DUMP_TIMEOUT + 60000, 60 * 60 * 1000);
server.headersTimeout = 60000;
server.listen(PORT, HOST, () => {
    startAdminerPhpServer();
    const installed = listInstalledVersions().map((item) => item.version).join(', ') || 'none';
    console.log(`CloudPanel PgManager Helper listening on ${HOST}:${PORT}; installed Adminer versions: ${installed}`);
});
