<?php
/**
 * Lights On Falcon - Unified Show Brain (Phase A)
 * REAL IMPLEMENTATION
 */

if (!defined('ABSPATH')) exit;

class LOF_API {

    private $fpp;
    private $manual;

    public function __construct() {
        add_action('rest_api_init', [$this, 'routes']);
        $this->fpp = get_option('lof_fpp_base_url', '');
        $this->manual = get_option('lof_manual_phase_override', 'auto');
    }

    public function routes() {
        register_rest_route('lof-extras/v1', '/show-status', [
            'methods' => 'GET',
            'callback' => [$this, 'get_show_status'],
            'permission_callback' => '__return_true'
        ]);
    }

    // ------------------------------
    // CORE: FPP FETCH
    // ------------------------------
    private function fpp_get($path) {
        $url = rtrim($this->fpp, '/') . $path;

        $resp = wp_remote_get($url, ['timeout' => 2]);

        if (is_wp_error($resp)) return null;

        $body = wp_remote_retrieve_body($resp);
        if (!$body) return null;

        return json_decode($body, true);
    }

    // ------------------------------
    // CORE: CLASSIFY CURRENT PLAYLIST
    // ------------------------------
    private function classify_playlist($name, $schedule) {

        $lower = strtolower($name);

        // RESET / MAINTENANCE
        if (strpos($lower, 'reset') !== false) return 'reset';
        if (strpos($lower, 'maintenance') !== false) return 'reset';

        // INTERMISSION
        if (strpos($lower, 'intermission') !== false) return 'intermission';

        // SHOW
        if (strpos($lower, 'show') !== false) return 'show';

        // FALLBACK using schedule context:
        foreach ($schedule as $item) {
            if (isset($item['playlist']) && strtolower($item['playlist']) === $lower) {
                if ($item['playOnce']) return 'show';
            }
        }

        return 'unknown';
    }

    // ------------------------------
    // CORE: DETERMINE PHASE
    // ------------------------------
    private function determine_phase($playlistType, $schedulerEnabled) {

        // Manual override always wins
        if ($this->manual !== 'auto') {
            return $this->manual;
        }

        // Scheduler disabled → off-season
        if (!$schedulerEnabled) return 'off_season';

        switch ($playlistType) {

            case 'show':
                return 'showtime';

            case 'intermission':
                return 'intermission';

            case 'reset':
                return 'maintenance';

            case 'unknown':
                // If music is playing: treat as drop-by
                return 'drop_by';
        }

        return 'off_hours';
    }

    // ------------------------------
    // MAIN ENDPOINT
    // ------------------------------
    public function get_show_status() {

        $status = $this->fpp_get('/api/fppd/status');
        $schedule = $this->fpp_get('/api/schedule');

        if (!$status) {
            return [
                'success' => false,
                'show' => [
                    'phase' => 'maintenance',
                    'playlist' => null,
                    'secondsRemaining' => null,
                    'schedulerEnabled' => false,
                ]
            ];
        }

        $schedulerEnabled = $status['scheduler']['status'] ?? false;

        // Current playlist
        $playlist = $status['current_playlist']['playlist'] ?? null;
        $secondsRemaining = $status['secondsRemaining'] ?? null;

        // Classify
        $playlistType = $playlist ? $this->classify_playlist($playlist, $schedule ?: []) : 'unknown';

        // Determine phase
        $phase = $this->determine_phase($playlistType, $schedulerEnabled);

        return [
            'success' => true,
            'show' => [
                'phase' => $phase,
                'playlist' => $playlist,
                'secondsRemaining' => $secondsRemaining,
                'schedulerEnabled' => $schedulerEnabled,
                'playlistType' => $playlistType,
                'manualOverride' => $this->manual,
            ]
        ];
    }
}

new LOF_API();
