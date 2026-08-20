#!/usr/bin/env node
'use strict';

/*
 * Daily PostgreSQL backups for databases managed by cloudpanel-pgmanager-helper.
 *
 * Each dump is written below /home/<site-user>/backups/postgresql/ so that
 * CloudPanel's existing remote backup carries it away together with the rest
 * of the site home. Nothing here reads, writes or schedules anything that
 * belongs to CloudPanel: /home/<site-user>/backups/databases/ is treated as
 * off limits, rclone is never invoked, and the cron entry has a file of its
 * own.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const dotenv = require('dotenv');

const INSTALL_DIR = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(INSTALL_DIR, '.env') });

const core = require('../lib/postgres-core');
const backupConfig = require('../lib/backup-config');

const DATA_DIR = process.env.PGMANAGER_HELPER_DATA_DIR || '/var/lib/cloudpanel-pgmanager-helper';
const BACKUP_TIMEOUT = Number(process.env.PGMANAGER_BACKUP_TIMEOUT_MS || (4 * 60 * 60 * 1000));
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_LOGGED_STDERR = 2048;

const registry = core.createCore({ dataDir: DATA_DIR });
const config = backupConfig.createBackupConfig({ dataDir: DATA_DIR, installDir: INSTALL_DIR });

/* ------------------------------------------------------------------ logging */

let logStream = null;

function openLog() {
    try {
        fs.mkdirSync(backupConfig.LOG_DIR, { recursive: true, mode: 0o750 });
        rotateLog();
        logStream = fs.createWriteStream(backupConfig.LOG_FILE, { flags: 'a', mode: 0o640 });
    } catch(error) {
        process.stderr.write(`Could not open the PgManager backup log: ${error.message}\n`);
    }
}

/*
 * A single rename keeps the log bounded without asking the administrator to
 * install a logrotate snippet that the uninstaller would then have to clean up.
 */
function rotateLog() {
    try {
        if(fs.statSync(backupConfig.LOG_FILE).size < MAX_LOG_BYTES) return;
        fs.renameSync(backupConfig.LOG_FILE, `${backupConfig.LOG_FILE}.1`);
    } catch(error) {}
}

function log(level, message) {
    const line = `[${new Date().toISOString()}] ${level} ${message}\n`;
    if(logStream) logStream.write(line);
    else process.stdout.write(line);
}

function closeLog() {
    return new Promise((resolve) => {
        if(!logStream) return resolve();
        logStream.end(resolve);
    });
}

/* -------------------------------------------------------------------- paths */

function todayStamp(date = new Date()) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function isBackupDateName(name) {
    return /^\d{4}-\d{2}-\d{2}$/.test(name);
}

/*
 * Every path component is validated before it is joined, and the result is
 * checked again afterwards. The CloudPanel assertion is redundant by design:
 * should a future change ever build the wrong path, this fails loudly instead
 * of writing into a directory CloudPanel owns.
 */
function siteBackupRoot(siteUser) {
    if(!core.isSafeSiteUser(siteUser)) throw new Error(`Refusing to use an unexpected site user: ${siteUser}`);
    return path.join('/home', siteUser, 'backups', backupConfig.BACKUP_ROOT_NAME);
}

function assertOutsideCloudPanelBackups(targetPath) {
    const parts = path.resolve(targetPath).split(path.sep);
    const backupsIndex = parts.indexOf('backups');
    if(backupsIndex !== -1 && parts[backupsIndex + 1] === backupConfig.CLOUDPANEL_BACKUP_DIRECTORY) {
        throw new Error(`Refusing to touch the CloudPanel backup directory: ${targetPath}`);
    }
}

/*
 * Creates a directory owned by the site user with the same restrictive mode
 * CloudPanel uses for its own backup directories. An existing directory keeps
 * whatever the administrator set on it.
 */
function ensureDirectory(directory, siteSystemUser) {
    assertOutsideCloudPanelBackups(directory);

    let stat = null;
    try { stat = fs.lstatSync(directory); } catch(error) {}

    if(stat) {
        if(stat.isSymbolicLink()) throw new Error(`Refusing to follow a symlink at ${directory}`);
        if(!stat.isDirectory()) throw new Error(`${directory} exists and is not a directory`);
        return;
    }

    fs.mkdirSync(directory, { recursive: true, mode: 0o750 });
    fs.chmodSync(directory, 0o750);
    fs.chownSync(directory, siteSystemUser.uid, siteSystemUser.gid);
}

/* ------------------------------------------------------------- associations */

/*
 * Resolves which site a database belongs to using the two associations the
 * extension already maintains: the database owner being a site user, and the
 * domain/database registry written when a database is created from the panel.
 */
function resolveSiteForDatabase(databaseName, owner, sites) {
    for(const [domainName, databases] of Object.entries(sites)) {
        if(!databases.includes(databaseName)) continue;
        const siteUser = core.findSiteUserForDomain(domainName);
        if(siteUser) return { domainName, siteUser, source: 'registry' };
    }

    if(core.isSafeSiteUser(owner)) {
        const domains = core.findDomainsForSiteUser(owner);
        if(domains.length) return { domainName: domains[0], siteUser: owner, source: 'owner' };
    }

    return null;
}

function collectTargets(rows) {
    const sites = registry.loadPostgresSites();
    const targets = [];
    const skipped = [];

    for(const row of rows) {
        if(!row || !core.isSafePostgresIdentifier(row.name)) continue;
        if(['postgres', 'template0', 'template1'].includes(row.name)) continue;

        const site = resolveSiteForDatabase(row.name, row.owner, sites);
        if(!site) {
            skipped.push(row.name);
            continue;
        }
        targets.push({ databaseName: row.name, ...site });
    }

    return { targets, skipped };
}

/* ------------------------------------------------------------------- dumping */

/*
 * pg_dump runs as the postgres system user, exactly like every other
 * PostgreSQL operation in this extension: peer authentication means no
 * password ever reaches argv, the environment or this log.
 *
 * The child never opens the destination itself. Root opens the temporary file
 * and hands pg_dump the descriptor as stdout, which avoids granting postgres
 * write access inside the site home and keeps the temporary file in the same
 * directory as the final one, so the rename below is atomic.
 */
function runDump(pgDump, cluster, databaseName, fd) {
    return new Promise((resolve) => {
        const child = spawn(pgDump, [
            '--format=custom', '--compress=6', '--no-owner', '--no-privileges', '--no-password',
            '--port', String(cluster.port || 5432), '--dbname', databaseName
        ], {
            uid: cluster.postgresUser.uid,
            gid: cluster.postgresUser.gid,
            env: core.postgresToolEnvironment(),
            stdio: ['ignore', fd, 'pipe']
        });

        let stderr = '';
        let timedOut = false;

        child.stderr.on('data', (chunk) => {
            if(stderr.length < MAX_LOGGED_STDERR) stderr += String(chunk);
        });

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 10000).unref();
        }, BACKUP_TIMEOUT);

        child.on('error', (error) => {
            clearTimeout(timer);
            resolve({ ok: false, error: error.message });
        });

        child.on('close', (code, signal) => {
            clearTimeout(timer);
            const detail = stderr.trim().slice(0, MAX_LOGGED_STDERR);
            if(timedOut) return resolve({ ok: false, error: `pg_dump timed out after ${BACKUP_TIMEOUT} ms` });
            if(code === 0) return resolve({ ok: true });
            resolve({ ok: false, error: detail || `pg_dump exited with ${signal || code}` });
        });
    });
}

async function backupDatabase(target, context) {
    const { databaseName, domainName, siteUser } = target;
    const siteSystemUser = core.getSystemUser(siteUser);
    if(!siteSystemUser) throw new Error(`System user ${siteUser} no longer exists`);

    core.assertPostgresIdentifier(databaseName, 'Database name');

    const backupsRoot = path.join('/home', siteUser, 'backups');
    const databaseRoot = path.join(siteBackupRoot(siteUser), databaseName);
    const destination = path.join(databaseRoot, todayStamp());
    const temporaryFile = path.join(destination, '.backup.dump.tmp');
    const finalFile = path.join(destination, 'backup.dump');

    ensureDirectory(backupsRoot, siteSystemUser);
    ensureDirectory(siteBackupRoot(siteUser), siteSystemUser);
    ensureDirectory(databaseRoot, siteSystemUser);
    ensureDirectory(destination, siteSystemUser);

    // The directories exist now, so the resolved path can be compared with the
    // location this site is allowed to write to.
    const resolvedDestination = fs.realpathSync(destination);
    const allowedRoot = fs.realpathSync(siteBackupRoot(siteUser));
    if(!resolvedDestination.startsWith(allowedRoot + path.sep)) {
        throw new Error(`Backup destination resolves outside ${allowedRoot}: ${resolvedDestination}`);
    }
    assertOutsideCloudPanelBackups(resolvedDestination);

    try { fs.unlinkSync(temporaryFile); } catch(error) {}

    const startedAt = Date.now();
    const fd = fs.openSync(temporaryFile, 'wx', 0o600);
    let result;

    try {
        result = await runDump(context.pgDump, context.cluster, databaseName, fd);

        if(result.ok) {
            const size = fs.fstatSync(fd).size;
            if(size < 1) result = { ok: false, error: 'pg_dump produced an empty dump' };
            else {
                fs.fsyncSync(fd);
                fs.fchmodSync(fd, 0o640);
                fs.fchownSync(fd, siteSystemUser.uid, siteSystemUser.gid);
                result.size = size;
            }
        }
    } finally {
        try { fs.closeSync(fd); } catch(error) {}
    }

    if(!result.ok) {
        try { fs.unlinkSync(temporaryFile); } catch(error) {}
        throw new Error(result.error);
    }

    // Only a dump that pg_dump finished successfully becomes visible as
    // backup.dump; a partial file never carries that name.
    fs.renameSync(temporaryFile, finalFile);

    return {
        path: finalFile,
        size: result.size,
        durationMs: Date.now() - startedAt,
        databaseRoot
    };
}

/* ----------------------------------------------------------------- retention */

/*
 * Deletes only dated directories directly below this database's own backup
 * directory. No shell, no glob and no recursive search: the deletion cannot
 * reach another database, another site or CloudPanel's own backups.
 *
 * It runs only after today's dump succeeded, so a failing database keeps its
 * older backups until there is a fresh one to replace them.
 */
function applyRetention(databaseRoot, retentionDays) {
    assertOutsideCloudPanelBackups(databaseRoot);

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (retentionDays - 1));
    const cutoffStamp = todayStamp(cutoff);

    let entries = [];
    try {
        entries = fs.readdirSync(databaseRoot, { withFileTypes: true });
    } catch(error) {
        return [];
    }

    const removed = [];
    for(const entry of entries) {
        if(!entry.isDirectory() || !isBackupDateName(entry.name)) continue;
        if(entry.name >= cutoffStamp) continue;

        const candidate = path.join(databaseRoot, entry.name);
        assertOutsideCloudPanelBackups(candidate);
        try {
            fs.rmSync(candidate, { recursive: true, force: true });
            removed.push(entry.name);
        } catch(error) {
            log('ERROR', `Could not remove expired backup ${candidate}: ${error.message}`);
        }
    }
    return removed;
}

/* ----------------------------------------------------------------- execution */

async function runBackups() {
    const settings = config.loadSettings();

    if(!settings.enabled) {
        log('INFO', 'Daily PostgreSQL backups are disabled; nothing to do');
        return 0;
    }

    const cluster = await core.detectPostgresCluster();
    if(!cluster.installed) {
        log('INFO', 'PostgreSQL is not installed; nothing to do');
        return 0;
    }
    if(cluster.status && cluster.status !== 'online' && cluster.status !== 'unknown') {
        log('ERROR', `PostgreSQL cluster is ${cluster.status}; skipping this run`);
        return 0;
    }

    const postgresUser = core.getSystemUser('postgres');
    if(!postgresUser) {
        log('ERROR', 'The postgres system user was not found; skipping this run');
        return 0;
    }
    cluster.postgresUser = postgresUser;

    let rows;
    try {
        rows = await core.queryPostgresDatabaseRows(cluster, postgresUser);
    } catch(error) {
        log('ERROR', `Could not list PostgreSQL databases: ${error.message}`);
        return 0;
    }

    const pgDump = await core.resolvePostgresTool(cluster, 'pg_dump');
    const { targets, skipped } = collectTargets(rows);

    log('INFO', `Starting daily PostgreSQL backups: ${targets.length} database(s), retention ${settings.retentionDays} day(s)`);
    for(const name of skipped) {
        log('INFO', `Skipped ${name}: no site association`);
    }

    const state = config.loadState();
    let failures = 0;

    for(const target of targets) {
        const { databaseName, domainName, siteUser } = target;
        if(!state[domainName] || typeof state[domainName] !== 'object') state[domainName] = {};

        try {
            const outcome = await backupDatabase(target, { cluster, pgDump });
            log('INFO', `Backed up ${databaseName} (site ${domainName}, user ${siteUser}) to ${outcome.path}: ${outcome.size} bytes in ${outcome.durationMs} ms`);

            const removed = applyRetention(outcome.databaseRoot, settings.retentionDays);
            if(removed.length) {
                log('INFO', `Retention removed ${removed.length} expired backup(s) of ${databaseName}: ${removed.join(', ')}`);
            }

            state[domainName][databaseName] = {
                at: new Date().toISOString(),
                ok: true,
                size: outcome.size,
                path: outcome.path,
                siteUser,
                error: null
            };
        } catch(error) {
            failures += 1;
            // A failing database never stops the others, and never affects
            // CloudPanel's own backups.
            log('ERROR', `Backup of ${databaseName} (site ${domainName}) failed: ${error.message}`);
            state[domainName][databaseName] = {
                at: new Date().toISOString(),
                ok: false,
                size: null,
                path: null,
                siteUser,
                error: String(error.message || 'Unknown error').slice(0, MAX_LOGGED_STDERR)
            };
        }
    }

    try {
        config.saveState(state);
    } catch(error) {
        log('ERROR', `Could not persist the backup state: ${error.message}`);
    }

    log('INFO', `Finished daily PostgreSQL backups: ${targets.length - failures} succeeded, ${failures} failed`);
    return 0;
}

/* ----------------------------------------------------------------------- CLI */

function setup(enabled) {
    fs.mkdirSync(backupConfig.LOG_DIR, { recursive: true, mode: 0o750 });

    // A reinstall must not overwrite settings the administrator changed in the
    // panel, so an existing file only has its enabled flag applied.
    const existing = config.settingsExist();
    const settings = config.saveSettings({
        ...(existing ? config.loadSettings() : { ...backupConfig.DEFAULT_SETTINGS, hour: backupConfig.suggestBackupHour() }),
        enabled
    });

    const action = config.applyCron(settings);
    process.stdout.write(JSON.stringify({ ok: true, settings, cron: action, reused: existing }) + '\n');
    return 0;
}

async function main() {
    if(process.getuid && process.getuid() !== 0) {
        process.stderr.write('The PgManager backup runner must run as root.\n');
        return 1;
    }

    const args = process.argv.slice(2);

    if(args.includes('--enable')) return setup(true);
    if(args.includes('--disable')) return setup(false);

    if(args.includes('--remove-cron')) {
        const removed = config.removeCron();
        process.stdout.write(JSON.stringify({ ok: true, removed }) + '\n');
        return 0;
    }

    if(args.includes('--apply-cron')) {
        const action = config.applyCron(config.loadSettings());
        process.stdout.write(JSON.stringify({ ok: true, cron: action }) + '\n');
        return 0;
    }

    if(args.includes('--status')) {
        process.stdout.write(JSON.stringify({
            ok: true,
            settings: config.loadSettings(),
            suggestedHour: backupConfig.suggestBackupHour(),
            state: config.loadState()
        }, null, 2) + '\n');
        return 0;
    }

    if(args.length) {
        process.stderr.write('Usage: backup.js [--enable|--disable|--apply-cron|--remove-cron|--status]\n');
        return 2;
    }

    openLog();
    try {
        return await runBackups();
    } catch(error) {
        log('ERROR', `The backup run stopped unexpectedly: ${error.message}`);
        return 0;
    } finally {
        await closeLog();
    }
}

main().then((code) => process.exit(code)).catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exit(1);
});
