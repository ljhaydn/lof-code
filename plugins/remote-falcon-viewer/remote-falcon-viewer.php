<?php
/**
 * Plugin Name: Remote Falcon Viewer (Native)
 * Description: Native Remote Falcon viewer using the External API via a secure WP proxy + shortcode [rf_viewer].
 * Version: 1.5.0
 * Author: Lights on Falcon
 */

if (!defined('ABSPATH')) {
    exit;
}

class RF_Viewer_Plugin {
    private $option_key = 'rf_viewer_settings';

    public function __construct() {
        add_action('admin_menu', [$this, 'add_settings_page']);
        add_action('admin_init', [$this, 'register_settings']);
        add_action('rest_api_init', [$this, 'register_routes']);
        add_shortcode('rf_viewer', [$this, 'shortcode_viewer']);
        add_action('wp_enqueue_scripts', [$this, 'enqueue_assets']);
    }

    /* -------------------
     * SETTINGS
     * ------------------- */

    public function add_settings_page() {
        add_options_page(
            'Remote Falcon Viewer',
            'Remote Falcon Viewer',
            'manage_options',
            'rf-viewer',
            [$this, 'settings_page_html']
        );
    }

    public function register_settings() {
        register_setting($this->option_key, $this->option_key, [
            'sanitize_callback' => function($input) {
                $out = [];
                $out['api_base']      = isset($input['api_base']) ? esc_url_raw($input['api_base']) : '';
                $out['jwt']           = isset($input['jwt']) ? sanitize_text_field($input['jwt']) : '';
                $out['cache_seconds'] = isset($input['cache_seconds']) ? intval($input['cache_seconds']) : 15;

                // request/vote endpoint paths (relative to api_base)
                $out['request_path']  = isset($input['request_path']) ? sanitize_text_field($input['request_path']) : '';
                $out['vote_path']     = isset($input['vote_path']) ? sanitize_text_field($input['vote_path']) : '';

                return $out;
            }
        ]);
    }

    public function settings_page_html() {
        if (!current_user_can('manage_options')) return;

        $opts = $this->get_options();
        ?>
        <div class="wrap">
            <h1>Remote Falcon Viewer (Native)</h1>
            <p>This plugin connects your WordPress site to your Remote Falcon show via the External API.</p>

            <form method="post" action="options.php">
                <?php settings_fields($this->option_key); ?>
                <table class="form-table" role="presentation">
                    <tr>
                        <th scope="row"><label for="rf_api_base">Remote Falcon API Base URL</label></th>
                        <td>
                            <input type="url"
                                   id="rf_api_base"
                                   name="<?php echo esc_attr($this->option_key); ?>[api_base]"
                                   value="<?php echo esc_attr($opts['api_base']); ?>"
                                   class="regular-text"
                                   placeholder="https://getlitproductions.co/remote-falcon-external-api"
                                   required>
                            <p class="description">
                                For your Cloudflare reverse-proxy this should be something like:<br>
                                <code>https://getlitproductions.co/remote-falcon-external-api</code>
                            </p>
                        </td>
                    </tr>

                    <tr>
                        <th scope="row"><label for="rf_jwt">JWT (Bearer Token)</label></th>
                        <td>
                            <input type="password"
                                   id="rf_jwt"
                                   name="<?php echo esc_attr($this->option_key); ?>[jwt]"
                                   value="<?php echo esc_attr($opts['jwt']); ?>"
                                   class="regular-text"
                                   required>
                            <p class="description">
                                The long Bearer token you generated from your Remote Falcon apiAccessToken + apiAccessSecret (the one that worked with <code>/showDetails</code>).
                            </p>
                        </td>
                    </tr>

                    <tr>
                        <th scope="row"><label for="rf_cache">Cache (seconds)</label></th>
                        <td>
                            <input type="number"
                                   id="rf_cache"
                                   name="<?php echo esc_attr($this->option_key); ?>[cache_seconds]"
                                   value="<?php echo esc_attr($opts['cache_seconds']); ?>"
                                   min="0" class="small-text">
                            <p class="description">10–20 seconds is fine for <code>showDetails</code>.</p>
                        </td>
                    </tr>

                    <tr>
                        <th scope="row"><label for="rf_request_path">Request endpoint path</label></th>
                        <td>
                            <input type="text"
                                   id="rf_request_path"
                                   name="<?php echo esc_attr($this->option_key); ?>[request_path]"
                                   value="<?php echo esc_attr($opts['request_path']); ?>"
                                   class="regular-text"
                                   placeholder="/addSequenceToQueue">
                            <p class="description">
                                From the Remote Falcon OpenAPI spec, this is the path for adding a sequence to the
                                Jukebox queue. Default:<br>
                                <code>/addSequenceToQueue</code>
                            </p>
                        </td>
                    </tr>

                    <tr>
                        <th scope="row"><label for="rf_vote_path">Vote endpoint path</label></th>
                        <td>
                            <input type="text"
                                   id="rf_vote_path"
                                   name="<?php echo esc_attr($this->option_key); ?>[vote_path]"
                                   value="<?php echo esc_attr($opts['vote_path']); ?>"
                                   class="regular-text"
                                   placeholder="/voteForSequence">
                            <p class="description">
                                From the OpenAPI spec, this is the path for voting on a sequence. Default:<br>
                                <code>/voteForSequence</code>
                            </p>
                        </td>
                    </tr>
                </table>
                <?php submit_button(); ?>
            </form>
        </div>
        <?php
    }

    private function get_options() {
        $defaults = [
            'api_base'      => '',
            'jwt'           => '',
            'cache_seconds' => 15,
            'request_path'  => '/addSequenceToQueue',
            'vote_path'     => '/voteForSequence',
        ];
        $opts = get_option($this->option_key, []);
        return wp_parse_args($opts, $defaults);
    }

    private function rf_base() {
        $opts = $this->get_options();
        return rtrim($opts['api_base'], '/');
    }

    private function rf_headers() {
        $opts = $this->get_options();
        if (empty($opts['api_base']) || empty($opts['jwt'])) {
            return new WP_Error('rf_not_configured', 'Remote Falcon API is not configured.');
        }
        return [
            'Accept'        => 'application/json',
            'Authorization' => 'Bearer ' . $opts['jwt'],
        ];
    }

    private function cache_ttl() {
        $opts = $this->get_options();
        return isset($opts['cache_seconds']) ? max(0, intval($opts['cache_seconds'])) : 15;
    }

    private function rf_request_url() {
        $opts = $this->get_options();
        if (empty($opts['request_path'])) {
            return new WP_Error('rf_no_request_path', 'Request endpoint path is not configured.');
        }
        $path = '/' . ltrim($opts['request_path'], '/');
        return $this->rf_base() . $path;
    }

    private function rf_vote_url() {
        $opts = $this->get_options();
        if (empty($opts['vote_path'])) {
            return new WP_Error('rf_no_vote_path', 'Vote endpoint path is not configured.');
        }
        $path = '/' . ltrim($opts['vote_path'], '/');
        return $this->rf_base() . $path;
    }

    /* -------------------
     * REST PROXY ROUTES
     * ------------------- */

    public function register_routes() {
        // GET show details (preferences, sequences, queue, votes, etc.)
        register_rest_route('rf/v1', '/showDetails', [
            'methods'             => 'GET',
            'callback'            => [$this, 'proxy_show_details'],
            'permission_callback' => '__return_true',
        ]);

        // POST: request (JUKEBOX mode)
        register_rest_route('rf/v1', '/request', [
            'methods'             => 'POST',
            'callback'            => [$this, 'proxy_request_sequence'],
            'permission_callback' => '__return_true',
        ]);

        // POST: vote (VOTING mode)
        register_rest_route('rf/v1', '/vote', [
            'methods'             => 'POST',
            'callback'            => [$this, 'proxy_vote_sequence'],
            'permission_callback' => '__return_true',
        ]);
    }

    public function proxy_show_details(WP_REST_Request $req) {
        $headers = $this->rf_headers();
        if (is_wp_error($headers)) return $headers;

        $cache_key = 'rf_show_details_cache';
        $ttl       = $this->cache_ttl();

        if ($ttl > 0) {
            $cached = get_transient($cache_key);
            if ($cached !== false) {
                return rest_ensure_response($cached);
            }
        }

        $resp = wp_remote_get($this->rf_base() . '/showDetails', [
            'headers' => $headers,
            'timeout' => 10,
        ]);

        if (is_wp_error($resp)) return $resp;

        $body = wp_remote_retrieve_body($resp);
        $data = json_decode($body, true);

        if (json_last_error() !== JSON_ERROR_NONE) {
            return new WP_Error('rf_bad_json', 'Remote Falcon returned invalid JSON.');
        }

        if ($ttl > 0) {
            set_transient($cache_key, $data, $ttl);
        }

        return rest_ensure_response($data);
    }

    /**
     * Proxy JUKEBOX request -> Remote Falcon /addSequenceToQueue
     * Expects JSON from frontend: { "sequence": "InternalSequenceName" }
     */
    public function proxy_request_sequence(WP_REST_Request $req) {
        $headers = $this->rf_headers();
        if (is_wp_error($headers)) return $headers;

        $url = $this->rf_request_url();
        if (is_wp_error($url)) return $url;

        $params  = $req->get_json_params();

        // Prefer "sequence" (correct), but accept "sequenceName" just in case
        $sequence = '';
        if (isset($params['sequence'])) {
            $sequence = sanitize_text_field($params['sequence']);
        } elseif (isset($params['sequenceName'])) {
            $sequence = sanitize_text_field($params['sequenceName']);
        }

        if (empty($sequence)) {
            return new WP_Error('rf_missing_sequence', 'sequence is required.');
        }

        // Match OpenAPI schema: requestSequence
        $body = [
            'sequence' => $sequence,
            // viewerLatitude / viewerLongitude would go here if you ever add GPS checks
        ];

        $resp = wp_remote_post($url, [
            'headers' => array_merge($headers, [
                'Content-Type' => 'application/json',
            ]),
            'body'    => wp_json_encode($body),
            'timeout' => 10,
        ]);

        if (is_wp_error($resp)) return $resp;

        $code = wp_remote_retrieve_response_code($resp);
        $raw  = wp_remote_retrieve_body($resp);
        $data = json_decode($raw, true);

        if (json_last_error() !== JSON_ERROR_NONE) {
            $data = ['raw' => $raw];
        }

        return rest_ensure_response([
            'status' => $code,
            'data'   => $data,
        ]);
    }

    /**
     * Proxy VOTING request -> Remote Falcon /voteForSequence
     * Expects JSON from frontend: { "sequence": "InternalSequenceName" }
     */
    public function proxy_vote_sequence(WP_REST_Request $req) {
        $headers = $this->rf_headers();
        if (is_wp_error($headers)) return $headers;

        $url = $this->rf_vote_url();
        if (is_wp_error($url)) return $url;

        $params  = $req->get_json_params();

        $sequence = '';
        if (isset($params['sequence'])) {
            $sequence = sanitize_text_field($params['sequence']);
        } elseif (isset($params['sequenceName'])) {
            $sequence = sanitize_text_field($params['sequenceName']);
        }

        if (empty($sequence)) {
            return new WP_Error('rf_missing_sequence', 'sequence is required.');
        }

        $body = [
            'sequence' => $sequence,
        ];

        $resp = wp_remote_post($url, [
            'headers' => array_merge($headers, [
                'Content-Type' => 'application/json',
            ]),
            'body'    => wp_json_encode($body),
            'timeout' => 10,
        ]);

        if (is_wp_error($resp)) return $resp;

        $code = wp_remote_retrieve_response_code($resp);
        $raw  = wp_remote_retrieve_body($resp);
        $data = json_decode($raw, true);

        if (json_last_error() !== JSON_ERROR_NONE) {
            $data = ['raw' => $raw];
        }

        return rest_ensure_response([
            'status' => $code,
            'data'   => $data,
        ]);
    }

    /* -------------------
     * FRONTEND
     * ------------------- */

    public function enqueue_assets() {
        if (!is_singular()) return;
        global $post;
        if (!$post || strpos($post->post_content, '[rf_viewer]') === false) return;

        wp_enqueue_script(
            'rf-viewer-js',
            plugin_dir_url(__FILE__) . 'rf-viewer.js',
            [],
            '1.2.0',
            true
        );
        wp_localize_script('rf-viewer-js', 'RFViewer', [
            'base' => esc_url_raw(rest_url('rf/v1')),
        ]);

        wp_enqueue_style(
            'rf-viewer-css',
            plugin_dir_url(__FILE__) . 'rf-viewer.css',
            [],
            '1.2.0'
        );
    }

    public function shortcode_viewer($atts, $content = '') {
        ob_start(); ?>
        <div id="rf-viewer" class="rf-viewer">
            <div class="rf-status-panel">
                <div class="rf-now">
                    <div class="rf-label">Now Playing</div>
                    <div class="rf-now-title" id="rf-now-title">Loading…</div>
                    <div class="rf-now-artist" id="rf-now-artist"></div>
                </div>
                <div class="rf-next">
                    <div class="rf-label">Next Up</div>
                    <div class="rf-next-title" id="rf-next-title">—</div>
                </div>
                <div class="rf-mode">
                    <div class="rf-label">Mode</div>
                    <div class="rf-mode-value" id="rf-mode-value">—</div>
                </div>
            </div>

            <div class="rf-grid" id="rf-grid"></div>
            <!-- GLOBAL STREAM FOOTER (persistent, not re-rendered) -->
            <div
              id="lof-stream-footer"
              class="rf-stream-footer"
              data-src="https://player.pulsemesh.io/d/G073"
            ></div>
        </div>
        <?php
        return ob_get_clean();
    }
}

new RF_Viewer_Plugin();
