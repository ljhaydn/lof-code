<?php
/**
 * Plugin Name: Lights on Falcon Viewer Extras
 * Description: Adds Lights on Falcon experience extras (Glow, speaker, fog, tonight panel, showtime vs drop-by messaging, acts-of-light prompts) around the existing Remote Falcon viewer.
 * Version: 0.4.1
 * Author: Lights on Falcon
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

class LOF_Viewer_Extras {

    const OPTION_SETTINGS       = 'lof_viewer_extras_settings';
    const OPTION_GLOW_STATS     = 'lof_viewer_extras_glow_stats';
    const OPTION_GLOW_LOG       = 'lof_viewer_extras_glow_log';
    const OPTION_SPEAKER_STATE  = 'lof_viewer_extras_speaker_state';

    public function __construct() {
        add_action( 'admin_menu',        [ $this, 'add_settings_page' ] );
        add_action( 'admin_init',        [ $this, 'register_settings' ] );
        add_action( 'wp_enqueue_scripts',[ $this, 'enqueue_assets' ] );
        add_action( 'rest_api_init',     [ $this, 'register_rest_routes' ] );
    }

    /* =============================
     * SETTINGS / ADMIN
     * ============================= */

    private function get_default_settings() {
        return [
            'season'              => 'auto', // auto / halloween / christmas / offseason

            // Simple nightly schedule for showtime vs drop-by
            'show_start_hour'     => '17',   // 17 = 5pm local
            'show_end_hour'       => '22',   // 22 = 10pm local

            // Glow
            'enable_glow'         => true,
            'glow_button_label'   => 'Send a Glow ✨',
            'glow_toast'          => 'You sent a little extra joy to someone.',
            'glow_counter_text'   => 'Tonight, neighbors have shared {count} Glows.',

            // Micro-stories (one per line)
            'micro_stories'       =>
"Kids are laughing near the sidewalk.
Someone just took a photo under the arches.
A stranger held the ladder for a neighbor.
You’re part of tonight’s glow.",

            // Kindness / “acts of light” prompts
            'kindness_prompts'    =>
"Wave at a neighbor you don’t know yet.
Compliment someone’s favorite decoration.
Let a kid pick the next song.
Offer to hold a ladder or a mug of cocoa.
Thank someone for bringing their family to the block.",

            // Speaker
            'enable_speaker'           => true,
            'speaker_button_label'     => 'Turn on speakers 🔊',
            'speaker_success'          => 'Speaker on for about 5 minutes. Enjoy the music.',
            'speaker_error'            => 'Speaker command did not reach the controller.',
            'speaker_fpp_base'         => 'http://10.9.7.102',
            'speaker_script'           => 'GPIOPinCTRL-On22(turnonamp5mins)chatgpt.sh',
            'speaker_direct_url'       => '', // if set, we call this URL directly instead of building an FPP API URL
            'speaker_duration_seconds' => 300, // how long we consider the speaker "on" for state/UX

            // Fog
            'enable_fog'          => false,
            'fog_button_label'    => 'Puff smoke 🚂💨',
            'fog_success'         => 'Fog incoming—watch the train.',
            'fog_error'           => 'Fog command did not go through.',
            'fog_fpp_base'        => 'http://10.9.7.102',
            'fog_script'          => 'FogMachineScript.sh',

            // Tonight panel copy (all editable)
            'tonight_heading'     => 'Tonight at Lights on Falcon',
            'copy_off'            =>
'Viewer control is currently resting. The show is still running — look up and enjoy.
When viewer control turns on, you’ll be able to pick songs from this page.',

            'copy_jukebox'        =>
'You\'re in Jukebox Mode. Pick a song, we\'ll add it to the queue.
More neighbors = more fun. Your song might trigger someone else to dance.',

            'copy_voting'         =>
'You\'re in Voting Mode. Tap your favorite — the crowd decides what plays next.
If your song wins, take full credit. If it loses, blame the neighbors. 😉',

            'copy_other'          =>
'The show is live. Viewer controls might change during the night as we shift modes.',

            'copy_queue_line'     =>
'There are currently {count} song(s) in line.',
            'copy_queue_empty'    =>
'No queue at the moment. Your pick hits fast.',

            'copy_footer'         =>
'Share the glow, not the exact address. 😉',

            // Showtime vs drop-by copy
            'copy_showtime_lead'      =>
'You’re here during a scheduled show hour — nice timing.',
            'copy_adhoc_lead'         =>
'You’re here between big shows. The lights are in “drop-by” mode.',
            'copy_showtime_countdown' =>
'Next full show starts in about {minutes} minutes.',
            'copy_showtime_now'       =>
'A full show is running right now — look up and catch it live.',
            'copy_adhoc_hint'         =>
'You can still queue songs anytime. Think of it as bonus rounds between shows.',
        ];
    }

    private function get_settings() {
        $defaults = $this->get_default_settings();
        $stored   = get_option( self::OPTION_SETTINGS, [] );
        if ( ! is_array( $stored ) ) {
            $stored = [];
        }
        return array_merge( $defaults, $stored );
    }

    public function register_settings() {
        register_setting(
            'lof_viewer_extras_group',
            self::OPTION_SETTINGS,
            [
                'type'              => 'array',
                'sanitize_callback' => [ $this, 'sanitize_settings' ],
                'default'           => $this->get_default_settings(),
            ]
        );
    }

    public function sanitize_settings( $input ) {
        $defaults = $this->get_default_settings();
        $out      = $defaults;

        if ( ! is_array( $input ) ) {
            return $defaults;
        }

        $text = function( $key ) use ( $input, $defaults ) {
            return isset( $input[ $key ] )
                ? sanitize_text_field( $input[ $key ] )
                : $defaults[ $key ];
        };
        $textarea = function( $key ) use ( $input, $defaults ) {
            return isset( $input[ $key ] )
                ? trim( (string) $input[ $key ] )
                : $defaults[ $key ];
        };

        $out['season']          = $text( 'season' );
        $out['show_start_hour'] = $text( 'show_start_hour' );
        $out['show_end_hour']   = $text( 'show_end_hour' );

        // Glow
        $out['enable_glow']       = ! empty( $input['enable_glow'] );
        $out['glow_button_label'] = $text( 'glow_button_label' );
        $out['glow_toast']        = $text( 'glow_toast' );
        $out['glow_counter_text'] = $textarea( 'glow_counter_text' );
        $out['micro_stories']     = $textarea( 'micro_stories' );

        // Kindness prompts
        $out['kindness_prompts']  = $textarea( 'kindness_prompts' );

        // Speaker
        $out['enable_speaker']       = ! empty( $input['enable_speaker'] );
        $out['speaker_button_label'] = $text( 'speaker_button_label' );
        $out['speaker_success']      = $text( 'speaker_success' );
        $out['speaker_error']        = $text( 'speaker_error' );
        $out['speaker_fpp_base']     = esc_url_raw( $input['speaker_fpp_base'] ?? $defaults['speaker_fpp_base'] );
        $out['speaker_script']       = $text( 'speaker_script' );
        $out['speaker_direct_url']   = esc_url_raw( $input['speaker_direct_url'] ?? $defaults['speaker_direct_url'] );

        $duration_raw = isset( $input['speaker_duration_seconds'] )
            ? (int) $input['speaker_duration_seconds']
            : (int) $defaults['speaker_duration_seconds'];
        if ( $duration_raw < 60 ) {
            $duration_raw = 60; // minimum 1 minute
        }
        if ( $duration_raw > 900 ) {
            $duration_raw = 900; // cap at 15 minutes
        }
        $out['speaker_duration_seconds'] = $duration_raw;

        // Fog
        $out['enable_fog']          = ! empty( $input['enable_fog'] );
        $out['fog_button_label']    = $text( 'fog_button_label' );
        $out['fog_success']         = $text( 'fog_success' );
        $out['fog_error']           = $text( 'fog_error' );
        $out['fog_fpp_base']        = esc_url_raw( $input['fog_fpp_base'] ?? $defaults['fog_fpp_base'] );
        $out['fog_script']          = $text( 'fog_script' );

        // Tonight panel copy
        $out['tonight_heading']   = $text( 'tonight_heading' );
        $out['copy_off']          = $textarea( 'copy_off' );
        $out['copy_jukebox']      = $textarea( 'copy_jukebox' );
        $out['copy_voting']       = $textarea( 'copy_voting' );
        $out['copy_other']        = $textarea( 'copy_other' );
        $out['copy_queue_line']   = $textarea( 'copy_queue_line' );
        $out['copy_queue_empty']  = $textarea( 'copy_queue_empty' );
        $out['copy_footer']       = $textarea( 'copy_footer' );

        // Showtime vs drop-by copy
        $out['copy_showtime_lead']      = $textarea( 'copy_showtime_lead' );
        $out['copy_adhoc_lead']         = $textarea( 'copy_adhoc_lead' );
        $out['copy_showtime_countdown'] = $textarea( 'copy_showtime_countdown' );
        $out['copy_showtime_now']       = $textarea( 'copy_showtime_now' );
        $out['copy_adhoc_hint']         = $textarea( 'copy_adhoc_hint' );

        return $out;
    }

    public function add_settings_page() {
        add_options_page(
            'Lights on Falcon Viewer Extras',
            'LOF Viewer Extras',
            'manage_options',
            'lof-viewer-extras',
            [ $this, 'render_settings_page' ]
        );
    }

    public function render_settings_page() {
        if ( ! current_user_can( 'manage_options' ) ) {
            return;
        }

        $s = $this->get_settings();
        ?>
        <div class="wrap">
            <h1>Lights on Falcon Viewer Extras</h1>
            <form method="post" action="options.php">
                <?php settings_fields( 'lof_viewer_extras_group' ); ?>

                <h2>Season</h2>
                <table class="form-table">
                    <tr>
                        <th scope="row">Season Profile</th>
                        <td>
                            <select name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[season]">
                                <option value="auto" <?php selected( $s['season'], 'auto' ); ?>>Auto / Generic</option>
                                <option value="halloween" <?php selected( $s['season'], 'halloween' ); ?>>Halloween</option>
                                <option value="christmas" <?php selected( $s['season'], 'christmas' ); ?>>Christmas</option>
                                <option value="offseason" <?php selected( $s['season'], 'offseason' ); ?>>Off-season</option>
                            </select>
                            <p class="description">Tone only; doesn’t change schedules.</p>
                        </td>
                    </tr>
                </table>

                <h2>Scheduled Shows (for countdown vs “drop-by”)</h2>
                <table class="form-table">
                    <tr>
                        <th scope="row">Show Start Hour</th>
                        <td>
                            <input type="number"
                                   min="0"
                                   max="23"
                                   class="small-text"
                                   name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[show_start_hour]"
                                   value="<?php echo esc_attr( $s['show_start_hour'] ); ?>">
                            <span class="description">0–23, local time. Example: 17 = 5pm.</span>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Show End Hour</th>
                        <td>
                            <input type="number"
                                   min="0"
                                   max="23"
                                   class="small-text"
                                   name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[show_end_hour]"
                                   value="<?php echo esc_attr( $s['show_end_hour'] ); ?>">
                            <span class="description">0–23, local time. Example: 22 = 10pm. Countdown assumes shows on the hour between these times.</span>
                        </td>
                    </tr>
                </table>

                <h2>Send a Glow</h2>
                <table class="form-table">
                    <tr>
                        <th scope="row">Enable "Send a Glow"</th>
                        <td>
                            <label>
                                <input type="checkbox"
                                       name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[enable_glow]"
                                       value="1" <?php checked( ! empty( $s['enable_glow'] ) ); ?>>
                                Enabled
                            </label>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Glow Button Label</th>
                        <td>
                            <input type="text"
                                   class="regular-text"
                                   name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[glow_button_label]"
                                   value="<?php echo esc_attr( $s['glow_button_label'] ); ?>">
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Glow Toast Message</th>
                        <td>
                            <input type="text"
                                   class="regular-text"
                                   name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[glow_toast]"
                                   value="<?php echo esc_attr( $s['glow_toast'] ); ?>">
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Glow Counter Text</th>
                        <td>
                            <textarea rows="2" cols="60"
                                      name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[glow_counter_text]"><?php
                                echo esc_textarea( $s['glow_counter_text'] );
                            ?></textarea>
                            <p class="description">Use <code>{count}</code> where the total number of Glows should appear.</p>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Micro-stories (one per line)</th>
                        <td>
                            <textarea rows="4" cols="60"
                                      name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[micro_stories]"><?php
                                echo esc_textarea( $s['micro_stories'] );
                            ?></textarea>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Kindness Prompts (one per line)</th>
                        <td>
                            <textarea rows="4" cols="60"
                                      name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[kindness_prompts]"><?php
                                echo esc_textarea( $s['kindness_prompts'] );
                            ?></textarea>
                            <p class="description">These become tiny “acts of light” missions in the Tonight panel.</p>
                        </td>
                    </tr>
                </table>

                <h2>Speaker Button</h2>
                <table class="form-table">
                    <tr>
                        <th scope="row">Enable Speaker Button</th>
                        <td>
                            <label>
                                <input type="checkbox"
                                       name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[enable_speaker]"
                                       value="1" <?php checked( ! empty( $s['enable_speaker'] ) ); ?>>
                                Enabled
                            </label>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Speaker Button Label</th>
                        <td>
                            <input type="text"
                                   class="regular-text"
                                   name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[speaker_button_label]"
                                   value="<?php echo esc_attr( $s['speaker_button_label'] ); ?>">
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Speaker Success Toast</th>
                        <td>
                            <input type="text"
                                   class="regular-text"
                                   name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[speaker_success]"
                                   value="<?php echo esc_attr( $s['speaker_success'] ); ?>">
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Speaker Error Toast</th>
                        <td>
                            <input type="text"
                                   class="regular-text"
                                   name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[speaker_error]"
                                   value="<?php echo esc_attr( $s['speaker_error'] ); ?>">
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">FPP Base URL</th>
                        <td>
                            <input type="text"
                                   class="regular-text"
                                   name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[speaker_fpp_base]"
                                   value="<?php echo esc_attr( $s['speaker_fpp_base'] ); ?>">
                            <p class="description">Example: http://10.9.7.102</p>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Speaker Direct Trigger URL (optional)</th>
                        <td>
                            <input type="text"
                                   class="regular-text"
                                   name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[speaker_direct_url]"
                                   value="<?php echo esc_attr( $s['speaker_direct_url'] ); ?>">
                            <p class="description">
                                If set, this full URL will be called with a simple GET whenever someone taps the speaker
                                control. Use the exact URL that already works for your “Need sound?” card.
                            </p>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Speaker Script Name</th>
                        <td>
                            <input type="text"
                                   class="regular-text"
                                   name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[speaker_script]"
                                   value="<?php echo esc_attr( $s['speaker_script'] ); ?>">
                            <p class="description">Only used if Direct Trigger URL is empty.</p>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Speaker Duration (seconds)</th>
                        <td>
                            <input type="number"
                                   min="60"
                                   max="900"
                                   class="small-text"
                                   name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[speaker_duration_seconds]"
                                   value="<?php echo esc_attr( $s['speaker_duration_seconds'] ); ?>">
                            <span class="description">How long we treat the speaker as “on” after a press. Used for UX and to ignore extra taps.</span>
                        </td>
                    </tr>
                </table>

                <h2>Fog Button</h2>
                <table class="form-table">
                    <tr>
                        <th scope="row">Enable Fog Button</th>
                        <td>
                            <label>
                                <input type="checkbox"
                                       name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[enable_fog]"
                                       value="1" <?php checked( ! empty( $s['enable_fog'] ) ); ?>>
                                Enabled
                            </label>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Fog Button Label</th>
                        <td>
                            <input type="text"
                                   class="regular-text"
                                   name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[fog_button_label]"
                                   value="<?php echo esc_attr( $s['fog_button_label'] ); ?>">
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Fog Success Toast</th>
                        <td>
                            <input type="text"
                                   class="regular-text"
                                   name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[fog_success]"
                                   value="<?php echo esc_attr( $s['fog_success'] ); ?>">
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Fog Error Toast</th>
                        <td>
                            <input type="text"
                                   class="regular-text"
                                   name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[fog_error]"
                                   value="<?php echo esc_attr( $s['fog_error'] ); ?>">
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Fog FPP Base URL</th>
                        <td>
                            <input type="text"
                                   class="regular-text"
                                   name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[fog_fpp_base]"
                                   value="<?php echo esc_attr( $s['fog_fpp_base'] ); ?>">
                            <p class="description">Can be same as speaker base URL.</p>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Fog Script Name</th>
                        <td>
                            <input type="text"
                                   class="regular-text"
                                   name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[fog_script]"
                                   value="<?php echo esc_attr( $s['fog_script'] ); ?>">
                        </td>
                    </tr>
                </table>

                <h2>Tonight Panel Copy</h2>
                <table class="form-table">
                    <tr>
                        <th scope="row">Heading</th>
                        <td>
                            <input type="text"
                                   class="regular-text"
                                   name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[tonight_heading]"
                                   value="<?php echo esc_attr( $s['tonight_heading'] ); ?>">
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">When Viewer OFF</th>
                        <td>
                            <textarea rows="3" cols="60"
                                      name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[copy_off]"><?php
                                echo esc_textarea( $s['copy_off'] );
                            ?></textarea>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Jukebox Mode</th>
                        <td>
                            <textarea rows="3" cols="60"
                                      name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[copy_jukebox]"><?php
                                echo esc_textarea( $s['copy_jukebox'] );
                            ?></textarea>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Voting Mode</th>
                        <td>
                            <textarea rows="3" cols="60"
                                      name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[copy_voting]"><?php
                                echo esc_textarea( $s['copy_voting'] );
                            ?></textarea>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Other / Fallback</th>
                        <td>
                            <textarea rows="3" cols="60"
                                      name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[copy_other]"><?php
                                echo esc_textarea( $s['copy_other'] );
                            ?></textarea>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Queue Line (when queue &gt; 0)</th>
                        <td>
                            <textarea rows="2" cols="60"
                                      name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[copy_queue_line]"><?php
                                echo esc_textarea( $s['copy_queue_line'] );
                            ?></textarea>
                            <p class="description">Use <code>{count}</code> where the number of songs in line should appear.</p>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Queue Empty Line</th>
                        <td>
                            <textarea rows="2" cols="60"
                                      name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[copy_queue_empty]"><?php
                                echo esc_textarea( $s['copy_queue_empty'] );
                            ?></textarea>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Footer Line</th>
                        <td>
                            <textarea rows="2" cols="60"
                                      name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[copy_footer]"><?php
                                echo esc_textarea( $s['copy_footer'] );
                            ?></textarea>
                        </td>
                    </tr>
                </table>

                <h2>Showtime vs Drop-by Copy</h2>
                <table class="form-table">
                    <tr>
                        <th scope="row">Showtime Lead</th>
                        <td>
                            <textarea rows="2" cols="60"
                                      name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[copy_showtime_lead]"><?php
                                echo esc_textarea( $s['copy_showtime_lead'] );
                            ?></textarea>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Ad-hoc / Drop-by Lead</th>
                        <td>
                            <textarea rows="2" cols="60"
                                      name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[copy_adhoc_lead]"><?php
                                echo esc_textarea( $s['copy_adhoc_lead'] );
                            ?></textarea>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Showtime Countdown Line</th>
                        <td>
                            <textarea rows="2" cols="60"
                                      name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[copy_showtime_countdown]"><?php
                                echo esc_textarea( $s['copy_showtime_countdown'] );
                            ?></textarea>
                            <p class="description">Use <code>{minutes}</code> where the number of minutes until the next show should appear.</p>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Showtime "Now" Line</th>
                        <td>
                            <textarea rows="2" cols="60"
                                      name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[copy_showtime_now]"><?php
                                echo esc_textarea( $s['copy_showtime_now'] );
                            ?></textarea>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Ad-hoc Hint Line</th>
                        <td>
                            <textarea rows="2" cols="60"
                                      name="<?php echo esc_attr( self::OPTION_SETTINGS ); ?>[copy_adhoc_hint]"><?php
                                echo esc_textarea( $s['copy_adhoc_hint'] );
                            ?></textarea>
                        </td>
                    </tr>
                </table>

                <?php submit_button(); ?>
            </form>
        </div>
        <?php
    }

    /* =============================
     * FRONTEND ASSETS
     * ============================= */

    public function enqueue_assets() {
        if ( ! is_singular() ) {
            return;
        }

        global $post;
        if ( ! $post ) {
            return;
        }

        // Only load on pages that actually use the RF viewer shortcode.
        if ( strpos( $post->post_content, '[rf_viewer]' ) === false ) {
            return;
        }

        $settings = $this->get_settings();
        $today    = current_time( 'Y-m-d' );

        $glow_stats = get_option(
            self::OPTION_GLOW_STATS,
            [
                'date'  => $today,
                'total' => 0,
            ]
        );

        if ( ! is_array( $glow_stats ) ) {
            $glow_stats = [
                'date'  => $today,
                'total' => 0,
            ];
        }

        // If stats are from a previous day, reset for tonight
        if ( empty( $glow_stats['date'] ) || $glow_stats['date'] !== $today ) {
            $glow_stats = [
                'date'  => $today,
                'total' => 0,
            ];
        }

        // CSS (if you have lof-viewer-extras.css present)
        wp_enqueue_style(
            'lof-viewer-extras-css',
            plugin_dir_url( __FILE__ ) . 'assets/lof-viewer-extras.css',
            [],
            '0.4.1'
        );

        // JS
        wp_enqueue_script(
            'lof-viewer-extras-js',
            plugin_dir_url( __FILE__ ) . 'assets/lof-viewer-extras.js',
            [],
            '0.4.1',
            true
        );

        wp_localize_script(
            'lof-viewer-extras-js',
            'LOF_EXTRAS',
            [
                'restBase'        => esc_url_raw( rest_url( 'lof-extras/v1' ) ),
                'restNonce'       => wp_create_nonce( 'wp_rest' ),
                'rfShowUrl'       => esc_url_raw( rest_url( 'rf/v1/showDetails' ) ),
                'season'          => $settings['season'],
                'schedule'        => [
                    'startHour' => (int) $settings['show_start_hour'],
                    'endHour'   => (int) $settings['show_end_hour'],
                ],
                'enableGlow'      => ! empty( $settings['enable_glow'] ),
                'enableSpeaker'   => ! empty( $settings['enable_speaker'] ),
                'enableFog'       => ! empty( $settings['enable_fog'] ),
                'speakerDuration' => (int) $settings['speaker_duration_seconds'],
                'texts'           => [
                    'glowButton'        => $settings['glow_button_label'],
                    'glowToast'         => $settings['glow_toast'],
                    'glowCounter'       => $settings['glow_counter_text'],
                    'microStories'      => $settings['micro_stories'],
                    'kindnessPrompts'   => $settings['kindness_prompts'],
                    'speakerButton'     => $settings['speaker_button_label'],
                    'speakerSuccess'    => $settings['speaker_success'],
                    'speakerError'      => $settings['speaker_error'],
                    'fogButton'         => $settings['fog_button_label'],
                    'fogSuccess'        => $settings['fog_success'],
                    'fogError'          => $settings['fog_error'],
                    'tonightHeading'    => $settings['tonight_heading'],
                    'copyOff'           => $settings['copy_off'],
                    'copyJukebox'       => $settings['copy_jukebox'],
                    'copyVoting'        => $settings['copy_voting'],
                    'copyOther'         => $settings['copy_other'],
                    'copyQueueLine'     => $settings['copy_queue_line'],
                    'copyQueueEmpty'    => $settings['copy_queue_empty'],
                    'copyFooter'        => $settings['copy_footer'],
                    'copyShowtimeLead'      => $settings['copy_showtime_lead'],
                    'copyAdhocLead'         => $settings['copy_adhoc_lead'],
                    'copyShowtimeCountdown' => $settings['copy_showtime_countdown'],
                    'copyShowtimeNow'       => $settings['copy_showtime_now'],
                    'copyAdhocHint'         => $settings['copy_adhoc_hint'],
                ],
                'stats'           => [
                    'glowsTotal' => (int) ( $glow_stats['total'] ?? 0 ),
                ],
            ]
        );
    }

    /* =============================
     * REST API
     * ============================= */

    public function register_rest_routes() {
        register_rest_route(
            'lof-extras/v1',
            '/glow',
            [
                'methods'             => 'POST',
                'callback'            => [ $this, 'rest_glow' ],
                'permission_callback' => '__return_true',
            ]
        );

        register_rest_route(
            'lof-extras/v1',
            '/speaker',
            [
                'methods'             => 'POST',
                'callback'            => [ $this, 'rest_speaker' ],
                'permission_callback' => '__return_true',
            ]
        );

        register_rest_route(
            'lof-extras/v1',
            '/speaker/status',
            [
                'methods'             => 'GET',
                'callback'            => [ $this, 'rest_speaker_status' ],
                'permission_callback' => '__return_true',
            ]
        );

        register_rest_route(
            'lof-extras/v1',
            '/fog',
            [
                'methods'             => 'POST',
                'callback'            => [ $this, 'rest_fog' ],
                'permission_callback' => '__return_true',
            ]
        );
    }

    public function rest_glow( \WP_REST_Request $request ) {
        $settings = $this->get_settings();
        $today    = current_time( 'Y-m-d' );

        // --- Update nightly stats (existing behavior) ---
        $stats = get_option(
            self::OPTION_GLOW_STATS,
            [
                'date'  => $today,
                'total' => 0,
            ]
        );

        if ( ! is_array( $stats ) ) {
            $stats = [
                'date'  => $today,
                'total' => 0,
            ];
        }

        // If stored stats are from a previous night, reset
        if ( empty( $stats['date'] ) || $stats['date'] !== $today ) {
            $stats = [
                'date'  => $today,
                'total' => 0,
            ];
        }

        $stats['total'] = isset( $stats['total'] ) ? (int) $stats['total'] + 1 : 1;
        $stats['date']  = $today;

        update_option( self::OPTION_GLOW_STATS, $stats );

        // --- NEW: Persist full Glow submission to a log option ---
        $data    = $request->get_json_params();
        $message = isset( $data['message'] ) ? sanitize_textarea_field( (string) $data['message'] ) : '';
        $name    = isset( $data['name'] ) ? sanitize_text_field( (string) $data['name'] ) : '';

        $ip        = isset( $_SERVER['REMOTE_ADDR'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REMOTE_ADDR'] ) ) : '';
        $userAgent = isset( $_SERVER['HTTP_USER_AGENT'] ) ? sanitize_text_field( wp_unslash( $_SERVER['HTTP_USER_AGENT'] ) ) : '';

        $log = get_option( self::OPTION_GLOW_LOG, [] );
        if ( ! is_array( $log ) ) {
            $log = [];
        }

        $log[] = [
            'timestamp'   => current_time( 'mysql' ),
            'date'        => $today,
            'message'     => $message,
            'name'        => $name,
            'ip'          => $ip,
            'user_agent'  => $userAgent,
        ];

        // Soft cap to avoid unbounded growth: keep the most recent 2000 entries.
        if ( count( $log ) > 2000 ) {
            $log = array_slice( $log, -2000 );
        }

        update_option( self::OPTION_GLOW_LOG, $log );

        return new \WP_REST_Response(
            [
                'status'  => 'ok',
                'message' => $settings['glow_toast'],
                'total'   => (int) $stats['total'],
            ],
            200
        );
    }

    public function rest_speaker( \WP_REST_Request $request ) {
        $settings = $this->get_settings();

        if ( empty( $settings['enable_speaker'] ) ) {
            return new \WP_REST_Response(
                [
                    'status'           => 'disabled',
                    'message'          => 'Speaker control is not available right now.',
                    'secondsRemaining' => 0,
                ],
                200
            );
        }

        $duration = (int) $settings['speaker_duration_seconds'];
        if ( $duration < 60 ) {
            $duration = 60;
        }

        $state = get_option( self::OPTION_SPEAKER_STATE, [ 'until' => 0 ] );
        if ( ! is_array( $state ) ) {
            $state = [ 'until' => 0 ];
        }

        $now   = time();
        $until = isset( $state['until'] ) ? (int) $state['until'] : 0;

        if ( $until > $now ) {
            // Already considered ON; ignore extra presses.
            $remaining = $until - $now;
            return new \WP_REST_Response(
                [
                    'status'           => 'already_on',
                    'message'          => 'Speaker is already on for a bit longer.',
                    'secondsRemaining' => $remaining,
                ],
                200
            );
        }

        // Not currently on: call FPP script (or direct URL).
        $ok = $this->call_fpp_script(
            $settings['speaker_fpp_base'],
            $settings['speaker_script'],
            $settings['speaker_direct_url'] ?? ''
        );

        if ( $ok ) {
            $state['until'] = $now + $duration;
            update_option( self::OPTION_SPEAKER_STATE, $state );

            return new \WP_REST_Response(
                [
                    'status'           => 'ok',
                    'message'          => $settings['speaker_success'],
                    'secondsRemaining' => $duration,
                ],
                200
            );
        }

        return new \WP_REST_Response(
            [
                'status'           => 'error',
                'message'          => $settings['speaker_error'],
                'secondsRemaining' => 0,
            ],
            200
        );
    }

    public function rest_speaker_status( \WP_REST_Request $request ) {
        $settings = $this->get_settings();
        if ( empty( $settings['enable_speaker'] ) ) {
            return new \WP_REST_Response(
                [
                    'active'           => false,
                    'secondsRemaining' => 0,
                ],
                200
            );
        }

        $state = get_option( self::OPTION_SPEAKER_STATE, [ 'until' => 0 ] );
        if ( ! is_array( $state ) ) {
            $state = [ 'until' => 0 ];
        }

        $now   = time();
        $until = isset( $state['until'] ) ? (int) $state['until'] : 0;

        if ( $until > $now ) {
            return new \WP_REST_Response(
                [
                    'active'           => true,
                    'secondsRemaining' => $until - $now,
                ],
                200
            );
        }

        return new \WP_REST_Response(
            [
                'active'           => false,
                'secondsRemaining' => 0,
            ],
            200
        );
    }

    public function rest_fog( \WP_REST_Request $request ) {
        $settings = $this->get_settings();

        if ( empty( $settings['enable_fog'] ) ) {
            return new \WP_REST_Response(
                [
                    'status'  => 'disabled',
                    'message' => 'Fog control is not available right now.',
                ],
                200
            );
        }

        $ok = $this->call_fpp_script(
            $settings['fog_fpp_base'],
            $settings['fog_script'],
            '' // no direct URL for fog (yet)
        );

        return new \WP_REST_Response(
            [
                'status'  => $ok ? 'ok' : 'error',
                'message' => $ok ? $settings['fog_success'] : $settings['fog_error'],
            ],
            200
        );
    }

    /* =============================
     * HELPER: FPP RunScript
     * ============================= */

    private function call_fpp_script( $base_url, $script_name, $direct_url = '' ) {
        // If a full direct URL is provided, just call that and be done.
        if ( ! empty( $direct_url ) ) {
            $resp = wp_remote_get(
                $direct_url,
                [
                    'timeout' => 4,
                ]
            );

            if ( is_wp_error( $resp ) ) {
                return false;
            }

            $code = wp_remote_retrieve_response_code( $resp );
            return $code >= 200 && $code < 300;
        }

        // Fallback: try to construct an FPP RunScript URL
        $base_url    = rtrim( (string) $base_url, '/' );
        $script_name = (string) $script_name;

        if ( empty( $base_url ) || empty( $script_name ) ) {
            return false;
        }

        // FPP: /api/command/RunScript/<scriptName>
        $url = $base_url . '/api/command/RunScript/' . rawurlencode( $script_name );

        $resp = wp_remote_get(
            $url,
            [
                'timeout' => 4,
            ]
        );

        if ( is_wp_error( $resp ) ) {
            return false;
        }

        $code = wp_remote_retrieve_response_code( $resp );
        return $code >= 200 && $code < 300;
    }
}

new LOF_Viewer_Extras();