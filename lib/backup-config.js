'use strict';

/*
 * Settings, per-database state and the cron entry for the daily PostgreSQL
 * backups.
 *
 * Everything in here is deliberately additive: the cron file has a name of its
 * own, and CloudPanel's /etc/cron.d/clp is only ever read, never written. If
 * PgManager is removed, deleting this cron file is enough to leave CloudPanel
 * exactly as it was.
 */

const fs = require('fs');
const path = require('path');

const { writeJsonFile } = require('./postgres-core');

const CRON_FILE = '/etc/cron.d/cloudpanel-pgmanager-helper-postgresql-backup';
const CLOUDPANEL_CRON_FILE = '/etc/cron.d/clp';
const LOCK_FILE = '/run/lock/cloudpanel-pgmanager-helper-backup.lock';
const LOG_DIR = '/var/log/cloudpanel-pgmanager-helper';
const LOG_FILE = path.join(LOG_DIR, 'backup.log');
const BACKUP_ROOT_NAME = 'postgresql';

// CloudPanel owns backups/databases; ours never goes anywhere near it.
const CLOUDPANEL_BACKUP_DIRECTORY = 'databases';

const DEFAULT_SETTINGS = {
    enabled: false,
    hour: 1,
    minute: 0,
    retentionDays: 7
};

function clampInteger(value, min, max, fallback) {
    const parsed = Number(value);
    if(!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
    return parsed;
}

function normalizeSettings(values) {
    const source = (values && typeof values === 'object' && !Array.isArray(values)) ? values : {};
    return {
        enabled: source.enabled === true,
        hour: clampInteger(source.hour, 0, 23, DEFAULT_SETTINGS.hour),
        minute: clampInteger(source.minute, 0, 59, DEFAULT_SETTINGS.minute),
        retentionDays: clampInteger(source.retentionDays, 1, 365, DEFAULT_SETTINGS.retentionDays)
    };
}

/*
 * Reads CloudPanel's cron entry to learn when its remote backup starts, so the
 * dumps are already sitting in the site home by the time rclone picks the home
 * up. Read-only on purpose: an unparseable file simply falls back to the
 * conservative default instead of touching anything.
 */
function detectCloudPanelBackupHour(cronFile = CLOUDPANEL_CRON_FILE) {
    let content;
    try {
        content = fs.readFileSync(cronFile, 'utf8');
    } catch(error) {
        return null;
    }

    let earliest = null;
    for(const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if(!line || line.startsWith('#')) continue;
        if(!/backup/i.test(line)) continue;

        const fields = line.split(/\s+/);
        if(fields.length < 6) continue;

        // Only a plain numeric hour tells us reliably when the job runs; a
        // step or list expression is ambiguous, so it is ignored.
        const minute = fields[0];
        const hour = fields[1];
        if(!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) continue;

        const parsed = Number(hour);
        if(parsed < 0 || parsed > 23) continue;
        if(earliest === null || parsed < earliest) earliest = parsed;
    }

    return earliest;
}

/*
 * Two hours of headroom between our dump and CloudPanel's remote sync.
 */
function suggestBackupHour() {
    const cloudPanelHour = detectCloudPanelBackupHour();
    if(cloudPanelHour === null) return DEFAULT_SETTINGS.hour;
    return ((cloudPanelHour - 2) + 24) % 24;
}

function createBackupConfig(options = {}) {
    const dataDir = options.dataDir || '/var/lib/cloudpanel-pgmanager-helper';
    const installDir = options.installDir || path.resolve(__dirname, '..');
    const nodeBinary = options.nodeBinary || process.execPath;
    const settingsFile = path.join(dataDir, 'postgres-backup-settings.json');
    const stateFile = path.join(dataDir, 'postgres-backup-state.json');
    const backupScript = path.join(installDir, 'bin', 'backup.js');

    function loadSettings() {
        try {
            return normalizeSettings(JSON.parse(fs.readFileSync(settingsFile, 'utf8')));
        } catch(error) {
            return { ...DEFAULT_SETTINGS };
        }
    }

    function settingsExist() {
        try {
            return fs.statSync(settingsFile).isFile();
        } catch(error) {
            return false;
        }
    }

    function saveSettings(values) {
        const settings = normalizeSettings(values);
        fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        writeJsonFile(settingsFile, settings);
        return settings;
    }

    function loadState() {
        try {
            const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
            if(!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
            return parsed;
        } catch(error) {
            return {};
        }
    }

    function saveState(state) {
        fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        writeJsonFile(stateFile, state);
    }

    function cronFileContent(settings) {
        return [
            '# cloudpanel-pgmanager-helper postgresql backup',
            '# Managed by cloudpanel-pgmanager-helper. CloudPanel crons are never modified.',
            'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            `${settings.minute} ${settings.hour} * * * root flock -n ${LOCK_FILE} ${nodeBinary} ${backupScript} >/dev/null 2>&1`,
            ''
        ].join('\n');
    }

    /*
     * Rewrites the cron file only when its content actually changes, so
     * re-running the installer or saving unchanged settings is a no-op and can
     * never leave a duplicated entry behind.
     */
    function applyCron(settings) {
        settings = normalizeSettings(settings);

        if(!settings.enabled) return removeCron() ? 'removed' : 'absent';

        const desired = cronFileContent(settings);
        let current = null;
        try { current = fs.readFileSync(CRON_FILE, 'utf8'); } catch(error) {}
        if(current === desired) return 'unchanged';

        const temporary = `${CRON_FILE}.tmp`;
        fs.writeFileSync(temporary, desired, { mode: 0o644 });
        fs.chmodSync(temporary, 0o644);
        fs.renameSync(temporary, CRON_FILE);
        return current === null ? 'created' : 'updated';
    }

    function removeCron() {
        try {
            fs.unlinkSync(CRON_FILE);
            return true;
        } catch(error) {
            return false;
        }
    }

    return {
        dataDir,
        settingsFile,
        stateFile,
        backupScript,
        loadSettings,
        settingsExist,
        saveSettings,
        loadState,
        saveState,
        cronFileContent,
        applyCron,
        removeCron
    };
}

module.exports = {
    CRON_FILE,
    CLOUDPANEL_CRON_FILE,
    LOCK_FILE,
    LOG_DIR,
    LOG_FILE,
    BACKUP_ROOT_NAME,
    CLOUDPANEL_BACKUP_DIRECTORY,
    DEFAULT_SETTINGS,
    normalizeSettings,
    detectCloudPanelBackupHour,
    suggestBackupHour,
    createBackupConfig
};
