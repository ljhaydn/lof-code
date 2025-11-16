<?php
/**
 * Lights On Falcon - Extras Loader (Phase A)
 */

if (!defined('ABSPATH')) exit;

require_once __DIR__ . '/includes/class-lof-settings.php';
require_once __DIR__ . '/includes/class-lof-api.php';

class LOF_Extras {
    public function __construct() {
        // Future: register filters, hooks, and viewer-config injection
    }
}

new LOF_Extras();
