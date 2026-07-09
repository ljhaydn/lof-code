<?php
/**
 * Plugin Name: LOF Weather Footer
 * Description: Server-side cached OpenWeather data, exposed via REST and rendered into an Elementor container with id="weather-info".
 * Version: 1.0.0
 * Author: Lights on Falcon
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

/**
 * CONFIG – update these to your real values.
 * IMPORTANT: Regenerate a fresh OpenWeather API key, since the old one has been exposed publicly.
 */
define( 'LOF_WEATHER_API_KEY', 'ee62cc7c40f330797b8d4d2991e96db5' );
define( 'LOF_WEATHER_LAT', 33.865854454071865 );
define( 'LOF_WEATHER_LON', -118.20786568499409 );

/**
 * Fetch weather from OpenWeather, cached via transient for 30 minutes.
 */
function lof_fetch_weather_data() {
    $cached = get_transient( 'lof_weather_cache_v1' );
    if ( false !== $cached ) {
        return $cached;
    }

    if ( ! LOF_WEATHER_API_KEY ) {
        return new WP_Error( 'missing_key', 'OpenWeather API key is not configured.' );
    }

    $url = sprintf(
        'https://api.openweathermap.org/data/2.5/weather?lat=%s&lon=%s&units=imperial&appid=%s',
        LOF_WEATHER_LAT,
        LOF_WEATHER_LON,
        LOF_WEATHER_API_KEY
    );

    $response = wp_remote_get(
        $url,
        array(
            'timeout' => 10,
            'headers' => array(
                'Accept' => 'application/json',
            ),
        )
    );

    if ( is_wp_error( $response ) ) {
        return $response;
    }

    $code = wp_remote_retrieve_response_code( $response );
    if ( 200 !== $code ) {
        return new WP_Error( 'bad_status', 'OpenWeather returned status ' . $code );
    }

    $body = wp_remote_retrieve_body( $response );
    $data = json_decode( $body, true );

    if ( ! is_array( $data ) ) {
        return new WP_Error( 'bad_json', 'Unable to decode weather JSON.' );
    }

    // Cache for 30 minutes.
    set_transient( 'lof_weather_cache_v1', $data, 30 * MINUTE_IN_SECONDS );

    return $data;
}

/**
 * REST endpoint: /wp-json/lof/v1/weather
 * Returns just the clean data the frontend needs.
 */
add_action(
    'rest_api_init',
    function () {
        register_rest_route(
            'lof/v1',
            '/weather',
            array(
                'methods'             => WP_REST_Server::READABLE,
                'callback'            => 'lof_weather_rest_handler',
                'permission_callback' => '__return_true',
            )
        );
    }
);

/**
 * REST handler.
 */
function lof_weather_rest_handler( WP_REST_Request $request ) {
    $data = lof_fetch_weather_data();

    if ( is_wp_error( $data ) ) {
        return new WP_REST_Response(
            array(
                'ok'    => false,
                'error' => $data->get_error_message(),
            ),
            500
        );
    }

    $weather = isset( $data['weather'][0] ) ? $data['weather'][0] : array();
    $main    = isset( $data['main'] ) ? $data['main'] : array();

    $description = isset( $weather['description'] ) ? $weather['description'] : 'Weather unavailable';
    // Capitalize first letter safely (UTF-8).
    $description = mb_strtoupper( mb_substr( $description, 0, 1 ) ) . mb_substr( $description, 1 );

    $temp       = isset( $main['temp'] ) ? round( $main['temp'] ) : null;
    $temp_min   = isset( $main['temp_min'] ) ? round( $main['temp_min'] ) : null;
    $temp_max   = isset( $main['temp_max'] ) ? round( $main['temp_max'] ) : null;
    $feels_like = isset( $main['feels_like'] ) ? round( $main['feels_like'] ) : null;

    $weather_main = isset( $weather['main'] ) ? strtolower( $weather['main'] ) : '';
    $emoji        = '☀️';

    if ( false !== strpos( $weather_main, 'cloud' ) ) {
        $emoji = '☁️';
    } elseif ( false !== strpos( $weather_main, 'rain' ) || false !== strpos( $weather_main, 'drizzle' ) ) {
        $emoji = '🌧️';
    } elseif ( false !== strpos( $weather_main, 'snow' ) ) {
        $emoji = '❄️';
    } elseif ( false !== strpos( $weather_main, 'thunderstorm' ) ) {
        $emoji = '⛈️';
    } elseif (
        false !== strpos( $weather_main, 'mist' ) ||
        false !== strpos( $weather_main, 'fog' ) ||
        false !== strpos( $weather_main, 'haze' ) ||
        false !== strpos( $weather_main, 'smoke' )
    ) {
        $emoji = '🌫️';
    }

    // OpenWeather rain is volume (mm), not probability.
    $rain_volume = 0;
    if ( isset( $data['rain'] ) ) {
        if ( isset( $data['rain']['1h'] ) ) {
            $rain_volume = $data['rain']['1h'];
        } elseif ( isset( $data['rain']['3h'] ) ) {
            $rain_volume = $data['rain']['3h'];
        }
    }
    $will_rain = $rain_volume > 0;

    return array(
        'ok'          => true,
        'emoji'       => $emoji,
        'description' => $description,
        'temp'        => $temp,
        'temp_min'    => $temp_min,
        'temp_max'    => $temp_max,
        'feels_like'  => $feels_like,
        'will_rain'   => $will_rain,
        'raw'         => array(
            'dt' => isset( $data['dt'] ) ? $data['dt'] : null,
        ),
    );
}

/**
 * Inject JS + CSS in the footer.
 * Assumes Elementor (or any template) contains:
 *   <div id="weather-info" data-refresh-minutes="10">Loading...</div>
 */
add_action(
    'wp_footer',
    function () {
        ?>
    <script>
    (function() {
        const el = document.getElementById('weather-info');
        if (!el) return;

        const REFRESH_MINUTES = parseInt(el.dataset.refreshMinutes || '10', 10);
        const CACHE_KEY = 'lofWeatherData';
        const CACHE_TIME_KEY = 'lofWeatherTimestamp';
        const MAX_AGE = REFRESH_MINUTES * 60 * 1000;

        async function loadWeather(force) {
            const now = Date.now();

            try {
                // 1) Use localStorage cache if fresh and not forced
                if (!force && window.localStorage) {
                    const cached = localStorage.getItem(CACHE_KEY);
                    const cachedTime = localStorage.getItem(CACHE_TIME_KEY);
                    if (cached && cachedTime && (now - parseInt(cachedTime, 10)) < MAX_AGE) {
                        render(JSON.parse(cached));
                        return;
                    }
                }

                // 2) Otherwise, hit the REST endpoint (which is server-side cached)
                const response = await fetch('<?php echo esc_url( rest_url( 'lof/v1/weather' ) ); ?>', {
                    cache: 'no-store'
                });

                const data = await response.json();

                if (!data.ok) {
                    throw new Error(data.error || 'Weather error');
                }

                if (window.localStorage) {
                    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
                    localStorage.setItem(CACHE_TIME_KEY, String(now));
                }

                render(data);
            } catch (err) {
                console.error('Error loading weather:', err);
                el.textContent = 'Weather data not available.';
            }
        }

        function render(data) {
            const emoji = data.emoji || '☀️';
            const desc = data.description || 'Weather unavailable';
            const low = (data.temp_min !== null && data.temp_min !== undefined) ? data.temp_min + '°F' : '—';
            const high = (data.temp_max !== null && data.temp_max !== undefined) ? data.temp_max + '°F' : '—';
            const feels = (data.feels_like !== null && data.feels_like !== undefined) ? data.feels_like + '°F' : null;

            let rainText = 'No rain expected';
            if (data.will_rain) {
                rainText = 'Rain likely';
            }

            let line = `${emoji} Tonight’s Weather: ${desc} | Low: ${low} | High: ${high} | ${rainText}`;
            if (feels) {
                line += ` | Feels like: ${feels}`;
            }

            el.textContent = line;
        }

        // Initial load
        loadWeather(false);

        // Auto-refresh every X minutes
        setInterval(function() {
            loadWeather(false);
        }, REFRESH_MINUTES * 60 * 1000);
    })();
    </script>

    <style>
    #weather-info {
        background: linear-gradient(to right, #E8FF00 0%, #D39072 50%, #BD21E3 100%);
        padding: 8px;
        font-size: 16px;
        color: black;
        text-align: center;
        box-shadow: 0 4px 6px rgba(13, 9, 9, 0.1);
        width: 100%;
        margin: 0;
    }
    </style>
    <?php
    }
);