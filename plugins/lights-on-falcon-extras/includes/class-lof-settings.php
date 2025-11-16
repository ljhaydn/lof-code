<?php
/**
 * Lights On Falcon – Extras
 * Settings screen for editable viewer copy.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

if ( ! class_exists( 'LOF_Settings' ) ) {

	class LOF_Settings {

		const OPTION_KEY_COPY = 'lof_extras_copy';

		/**
		 * Singleton-ish instance.
		 *
		 * @var LOF_Settings|null
		 */
		protected static $instance = null;

		/**
		 * Get instance.
		 *
		 * @return LOF_Settings
		 */
		public static function get_instance() {
			if ( null === self::$instance ) {
				self::$instance = new self();
			}
			return self::$instance;
		}

		/**
		 * Constructor.
		 */
		public function __construct() {
			add_action( 'admin_menu', array( $this, 'add_settings_page' ) );
			add_action( 'admin_init', array( $this, 'register_settings' ) );
		}

		/**
		 * Default copy values used both by settings UI and API.
		 *
		 * @return array
		 */
		public static function get_copy_defaults() {
			return array(
				// -----------------------
				// Header / hero copy
				// -----------------------
				'header_paused_title'   => 'Viewer control is currently paused',
				'header_paused_body'    => 'You can still enjoy the show — we’ll turn song requests and voting back on soon.',

				'header_jukebox_title'  => 'Tap a song to request it 🎧',
				'header_jukebox_intro'  => 'Requests join the queue in the order they come in.',
				'header_jukebox_queue'  => 'There are songs in the queue already — yours will join the line.',
				'header_jukebox_limit'  => 'You can request a limited number of songs per session.',
				'header_jukebox_geo'    => 'Viewer control may be limited to guests near the show location.',
				'header_jukebox_late'   => 'Late-night Falcon fans are the real MVPs. 🌙',

				'header_voting_title'   => 'Vote for your favorites 🗳️',
				'header_voting_intro'   => 'Songs with the most votes rise to the top. Tap a track below to help decide what plays next.',
				'header_voting_late'    => 'Bonus points for after-dark voting energy. 🌒',

				'header_default_title'  => 'Interactive show controls',
				'header_default_body'   => 'Use the controls below to interact with the Lights on Falcon show in real time.',

				// -----------------------
				// Stats panel copy
				// -----------------------
				'stats_title'           => 'Tonight from this device',
				'stats_requests_label'  => 'Requests sent',
				'stats_surprise_label'  => '“Surprise me” taps',
				'stats_vibe_label'      => 'Falcon vibe check',
				'stats_vibe_low'        => 'Cozy & chill 😌',
				'stats_vibe_med'        => 'Party forming 🕺',
				'stats_vibe_high'       => 'Full-send Falcon 🔥',

				// -----------------------
				// Surprise Me card copy
				// -----------------------
				'surprise_title'        => 'Can’t pick just one?',
				'surprise_sub'          => 'Let us queue up a random crowd-pleaser for you.',
				'surprise_btn'          => 'Surprise me ✨',
				'surprise_disabled'     => 'Viewer control is currently paused.',
				'surprise_fourth_time'  => 'You like chaos. We respect that. 😈',
			);
		}

		/**
		 * Helper to get an individual copy value with defaults merged.
		 *
		 * @param string $key
		 * @return string
		 */
		public static function get_copy_value( $key ) {
			$defaults = self::get_copy_defaults();
			$options  = get_option( self::OPTION_KEY_COPY, array() );

			if ( ! is_array( $options ) ) {
				$options = array();
			}

			if ( isset( $options[ $key ] ) && $options[ $key ] !== '' ) {
				return $options[ $key ];
			}

			return isset( $defaults[ $key ] ) ? $defaults[ $key ] : '';
		}

		/**
		 * Register settings / sections / fields.
		 */
		public function register_settings() {
			register_setting(
				'lof_extras_settings',
				self::OPTION_KEY_COPY,
				array(
					'type'              => 'array',
					'sanitize_callback' => array( $this, 'sanitize_copy' ),
					'default'           => self::get_copy_defaults(),
				)
			);

			// -------- Header copy section --------
			add_settings_section(
				'lof_extras_header',
				'Viewer Header Copy',
				function () {
					echo '<p>Customize the hero text at the top of the Remote Falcon viewer so it stays on-brand for Lights on Falcon.</p>';
				},
				'lof-extras-settings'
			);

			$this->add_copy_field(
				'header_paused_title',
				'Paused headline',
				'Shown when viewer control is turned off.'
			);
			$this->add_copy_field(
				'header_paused_body',
				'Paused body copy',
				'Additional line shown when viewer control is paused.'
			);

			$this->add_copy_field(
				'header_jukebox_title',
				'Jukebox headline',
				'Main title when viewer control mode is JUKEBOX.'
			);
			$this->add_copy_field(
				'header_jukebox_intro',
				'Jukebox intro line',
				'Base line that explains how requests join the queue.'
			);
			$this->add_copy_field(
				'header_jukebox_queue',
				'Jukebox queue line',
				'Additional line shown when there are already songs in the queue.'
			);
			$this->add_copy_field(
				'header_jukebox_limit',
				'Jukebox request limit line',
				'Shown when Remote Falcon has a per-session request limit set.'
			);
			$this->add_copy_field(
				'header_jukebox_geo',
				'Jukebox location line',
				'Shown when Remote Falcon uses a location check.'
			);
			$this->add_copy_field(
				'header_jukebox_late',
				'Jukebox late-night line',
				'Fun line shown for late-night sessions.'
			);

			$this->add_copy_field(
				'header_voting_title',
				'Voting headline',
				'Main title when viewer control mode is VOTING.'
			);
			$this->add_copy_field(
				'header_voting_intro',
				'Voting intro line',
				'Explains that votes help decide what plays next.'
			);
			$this->add_copy_field(
				'header_voting_late',
				'Voting late-night line',
				'Optional fun line for late-night voting.'
			);

			$this->add_copy_field(
				'header_default_title',
				'Default headline',
				'Fallback headline when mode is unknown.'
			);
			$this->add_copy_field(
				'header_default_body',
				'Default body copy',
				'Fallback line when mode is unknown.'
			);

			// -------- Stats copy section --------
			add_settings_section(
				'lof_extras_stats',
				'Viewer Stats Copy',
				function () {
					echo '<p>Text for the “Tonight from this device” stats panel on the viewer page.</p>';
				},
				'lof-extras-settings'
			);

			$this->add_copy_field(
				'stats_title',
				'Stats title',
				'Main heading above the stats rows.'
			);
			$this->add_copy_field(
				'stats_requests_label',
				'Requests label',
				'Label for the number of requests sent from this device.'
			);
			$this->add_copy_field(
				'stats_surprise_label',
				'“Surprise me” label',
				'Label for the number of Surprise Me taps.'
			);
			$this->add_copy_field(
				'stats_vibe_label',
				'Vibe label',
				'Label for the vibe line (e.g., “Falcon vibe check”).'
			);
			$this->add_copy_field(
				'stats_vibe_low',
				'Vibe text – low queue',
				'Shown when the queue is small or empty.'
			);
			$this->add_copy_field(
				'stats_vibe_med',
				'Vibe text – medium queue',
				'Shown when the queue is moderately full.'
			);
			$this->add_copy_field(
				'stats_vibe_high',
				'Vibe text – high queue',
				'Shown when the queue is very full.'
			);

			// -------- Surprise Me copy section --------
			add_settings_section(
				'lof_extras_surprise',
				'“Surprise Me” Card Copy',
				function () {
					echo '<p>Copy for the Surprise Me card that requests a random song.</p>';
				},
				'lof-extras-settings'
			);

			$this->add_copy_field(
				'surprise_title',
				'Card title',
				'Title text at the top of the card.'
			);
			$this->add_copy_field(
				'surprise_sub',
				'Subtitle',
				'Short line explaining what Surprise Me does.'
			);
			$this->add_copy_field(
				'surprise_btn',
				'Button label',
				'Text on the Surprise Me button.'
			);
			$this->add_copy_field(
				'surprise_disabled',
				'Disabled message',
				'Toast message when viewer control is paused.'
			);
			$this->add_copy_field(
				'surprise_fourth_time',
				'Fourth-time toast',
				'Fun toast shown the fourth time someone hits Surprise Me.'
			);
		}

		/**
		 * Helper for adding text fields backed by lof_extras_copy.
		 *
		 * @param string $key
		 * @param string $label
		 * @param string $description
		 */
		protected function add_copy_field( $key, $label, $description = '' ) {
			add_settings_field(
				'lof_copy_' . $key,
				esc_html( $label ),
				array( $this, 'render_text_field' ),
				'lof-extras-settings',
				$this->get_current_section_id(),
				array(
					'key'         => $key,
					'description' => $description,
				)
			);
		}

		/**
		 * Because add_settings_field doesn’t pass the current section id easily,
		 * we rely on calling this method within each section block in order.
		 *
		 * WordPress actually ignores the "section" value for display grouping,
		 * but it’s kept here for clarity if needed later.
		 *
		 * @return string
		 */
		protected function get_current_section_id() {
			// This is a no-op placeholder now; we’re explicitly passing
			// the section id in add_settings_field calls above.
			// Kept for future refactors if we split classes.
			return 'lof_extras_header';
		}

		/**
		 * Render a single-line text field.
		 *
		 * @param array $args
		 */
		public function render_text_field( $args ) {
			$key   = isset( $args['key'] ) ? $args['key'] : '';
			$desc  = isset( $args['description'] ) ? $args['description'] : '';
			$value = self::get_copy_value( $key );

			printf(
				'<input type="text" class="regular-text" name="%1$s[%2$s]" value="%3$s" />',
				esc_attr( self::OPTION_KEY_COPY ),
				esc_attr( $key ),
				esc_attr( $value )
			);

			if ( $desc ) {
				printf(
					'<p class="description">%s</p>',
					esc_html( $desc )
				);
			}
		}

		/**
		 * Sanitize callback for the copy array.
		 *
		 * @param mixed $input
		 * @return array
		 */
		public function sanitize_copy( $input ) {
			$defaults = self::get_copy_defaults();
			$output   = array();

			if ( ! is_array( $input ) ) {
				$input = array();
			}

			foreach ( $defaults as $key => $default_value ) {
				if ( isset( $input[ $key ] ) ) {
					$output[ $key ] = sanitize_text_field( $input[ $key ] );
				} else {
					$output[ $key ] = $default_value;
				}
			}

			return $output;
		}

		/**
		 * Add the settings page under "Settings".
		 */
		public function add_settings_page() {
			add_options_page(
				'Lights on Falcon – Extras',
				'Lights on Falcon – Extras',
				'manage_options',
				'lof-extras-settings',
				array( $this, 'render_settings_page' )
			);
		}

		/**
		 * Render admin settings page markup.
		 */
		public function render_settings_page() {
			if ( ! current_user_can( 'manage_options' ) ) {
				return;
			}
			?>
			<div class="wrap">
				<h1>Lights on Falcon – Extras</h1>
				<p>Fine-tune the viewer copy so everything stays perfectly on-brand for Lights on Falcon.</p>

				<form method="post" action="options.php">
					<?php
					settings_fields( 'lof_extras_settings' );
					do_settings_sections( 'lof-extras-settings' );
					submit_button();
					?>
				</form>
			</div>
			<?php
		}
	}

	// Boot it.
	LOF_Settings::get_instance();
}