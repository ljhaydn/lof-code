<?php
// lof-speaker.php
// Lights on Falcon speaker control brain.
//
// Architecture:
// - ALL decisions (viewer + physical button) go through this file.
// - FPP scripts only flip GPIO and send a "notify" back so WP can confirm.
// - WP owns:
//     * on/off window timing
//     * "already on" behavior (Option 1B)
//     * extension when near expiry
//     * best-effort "don't cut off mid-song" protection.
//
// Endpoints:
//   GET  ?action=status
//       -> JSON { success, speakerOn, remainingSeconds, message, ... }
//
//   POST/GET ?action=on[&source=viewer|physical]
//       -> "Need sound?" or physical button press.
//          * If OFF -> turn ON (call on-script) and start timer.
//          * If ON & plenty of time left -> no FPP call, just "already on".
//          * If ON & almost out -> call on-script and extend.
//
//   GET/POST ?action=notify&status=on|off&source=fpp-exec|...
//       -> Called by FPP scripts after they flip GPIO,
//          so WP can confirm the execution actually happened.

require_once $_SERVER['DOCUMENT_ROOT'] . '/wp-load.php';

header('Content-Type: application/json');

// ------------------------------------------------------------
// JSON helper
// ------------------------------------------------------------
function lof_speaker_json_exit($code, $payload) {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}
function lof_is_lan_ip($ip) {
    if (!filter_var($ip, FILTER_VALIDATE_IP)) {
        return false;
    }

    $parts = explode('.', $ip);
    if (count($parts) !== 4) {
        return false;
    }

    // 10.0.0.0/8
    if ($parts[0] === '10') {
        return true;
    }

    // 192.168.0.0/16
    if ($parts[0] === '192' && $parts[1] === '168') {
        return true;
    }

    // 172.16.0.0 – 172.31.0.0
    if ($parts[0] === '172') {
        $second = (int) $parts[1];
        if ($second >= 16 && $second <= 31) {
            return true;
        }
    }

    return false;
}

// ------------------------------------------------------------
// Determine action
// ------------------------------------------------------------
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$action = $_GET['action'] ?? $_POST['action'] ?? null;
if ($action === null) {
    $action = ($method === 'POST') ? 'on' : 'status';
}

// ------------------------------------------------------------
// Basic mobile-ish check (UX only; physical button bypasses this)
// ------------------------------------------------------------
$userAgent  = $_SERVER['HTTP_USER_AGENT'] ?? '';
$isMobileUA = preg_match('/Android|iPhone|iPad|iPod/i', $userAgent);

// ------------------------------------------------------------
// CONFIG
// ------------------------------------------------------------

// FPP LAN base URL
$fppHost = 'http://10.9.7.102';

// FPP API key (leave blank if not using auth)
$fppApiKey = '';

// Simple ON/OFF scripts on FPP (must exist in FPP scripts folder)
$onScriptName  = 'speaker-amp-on.sh';
$offScriptName = 'speaker-amp-off.sh';

// WordPress option key where we store speaker state
$stateKey = 'lof_speaker_state_v4';

// How close to expiry counts as "almost done" for extension (Option 1B)
// and when to consider running the mid-song guard.
$extensionThreshold = 30; // seconds

// Optional: IP address we expect notify() calls from (your FPP host)
$notifyIp = '10.9.7.102';

// Speaker mode + override text from LOF Extras
$lofExtras          = get_option('lof_extras_settings', []);
$speakerMode        = isset($lofExtras['speaker_mode']) ? $lofExtras['speaker_mode'] : 'automatic';
$lockedOnStatusText = '';
if (!empty($lofExtras['speaker_locked_on_status']) && is_string($lofExtras['speaker_locked_on_status'])) {
    $lockedOnStatusText = trim($lofExtras['speaker_locked_on_status']);
    if ($lockedOnStatusText === '') {
        $lockedOnStatusText = '';
    }
}
// ------------------------------------------------------------
// Duration: admin configurable via LOF Viewer Extras, fallback 300s
// ------------------------------------------------------------
function lof_speaker_get_duration_seconds() {
    $default = 300; // 5 minutes
    $opts    = get_option('lof_viewer_extras_settings', []);
    if (is_array($opts) && isset($opts['speaker_duration_seconds'])) {
        $val = (int) $opts['speaker_duration_seconds'];
        if ($val < 60)  $val = 60;
        if ($val > 900) $val = 900;
        return $val;
    }
    return $default;
}

$speakerSecs = lof_speaker_get_duration_seconds();

// ------------------------------------------------------------
// Helper: generic GET JSON from FPP
// ------------------------------------------------------------
function lof_call_fpp_get_json($path) {
    global $fppHost;

    $url = rtrim($fppHost, '/') . $path;

    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_CUSTOMREQUEST, 'GET');
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);

    $responseBody = curl_exec($ch);
    $httpCode     = curl_getinfo($ch, CURLINFO_HTTP_CODE);

    if ($responseBody === false) {
        curl_close($ch);
        return ['ok' => false, 'code' => 0, 'json' => null];
    }

    curl_close($ch);

    $json = json_decode($responseBody, true);
    return [
        'ok'   => ($httpCode >= 200 && $httpCode < 300 && is_array($json)),
        'code' => $httpCode,
        'json' => $json,
    ];
}

// ------------------------------------------------------------
// Helper: call FPP Run Script using the known-good pattern
// ------------------------------------------------------------
function lof_call_fpp_run_script($scriptName, $apiKey = '') {
    global $fppHost;

    $url = rtrim($fppHost, '/') . '/api/command';

    $payload = [
        'command' => 'Run Script',
        'args'    => [(string)$scriptName],
    ];

    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_CUSTOMREQUEST, 'POST');
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);

    $jsonBody = json_encode($payload);
    $headers  = [
        'Content-Type: application/json',
        'Content-Length' => strlen($jsonBody),
    ];

    if (!empty($apiKey)) {
        $headers[] = 'Authorization: Bearer ' . $apiKey;
    }

    curl_setopt($ch, CURLOPT_POSTFIELDS, $jsonBody);
    curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);

    $responseBody = curl_exec($ch);
    $httpCode     = curl_getinfo($ch, CURLINFO_HTTP_CODE);

    if ($responseBody === false) {
        $err = curl_error($ch);
        curl_close($ch);
        return ['ok' => false, 'code' => 0, 'error' => $err, 'json' => null];
    }

    curl_close($ch);

    $json = json_decode($responseBody, true);
    return [
        'ok'    => ($httpCode >= 200 && $httpCode < 300),
        'code'  => $httpCode,
        'error' => null,
        'json'  => $json,
    ];
}

// ------------------------------------------------------------
// State helpers
// ------------------------------------------------------------
function lof_speaker_get_state($stateKey) {
    $state = get_option($stateKey, null);
    if (!is_array($state)) {
        $state = [];
    }

    $defaults = [
        'status'               => 'off', // 'on' | 'off'
        'expires_at'           => 0,     // unix timestamp
        'last_source'          => '',    // 'viewer' | 'physical' | 'fpp-exec' | ''
        'last_updated'         => 0,
        'last_notified_status' => '',    // last status reported by notify()
        'last_notified_at'     => 0,
    ];

    return array_merge($defaults, $state);
}

function lof_speaker_save_state($stateKey, array $state) {
    update_option($stateKey, $state, false);
}

function lof_speaker_remaining_seconds(array $state) {
    $now     = time();
    $expires = isset($state['expires_at']) ? (int)$state['expires_at'] : 0;
    $rem     = $expires - $now;
    return ($rem > 0) ? $rem : 0;
}

// ------------------------------------------------------------
// Helper: best-effort "song remaining" lookup from FPP
// ------------------------------------------------------------
function lof_speaker_get_song_remaining_seconds() {
    // We try FPP's status endpoint(s) and look for known fields.
    // If we can't find anything, we return null and do nothing.
    $candidates = [
        '/api/fppd/status',
        '/fppd/status',
    ];

    foreach ($candidates as $path) {
        $resp = lof_call_fpp_get_json($path);
        if (!$resp['ok'] || !is_array($resp['json'])) {
            continue;
        }

        $data = $resp['json'];

        // Try a few likely field names (varies by FPP version)
        $keys = [
            'mediaSecondsRemaining',
            'MediaSecondsRemaining',
            'media_seconds_remaining',
            'secondsRemaining',
            'playlistSecondsRemaining',
        ];

        foreach ($keys as $k) {
            if (isset($data[$k]) && is_numeric($data[$k])) {
                $val = (int)$data[$k];
                if ($val > 0) {
                    return $val;
                }
            }
        }
    }

    return null;
}

// ------------------------------------------------------------
// Helper: apply "don't cut off mid-song" guard
// ------------------------------------------------------------
function lof_speaker_apply_mid_song_guard(&$state, $stateKey, $extensionThreshold) {
    // Only apply if we're ON and within the threshold window.
    $now       = time();
    $remaining = lof_speaker_remaining_seconds($state);

    if ($state['status'] !== 'on' || $remaining <= 0 || $remaining > $extensionThreshold) {
        return;
    }

    // Best-effort: ask FPP how long is left in the current media.
    $songRemaining = lof_speaker_get_song_remaining_seconds();
    if ($songRemaining === null || $songRemaining <= 0) {
        // We couldn't determine song length; do nothing.
        return;
    }

    // If the song will still be playing after our window ends, extend our window
    // so the speakers stay on until the song finishes.
    if ($songRemaining > $remaining) {
        $state['expires_at']   = $now + $songRemaining;
        $state['last_updated'] = $now;
        lof_speaker_save_state($stateKey, $state);
    }
}

// ------------------------------------------------------------
// Load and normalize state, then apply mid-song guard
// ------------------------------------------------------------
$now   = time();
$state = lof_speaker_get_state($stateKey);

// First normalize simple expiry.
$remaining = lof_speaker_remaining_seconds($state);
$speakerOn = ($state['status'] === 'on' && $remaining > 0);

if ($state['status'] === 'on' && $remaining === 0) {
    $state['status']       = 'off';
    $state['expires_at']   = $now;
    $state['last_updated'] = $now;
    lof_speaker_save_state($stateKey, $state);
    $speakerOn = false;
}

// Now apply "don't cut off mid-song" logic, then recompute remaining.
lof_speaker_apply_mid_song_guard($state, $stateKey, $extensionThreshold);
$remaining = lof_speaker_remaining_seconds($state);
$speakerOn = ($state['status'] === 'on' && $remaining > 0);

// ------------------------------------------------------------
// ACTION: status
// ------------------------------------------------------------
if ($action === 'status') {
    global $offScriptName, $fppApiKey;

    // If we just discovered it's expired, best-effort OFF at hardware level
    if (!$speakerOn && $remaining === 0 && !empty($offScriptName)) {
        lof_call_fpp_run_script($offScriptName, $fppApiKey);
    }

    global $speakerMode, $lockedOnStatusText;

    if ($speakerMode === 'locked_on' && $lockedOnStatusText !== '') {
        $msg = $lockedOnStatusText;
    } else {
        $msg = $speakerOn
            ? 'Speakers are currently ON near the show.'
            : 'Speakers are currently OFF. Tap "Need sound?" to turn them on for a bit.';
    }

    lof_speaker_json_exit(200, [
        'success'          => true,
        'speakerOn'        => $speakerOn,
        'remainingSeconds' => $remaining,
        'message'          => $msg,
        'mode'             => $speakerMode,
    ]);

}

// ------------------------------------------------------------
// ACTION: notify  (confirmation from FPP scripts)
// ------------------------------------------------------------
if ($action === 'notify') {
    global $speakerSecs;

    $remoteIp = $_SERVER['REMOTE_ADDR'] ?? '';

    if (!empty($notifyIp) && $remoteIp !== $notifyIp) {
        lof_speaker_json_exit(403, [
            'success'          => false,
            'speakerOn'        => $speakerOn,
            'remainingSeconds' => $remaining,
            'message'          => 'Unauthorized notify source.',
        ]);
    }

    $statusParam = isset($_REQUEST['status']) ? sanitize_text_field($_REQUEST['status']) : '';
    $sourceParam = isset($_REQUEST['source']) ? sanitize_text_field($_REQUEST['source']) : 'fpp-exec';

    $state['last_notified_status'] = $statusParam;
    $state['last_notified_at']     = $now;
    $state['last_source']          = $sourceParam ?: $state['last_source'];

    if ($statusParam === 'on') {
        // Treat as confirmation that ON script ran.
        if ($state['status'] !== 'on' || lof_speaker_remaining_seconds($state) === 0) {
            $state['status']     = 'on';
            $state['expires_at'] = $now + $speakerSecs;
        }
        $state['last_updated'] = $now;
        lof_speaker_save_state($stateKey, $state);

        lof_speaker_json_exit(200, [
            'success'          => true,
            'speakerOn'        => true,
            'remainingSeconds' => lof_speaker_remaining_seconds($state),
            'message'          => 'Speaker ON confirmed by controller.',
        ]);
    }

    if ($statusParam === 'off') {
        // Confirmation that OFF script ran.
        $state['status']       = 'off';
        $state['expires_at']   = $now;
        $state['last_updated'] = $now;
        lof_speaker_save_state($stateKey, $state);

        lof_speaker_json_exit(200, [
            'success'          => true,
            'speakerOn'        => false,
            'remainingSeconds' => 0,
            'message'          => 'Speaker OFF confirmed by controller.',
        ]);
    }

    lof_speaker_json_exit(400, [
        'success'          => false,
        'speakerOn'        => $speakerOn,
        'remainingSeconds' => $remaining,
        'message'          => 'Invalid notify payload.',
    ]);
}

// ------------------------------------------------------------
// ACTION: on  (viewer / physical "Need sound?")
// ------------------------------------------------------------
if ($action === 'on') {
    global $extensionThreshold, $speakerSecs, $onScriptName, $fppApiKey, $speakerMode, $lockedOnStatusText;

    $sourceParam = isset($_REQUEST['source']) ? sanitize_text_field($_REQUEST['source']) : 'viewer';

    // Prefer Cloudflare connecting IP if present, fallback to REMOTE_ADDR
    $remoteIp = $_SERVER['HTTP_CF_CONNECTING_IP'] ?? ($_SERVER['REMOTE_ADDR'] ?? '');
    $country  = $_SERVER['HTTP_CF_IPCOUNTRY'] ?? '';

    // 1) Manual override: viewer control disabled, speakers handled by show
    if ($sourceParam !== 'physical' && $speakerMode === 'locked_on') {
        $msg = $lockedOnStatusText !== ''
            ? $lockedOnStatusText
            : 'Speakers are running continuously tonight. Viewer control is disabled.';

        lof_speaker_json_exit(403, [
            'success'          => false,
            'speakerOn'        => $speakerOn,
            'remainingSeconds' => $remaining,
            'status'           => 'locked_on',
            'message'          => $msg,
        ]);
    }

    // 2) Geo gating: if we know the country and it's not US, block viewer control
    if ($sourceParam !== 'physical' && $country !== '' && strtoupper($country) !== 'US') {
        lof_speaker_json_exit(403, [
            'success'          => false,
            'speakerOn'        => $speakerOn,
            'remainingSeconds' => $remaining,
            'status'           => 'geo_blocked',
            'message'          => 'Speaker control is only available to guests near the show. Use the live stream or FM radio instead.',
        ]);
    }

    // 3) Device gating: viewer must be mobile OR on LAN; physical button bypasses this.
    if ($sourceParam !== 'physical') {
        $isLan = $remoteIp ? lof_is_lan_ip($remoteIp) : false;

        if (!$isMobileUA && !$isLan) {
            lof_speaker_json_exit(403, [
                'success'          => false,
                'speakerOn'        => $speakerOn,
                'remainingSeconds' => $remaining,
                'status'           => 'desktop_blocked',
                'message'          => 'Speaker control is only available from mobile devices at the show.',
            ]);
        }
    }

    // 4) Simple per-IP cooldown (60s) for non-physical sources
    if ($sourceParam !== 'physical' && function_exists('get_transient') && function_exists('set_transient')) {
        $ip      = $remoteIp ?: 'unknown';
        $coolKey = 'lof_speaker_cooldown_' . md5($ip);

        if (get_transient($coolKey)) {
            lof_speaker_json_exit(429, [
                'success'          => false,
                'speakerOn'        => $speakerOn,
                'remainingSeconds' => $remaining,
                'message'          => 'Easy there — try again in a minute.',
            ]);
        }

        set_transient($coolKey, 1, 60);
    }

    // (rest of the existing ON logic stays the same)


    // Recompute with latest state and song guard
    $state     = lof_speaker_get_state($stateKey);
    lof_speaker_apply_mid_song_guard($state, $stateKey, $extensionThreshold);
    $remaining = lof_speaker_remaining_seconds($state);
    $speakerOn = ($state['status'] === 'on' && $remaining > 0);

    // Option 1B:
    // If already ON and remaining > threshold, do NOT re-trigger script.
    if ($speakerOn && $remaining > $extensionThreshold) {
        $mins = ceil($remaining / 60);
        $msg  = $mins > 1
            ? "Speaker is already on — about {$mins} minutes left."
            : "Speaker is already on — under a minute left.";

        lof_speaker_json_exit(200, [
            'success'          => true,
            'speakerOn'        => true,
            'remainingSeconds' => $remaining,
            'status'           => 'already_on',
            'message'          => $msg,
        ]);
    }

    // If OFF, or ON but almost out of time, this is a fresh ON / extension.
    $resp = lof_call_fpp_run_script($onScriptName, $fppApiKey);

    if (!$resp['ok']) {
        lof_speaker_json_exit(500, [
            'success'          => false,
            'speakerOn'        => $speakerOn,
            'remainingSeconds' => $remaining,
            'status'           => 'error',
            'message'          => 'Speaker command did not reach the controller.',
        ]);
    }

    // Update WP state window.
    $now                  = time();
    $state['status']      = 'on';
    $state['expires_at']  = $now + $speakerSecs;
    $state['last_source'] = $sourceParam ?: 'viewer';
    $state['last_updated']= $now;
    lof_speaker_save_state($stateKey, $state);

    $remaining = $speakerSecs;
    $mins      = ceil($remaining / 60);

    if ($speakerOn) {
        $msg = $mins > 1
            ? "Speaker time extended — about {$mins} more minutes."
            : "Speaker time extended — under a minute left.";
    } else {
        $msg = $mins > 1
            ? "Speakers turning on for about {$mins} minutes. Enjoy the music."
            : "Speakers turning on — under a minute of sound. Enjoy the music.";
    }

    lof_speaker_json_exit(200, [
        'success'          => true,
        'speakerOn'        => true,
        'remainingSeconds' => $remaining,
        'status'           => 'on',
        'message'          => $msg,
    ]);
}

// ------------------------------------------------------------
// Fallback
// ------------------------------------------------------------
$remaining = lof_speaker_remaining_seconds($state);
$speakerOn = ($state['status'] === 'on' && $remaining > 0);

lof_speaker_json_exit(400, [
    'success'          => false,
    'speakerOn'        => $speakerOn,
    'remainingSeconds' => $remaining,
    'message'          => 'Unknown action.',
]);