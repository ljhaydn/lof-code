<?php
/**
 * Plugin Name: Remote Falcon Viewer
 * Description: Displays the Remote Falcon show viewer with interactive song requests/voting.
 * Version: 1.5.0
 * Author: Lights on Falcon
 */

if (!defined('ABSPATH')) {
    exit;
}

class RF_Viewer_Plugin {
    private static $instance = null;
    private $api_base = 'https://remotefalcon.com/remote-falcon-external-api';

    public static function get_instance() {
        if (null === self::$instance) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    private function __construct() {
        add_action('init', [$this, 'register_shortcode']);
        add_action('wp_enqueue_scripts', [$this, 'enqueue_assets']);
        add_action('rest_api_init', [$this, 'register_rest_routes']);
    }

    public function register_shortcode() {
        add_shortcode('rf_viewer', [$this, 'shortcode_viewer']);
    }

    public function register_rest_routes() {
        // Show details endpoint
        register_rest_route('rf-viewer/v1', '/showDetails', [
            'methods' => 'GET',
            'callback' => [$this, 'rest_show_details'],
            'permission_callback' => '__return_true',
        ]);

        // Request (jukebox) endpoint
        register_rest_route('rf-viewer/v1', '/addSequenceToQueue', [
            'methods' => 'POST',
            'callback' => [$this, 'rest_add_to_queue'],
            'permission_callback' => '__return_true',
        ]);

        // Vote endpoint
        register_rest_route('rf-viewer/v1', '/voteForSequence', [
            'methods' => 'POST',
            'callback' => [$this, 'rest_vote'],
            'permission_callback' => '__return_true',
        ]);
    }

    private function make_rf_request($endpoint, $method = 'GET', $body = null) {
        $access_token = get_option('rf_viewer_access_token', '');
        $secret_key = get_option('rf_viewer_secret_key', '');

        if (empty($access_token) || empty($secret_key)) {
            return new WP_Error('missing_credentials', 'Remote Falcon credentials not configured', ['status' => 500]);
        }

        $header = json_encode(['typ' => 'JWT', 'alg' => 'HS256']);
        $payload = json_encode(['accessToken' => $access_token]);

        $base64_header = rtrim(strtr(base64_encode($header), '+/', '-_'), '=');
        $base64_payload = rtrim(strtr(base64_encode($payload), '+/', '-_'), '=');

        $signature = hash_hmac('sha256', $base64_header . '.' . $base64_payload, $secret_key, true);
        $base64_signature = rtrim(strtr(base64_encode($signature), '+/', '-_'), '=');

        $jwt = $base64_header . '.' . $base64_payload . '.' . $base64_signature;

        $args = [
            'headers' => [
                'Authorization' => 'Bearer ' . $jwt,
                'Content-Type' => 'application/json',
            ],
            'timeout' => 15,
        ];

        if ($method === 'POST' && $body) {
            $args['body'] = json_encode($body);
        }

        $url = $this->api_base . $endpoint;

        if ($method === 'GET') {
            $response = wp_remote_get($url, $args);
        } else {
            $args['method'] = $method;
            $response = wp_remote_post($url, $args);
        }

        if (is_wp_error($response)) {
            return $response;
        }

        $status_code = wp_remote_retrieve_response_code($response);
        $body = wp_remote_retrieve_body($response);

        if ($status_code >= 400) {
            return new WP_Error('rf_api_error', 'Remote Falcon API error', ['status' => $status_code, 'body' => $body]);
        }

        return json_decode($body, true);
    }

    public function rest_show_details(WP_REST_Request $request) {
        $data = $this->make_rf_request('/showDetails');

        if (is_wp_error($data)) {
            return new WP_REST_Response(['error' => $data->get_error_message()], 500);
        }

        return new WP_REST_Response($data, 200);
    }

    public function rest_add_to_queue(WP_REST_Request $request) {
        $sequence_name = $request->get_param('sequenceName');

        if (empty($sequence_name)) {
            return new WP_REST_Response(['error' => 'Missing sequenceName'], 400);
        }

        $data = $this->make_rf_request('/addSequenceToQueue', 'POST', [
            'sequenceName' => $sequence_name,
        ]);

        if (is_wp_error($data)) {
            $error_data = $data->get_error_data();
            $status = isset($error_data['status']) ? $error_data['status'] : 500;
            return new WP_REST_Response(['error' => $data->get_error_message()], $status);
        }

        return new WP_REST_Response($data, 200);
    }

    public function rest_vote(WP_REST_Request $request) {
        $sequence_name = $request->get_param('sequenceName');

        if (empty($sequence_name)) {
            return new WP_REST_Response(['error' => 'Missing sequenceName'], 400);
        }

        $data = $this->make_rf_request('/voteForSequence', 'POST', [
            'sequenceName' => $sequence_name,
        ]);

        if (is_wp_error($data)) {
            $error_data = $data->get_error_data();
            $status = isset($error_data['status']) ? $error_data['status'] : 500;
            return new WP_REST_Response(['error' => $data->get_error_message()], $status);
        }

        return new WP_REST_Response($data, 200);
    }

    public function enqueue_assets() {
        if (!is_singular()) {
            return;
        }

        global $post;
        if (!has_shortcode($post->post_content, 'rf_viewer')) {
            return;
        }

        wp_enqueue_script(
            'rf-viewer-js',
            plugin_dir_url(__FILE__) . 'rf-viewer.js',
            [],
            '1.5.0',
            true
        );

        wp_localize_script('rf-viewer-js', 'rfViewerData', [
            'apiBase' => rest_url('rf-viewer/v1'),
            'nonce' => wp_create_nonce('wp_rest'),
        ]);

        wp_enqueue_style(
            'rf-viewer-css',
            plugin_dir_url(__FILE__) . 'rf-viewer.css',
            [],
            '1.5.0'
        );
    }

    /**
     * V1.5: Unified Hero Template
     * 
     * Structure:
     * - Hero container with title
     * - State banner (populated by JS based on show state)
     * - CTA section (tap to request / vote)
     * - Now Playing / Next Up status
     * - My Status (personalized queue position)
     * - Controls row (Need sound, Glow, Surprise)
     * - Song grid + extras panel
     */
    public function shortcode_viewer($atts, $content = '') {
        ob_start(); ?>
        <div id="rf-viewer" class="rf-viewer">
            <!-- V1.5: UNIFIED HERO SECTION -->
            <div class="rf-hero" id="rf-hero">
                <h1 class="rf-hero-title">Tonight at Lights on Falcon</h1>
                
                <!-- State Banner: Shows current show state (offseason, intermission, showtime, etc.) -->
                <div class="rf-hero-banner" id="rf-hero-banner">
                    <div class="rf-hero-banner-title" id="rf-hero-banner-title"></div>
                    <div class="rf-hero-banner-body" id="rf-hero-banner-body"></div>
                </div>
                
                <!-- Smart Time Message: Shows when off-hours ("Show starts at 5 PM!") -->
                <div class="rf-hero-time" id="rf-hero-time"></div>
                
                <!-- CTA: Main call to action ("Tap a song to request it") -->
                <div class="rf-hero-cta" id="rf-hero-cta">
                    <div class="rf-hero-cta-title" id="rf-hero-cta-title"></div>
                    <div class="rf-hero-cta-body" id="rf-hero-cta-body"></div>
                </div>
                
                <!-- Now Playing Status -->
                <div class="rf-now" id="rf-now">
                    <div class="rf-label">Now Playing</div>
                    <div class="rf-now-title" id="rf-now-title">Loading…</div>
                    <div class="rf-now-artist" id="rf-now-artist"></div>
                    <div class="rf-now-progress">
                        <div class="rf-now-progress-bar">
                            <div class="rf-now-progress-fill"></div>
                        </div>
                        <div class="rf-now-progress-label"></div>
                    </div>
                </div>
                
                <!-- Next Up -->
                <div class="rf-next" id="rf-next">
                    <div class="rf-label">Next Up</div>
                    <div class="rf-next-title" id="rf-next-title">—</div>
                </div>
                
                <!-- My Status: Personalized queue position + estimated wait -->
                <div class="rf-hero-mystatus" id="rf-hero-mystatus"></div>
                
                <!-- Controls Row: Need sound, Glow, Surprise me -->
                <div class="rf-controls-row" id="rf-controls-row"></div>
            </div>

            <!-- Main Content Area -->
            <div class="rf-main-layout">
                <div class="rf-main-left">
                    <div class="rf-grid" id="rf-grid"></div>
                </div>
                <div class="rf-main-right" id="rf-extra-panel"></div>
            </div>

            <!-- Footer: Send a Glow -->
            <div class="rf-footer">
                <div id="rf-footer-glow"></div>
            </div>

            <!-- Audio Stream Footer (persistent container) -->
            <div
                id="lof-stream-footer"
                class="rf-stream-footer"
                data-src="https://player.pulsemesh.io/d/G073">
            </div>
        </div>
        <?php
        return ob_get_clean();
    }
}

new RF_Viewer_Plugin();
