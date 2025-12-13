<?php
/**
 * VIP Override API - Admin-only endpoint to jump the queue
 * Location: /wp-content/themes/integrations/lof-vip-override.php
 * 
 * POST with JSON body: { "sequence": "song_name", "mode": "next" | "now" }
 */

require_once($_SERVER['DOCUMENT_ROOT'] . '/wp-load.php');

// Must be logged in as admin
if (!current_user_can('manage_options')) {
    http_response_code(403);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Admin only']);
    exit;
}

header('Content-Type: application/json');

$input = json_decode(file_get_contents('php://input'), true);
$sequence = isset($input['sequence']) ? trim($input['sequence']) : '';
$mode = isset($input['mode']) ? $input['mode'] : 'next';

if (empty($sequence)) {
    http_response_code(400);
    echo json_encode(['error' => 'Missing sequence']);
    exit;
}

$fpp_host = 'http://10.9.7.102';

if ($mode === 'now') {
    // Stop current song immediately
    wp_remote_post($fpp_host . '/api/command', [
        'headers' => ['Content-Type' => 'application/json'],
        'body' => json_encode(['command' => 'Stop Now', 'args' => []]),
        'timeout' => 5,
    ]);
    
    usleep(500000); // 0.5 sec pause
    
    // Start the VIP sequence
    $result = wp_remote_get($fpp_host . '/api/command/Start%20Sequence/' . rawurlencode($sequence) . '/true', [
        'timeout' => 5,
    ]);
    
} else {
    // Insert after current song
    $result = wp_remote_post($fpp_host . '/api/command', [
        'headers' => ['Content-Type' => 'application/json'],
        'body' => json_encode([
            'command' => 'Insert Playlist After Current',
            'args' => [$sequence]
        ]),
        'timeout' => 5,
    ]);
}

if (is_wp_error($result)) {
    http_response_code(500);
    echo json_encode(['error' => $result->get_error_message()]);
    exit;
}

$response_code = wp_remote_retrieve_response_code($result);
$body = wp_remote_retrieve_body($result);

// Log VIP override for analytics
error_log("[VIP Override] sequence={$sequence} mode={$mode} by user=" . get_current_user_id());

echo json_encode([
    'success' => true,
    'sequence' => $sequence,
    'mode' => $mode,
    'message' => $mode === 'now' ? 'Playing now!' : 'Queued next',
    'fpp_response' => $response_code
]);
