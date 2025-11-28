<?php
/**
 * Plugin Name: Lights on Falcon - Epic Viewer Enqueue
 * Description: Auto-enqueue lof-epic-viewer.js on pages containing the Remote Falcon viewer.
 * Author: Lights on Falcon
 * Version: 1.0.0
 */

if (!defined('ABSPATH')) {
    exit;
}

function lof_maybe_enqueue_epic_viewer_js_mu() {
    global $post;

    // Safety: make sure we have a post object
    if (!isset($post) || !isset($post->post_content)) {
        return;
    }

    // Only load on pages that have the [rf_viewer] shortcode
    if (has_shortcode($post->post_content, 'rf_viewer')) {

        // JS lives in the integrations theme folder
        $script_url = content_url('/themes/integrations/js/lof-epic-viewer.js');

        wp_enqueue_script(
            'lof-epic-viewer',
            $script_url,
            array(),
            '1.0.0',
            true // footer
        );
    }
}
add_action('wp_enqueue_scripts', 'lof_maybe_enqueue_epic_viewer_js_mu');

// V1.5: Enqueue mobile-magic.js for tap confetti on mobile
add_action('wp_enqueue_scripts', 'lof_enqueue_mobile_magic');

function lof_enqueue_mobile_magic() {
    global $post;
    
    // Only load on pages with the [rf_viewer] shortcode
    if (isset($post) && isset($post->post_content) && has_shortcode($post->post_content, 'rf_viewer')) {
        $script_url = content_url('/themes/integrations/js/lof-viewer-mobile-magic.js');
        
        wp_enqueue_script(
            'lof-mobile-magic',
            $script_url,
            array(),
            '1.0.0',
            true // footer
        );
    }
}