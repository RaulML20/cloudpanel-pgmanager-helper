<?php
declare(strict_types=1);

/*
 * Local Adminer gateway. The browser reaches this file only through the Node
 * helper, which has already validated the client IP and CloudPanel admin
 * session. Credentials are resolved again from the site's config/.env on every
 * request and exist only in this PHP process until the response ends.
 */

function pgmanager_fail(string $message, int $status = 500): void {
    http_response_code($status);
    header('Content-Type: text/html; charset=utf-8');
    echo '<!doctype html><html><head><meta charset="utf-8"><title>PostgreSQL Manager</title></head>',
         '<body style="font:14px/1.5 system-ui,sans-serif;margin:3em auto;max-width:48em;color:#333">',
         '<h1 style="font-size:1.3em">PostgreSQL Manager</h1><p>',
         htmlspecialchars($message, ENT_QUOTES, 'UTF-8'),
         '</p><p><a href="javascript:window.close()">Close</a></p></body></html>';
    exit;
}

function pgmanager_active_adminer_file(): ?string {
    $root = getenv('ADMINER_ROOT') ?: '/opt/adminer';
    $files = glob(rtrim($root, '/') . '/adminer-*.php') ?: [];
    $versions = [];
    foreach($files as $file) {
        if(preg_match('/adminer-(\d+\.\d+\.\d+)\.php$/', $file, $match) && is_readable($file)) {
            $versions[$match[1]] = $file;
        }
    }
    if(!$versions) return null;
    uksort($versions, 'version_compare');
    return end($versions) ?: null;
}

function pgmanager_resolve_connection(string $domainName, string $databaseName): array {
    $port = (int)(getenv('PGMANAGER_HELPER_PORT') ?: 7881);
    $origin = getenv('PGMANAGER_HELPER_ALLOWED_ORIGIN') ?: '';
    $query = http_build_query(['domainName' => $domainName, 'databaseName' => $databaseName]);
    $headers = "Origin: {$origin}\r\nCookie: " . ($_SERVER['HTTP_COOKIE'] ?? '') . "\r\nAccept: application/json\r\n";
    $context = stream_context_create([
        'http' => ['method' => 'GET', 'header' => $headers, 'timeout' => 20, 'ignore_errors' => true],
        'ssl' => ['verify_peer' => false, 'verify_peer_name' => false],
    ]);
    $body = @file_get_contents("https://127.0.0.1:{$port}/internal/adminer-connection?{$query}", false, $context);
    if(false === $body) pgmanager_fail('The PgManager helper could not resolve the backend connection.');
    $payload = json_decode($body, true);
    if(!is_array($payload) || empty($payload['ok']) || !isset($payload['connection'])) {
        $message = is_array($payload) && !empty($payload['error'])
            ? (string)$payload['error'] : 'The backend connection could not be resolved.';
        pgmanager_fail($message);
    }
    return $payload['connection'];
}

$adminerFile = pgmanager_active_adminer_file();
if(null === $adminerFile) pgmanager_fail('No Adminer version is installed.');
if(preg_match('/adminer-(\d+\.\d+\.\d+)\.php$/', $adminerFile, $match)
    && version_compare($match[1], '5.0.0', '<')) {
    pgmanager_fail('Adminer 5.0.0 or newer is required.');
}

// Make Adminer generate public proxy URLs, not its private /adminer.php path.
$_SERVER['SCRIPT_NAME'] = '/adminer';
$_SERVER['PHP_SELF'] = '/adminer';
$_SERVER['REQUEST_URI'] = '/adminer' . (!empty($_SERVER['QUERY_STRING']) ? '?' . $_SERVER['QUERY_STRING'] : '');

session_name('pgmanager_adminer_sid');
session_set_cookie_params([
    'lifetime' => 0,
    'path' => '/adminer',
    'secure' => true,
    'httponly' => true,
    'samesite' => 'Strict',
]);
session_cache_limiter('');
ini_set('session.use_trans_sid', '0');
session_start();

if(isset($_GET['file'])) {
    require $adminerFile;
    exit;
}

if(!empty($_SERVER['HTTP_X_PGMANAGER_DOMAIN']) && !empty($_SERVER['HTTP_X_PGMANAGER_DATABASE'])) {
    $_SESSION['pgmanager_target'] = [
        'domainName' => (string)$_SERVER['HTTP_X_PGMANAGER_DOMAIN'],
        'databaseName' => (string)$_SERVER['HTTP_X_PGMANAGER_DATABASE'],
    ];
}

$target = $_SESSION['pgmanager_target'] ?? null;
if(!is_array($target) || empty($target['domainName']) || empty($target['databaseName'])) {
    pgmanager_fail('The Adminer target is missing. Open it again from CloudPanel.', 400);
}

$connection = pgmanager_resolve_connection($target['domainName'], $target['databaseName']);

if(!isset($_GET['db'])) {
    header('Location: /adminer?' . http_build_query([
        'pgsql' => $connection['host'] . ':' . $connection['port'],
        'username' => $connection['user'],
        'db' => $connection['dbname'],
    ]));
    exit;
}

$_GET['pgsql'] = $connection['host'] . ':' . $connection['port'];
$_GET['username'] = $connection['user'];
$_GET['db'] = $connection['dbname'];
foreach(['sqlite', 'oracle', 'mssql', 'server', 'mysql'] as $driver) unset($_GET[$driver]);
$_SESSION['pwds']['pgsql'][$_GET['pgsql']][$_GET['username']] = 'pgmanager';

function adminer_object() {
    $connection = $GLOBALS['pgmanagerConnection'];
    $label = $GLOBALS['pgmanagerLabel'];

    if(!class_exists('CloudPanelPgManagerAdminerPlugin', false)) {
        class CloudPanelPgManagerAdminerPlugin extends \Adminer\Adminer {
            public $pgmanagerConnection;
            public $pgmanagerLabel;

            public function credentials() {
                return [
                    $this->pgmanagerConnection['host'] . ':' . $this->pgmanagerConnection['port'],
                    $this->pgmanagerConnection['user'],
                    $this->pgmanagerConnection['password'],
                ];
            }
            public function login($login, $password) { return true; }
            public function database() { return $this->pgmanagerConnection['dbname']; }
            public function databases($flush = true) { return [$this->pgmanagerConnection['dbname']]; }
            public function permanentLogin($create = false) { return ''; }
            public function name() { return htmlspecialchars($this->pgmanagerLabel, ENT_QUOTES, 'UTF-8'); }
        }
    }

    $plugin = new CloudPanelPgManagerAdminerPlugin();
    $plugin->pgmanagerConnection = $connection;
    $plugin->pgmanagerLabel = $label;
    return $plugin;
}

$GLOBALS['pgmanagerConnection'] = $connection;
$GLOBALS['pgmanagerLabel'] = $target['databaseName'] . ' — ' . $target['domainName'];
require $adminerFile;
