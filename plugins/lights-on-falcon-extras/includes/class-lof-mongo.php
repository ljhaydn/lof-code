<?php
/**
 * LOF MongoDB Connection
 * 
 * Connects to Remote Falcon's MongoDB to query song stats, request history,
 * and leaderboard data. This is read-only - we never write to RF's database.
 * 
 * @package Lights_On_Falcon
 * @since 1.5.0
 * @updated 1.5.1 - Fixed badge logic to fetch ALL song counts
 */

if (!defined('ABSPATH')) {
    exit;
}

class LOF_Mongo {
    
    /** @var string MongoDB connection string */
    private static $connection_string = 'mongodb://root:root@10.9.6.63:27017/?authSource=admin';
    
    /** @var string Database name */
    private static $database = 'remote-falcon';
    
    /** @var MongoDB\Client|null Cached client instance */
    private static $client = null;
    
    /** @var int Cache TTL for stats (seconds) */
    private static $cache_ttl = 60;
    
    /**
     * Get MongoDB client instance
     */
    private static function get_client() {
        if (self::$client === null) {
            // Check if MongoDB extension is loaded
            if (!extension_loaded('mongodb')) {
                error_log('[LOF Mongo] MongoDB extension not loaded');
                return null;
            }
            
            // Check if MongoDB library is installed (via Composer)
            if (!class_exists('MongoDB\Client')) {
                error_log('[LOF Mongo] MongoDB library not installed. Run: composer require mongodb/mongodb');
                return null;
            }
            
            try {
                self::$client = new MongoDB\Client(self::$connection_string);
            } catch (Exception $e) {
                error_log('[LOF Mongo] Connection failed: ' . $e->getMessage());
                return null;
            }
        }
        return self::$client;
    }
    
    /**
     * Get the show document (there's only one for this installation)
     */
    public static function get_show() {
        $cached = get_transient('lof_mongo_show');
        if ($cached !== false) {
            return $cached;
        }
        
        $client = self::get_client();
        if (!$client) return null;
        
        try {
            $collection = $client->selectCollection(self::$database, 'show');
            $show = $collection->findOne();
            
            if ($show) {
                $show_array = json_decode(json_encode($show), true);
                set_transient('lof_mongo_show', $show_array, self::$cache_ttl);
                return $show_array;
            }
        } catch (Exception $e) {
            error_log('[LOF Mongo] Query failed: ' . $e->getMessage());
        }
        
        return null;
    }
    
    /**
     * Get top requested songs for tonight
     * 
     * @param int $limit Number of songs to return
     * @return array Top songs with request counts
     */
    public static function get_top_songs_tonight($limit = 5) {
        $cache_key = 'lof_mongo_top_tonight_' . $limit;
        $cached = get_transient($cache_key);
        if ($cached !== false) {
            return $cached;
        }
        
        $client = self::get_client();
        if (!$client) return [];
        
        try {
            $collection = $client->selectCollection(self::$database, 'show');
            
            // Get today's date in the format stored in jukebox stats
            $today = date('Y-m-d');
            $timezone = new DateTimeZone('America/Los_Angeles');
            $start_of_day = new DateTime($today . ' 00:00:00', $timezone);
            $end_of_day = new DateTime($today . ' 23:59:59', $timezone);
            
            $pipeline = [
                ['$unwind' => '$stats.jukebox'],
                ['$match' => [
                    'stats.jukebox.dateTime' => [
                        '$gte' => new MongoDB\BSON\UTCDateTime($start_of_day->getTimestamp() * 1000),
                        '$lte' => new MongoDB\BSON\UTCDateTime($end_of_day->getTimestamp() * 1000)
                    ]
                ]],
                ['$group' => [
                    '_id' => '$stats.jukebox.name',
                    'count' => ['$sum' => 1]
                ]],
                ['$sort' => ['count' => -1]],
                ['$limit' => $limit]
            ];
            
            $results = $collection->aggregate($pipeline)->toArray();
            $top_songs = [];
            
            foreach ($results as $result) {
                $result_array = json_decode(json_encode($result), true);
                $top_songs[] = [
                    'sequence' => $result_array['_id'],
                    'count' => $result_array['count']
                ];
            }
            
            // Enrich with display names from sequences
            $show = self::get_show();
            if ($show && isset($show['sequences'])) {
                $sequence_map = [];
                foreach ($show['sequences'] as $seq) {
                    if (isset($seq['name'])) {
                        $sequence_map[$seq['name']] = $seq['displayName'] ?? $seq['name'];
                    }
                }
                
                foreach ($top_songs as &$song) {
                    if (isset($sequence_map[$song['sequence']])) {
                        $song['displayName'] = $sequence_map[$song['sequence']];
                    } else {
                        $song['displayName'] = $song['sequence'];
                    }
                }
            }
            
            set_transient($cache_key, $top_songs, 120); // 2 min cache
            return $top_songs;
            
        } catch (Exception $e) {
            error_log('[LOF Mongo] Top songs query failed: ' . $e->getMessage());
        }
        
        return [];
    }
    
    /**
     * Get top requested songs for the entire season
     * 
     * @param int $limit Number of songs to return
     * @return array Top songs with request counts
     */
    public static function get_top_songs_season($limit = 5) {
        $cache_key = 'lof_mongo_top_season_' . $limit;
        $cached = get_transient($cache_key);
        if ($cached !== false) {
            return $cached;
        }
        
        $client = self::get_client();
        if (!$client) return [];
        
        try {
            $collection = $client->selectCollection(self::$database, 'show');
            
            // Season starts December 1st
            $timezone = new DateTimeZone('America/Los_Angeles');
            $season_start = new DateTime('2025-12-01 00:00:00', $timezone);
            
            $pipeline = [
                ['$unwind' => '$stats.jukebox'],
                ['$match' => [
                    'stats.jukebox.dateTime' => [
                        '$gte' => new MongoDB\BSON\UTCDateTime($season_start->getTimestamp() * 1000)
                    ]
                ]],
                ['$group' => [
                    '_id' => '$stats.jukebox.name',
                    'count' => ['$sum' => 1]
                ]],
                ['$sort' => ['count' => -1]],
                ['$limit' => $limit]
            ];
            
            $results = $collection->aggregate($pipeline)->toArray();
            $top_songs = [];
            
            foreach ($results as $result) {
                $result_array = json_decode(json_encode($result), true);
                $top_songs[] = [
                    'sequence' => $result_array['_id'],
                    'count' => $result_array['count']
                ];
            }
            
            // Enrich with display names
            $show = self::get_show();
            if ($show && isset($show['sequences'])) {
                $sequence_map = [];
                foreach ($show['sequences'] as $seq) {
                    if (isset($seq['name'])) {
                        $sequence_map[$seq['name']] = $seq['displayName'] ?? $seq['name'];
                    }
                }
                
                foreach ($top_songs as &$song) {
                    if (isset($sequence_map[$song['sequence']])) {
                        $song['displayName'] = $sequence_map[$song['sequence']];
                    } else {
                        $song['displayName'] = $song['sequence'];
                    }
                }
            }
            
            set_transient($cache_key, $top_songs, 300); // 5 min cache
            return $top_songs;
            
        } catch (Exception $e) {
            error_log('[LOF Mongo] Top songs season query failed: ' . $e->getMessage());
        }
        
        return [];
    }
    
    /**
     * V1.5.1: Get ALL song request counts for the season (for proper badge calculation)
     * 
     * @return array Map of sequence name => request count
     */
    public static function get_all_song_counts_season() {
        $cache_key = 'lof_mongo_all_counts_season';
        $cached = get_transient($cache_key);
        
        // V1.5.1: Only use cache if it's a non-empty array
        if (is_array($cached) && !empty($cached)) {
            return $cached;
        }
        
        $client = self::get_client();
        if (!$client) {
            error_log('[LOF Mongo] get_all_song_counts_season: No client');
            return [];
        }
        
        try {
            $collection = $client->selectCollection(self::$database, 'show');
            
            // Season starts December 1st
            $timezone = new DateTimeZone('America/Los_Angeles');
            $season_start = new DateTime('2025-12-01 00:00:00', $timezone);
            
            $pipeline = [
                ['$unwind' => '$stats.jukebox'],
                ['$match' => [
                    'stats.jukebox.dateTime' => [
                        '$gte' => new MongoDB\BSON\UTCDateTime($season_start->getTimestamp() * 1000)
                    ]
                ]],
                ['$group' => [
                    '_id' => '$stats.jukebox.name',
                    'count' => ['$sum' => 1]
                ]]
            ];
            
            $results = $collection->aggregate($pipeline)->toArray();
            $counts = [];
            
            foreach ($results as $result) {
                $result_array = json_decode(json_encode($result), true);
                if (isset($result_array['_id']) && $result_array['_id'] !== null) {
                    $counts[$result_array['_id']] = $result_array['count'];
                }
            }
            
            // V1.5.1: Only cache if we got actual data
            if (!empty($counts)) {
                set_transient($cache_key, $counts, 300); // 5 min cache
            } else {
                error_log('[LOF Mongo] get_all_song_counts_season: Empty counts, not caching');
            }
            
            return $counts;
            
        } catch (Exception $e) {
            error_log('[LOF Mongo] All song counts query failed: ' . $e->getMessage());
        }
        
        return [];
    }
    
    /**
     * Get total request count for tonight
     * 
     * @return int Request count
     */
    public static function get_requests_tonight() {
        $cached = get_transient('lof_mongo_requests_tonight');
        if ($cached !== false) {
            return (int) $cached;
        }
        
        $client = self::get_client();
        if (!$client) return 0;
        
        try {
            $collection = $client->selectCollection(self::$database, 'show');
            
            $today = date('Y-m-d');
            $timezone = new DateTimeZone('America/Los_Angeles');
            $start_of_day = new DateTime($today . ' 00:00:00', $timezone);
            $end_of_day = new DateTime($today . ' 23:59:59', $timezone);
            
            $pipeline = [
                ['$unwind' => '$stats.jukebox'],
                ['$match' => [
                    'stats.jukebox.dateTime' => [
                        '$gte' => new MongoDB\BSON\UTCDateTime($start_of_day->getTimestamp() * 1000),
                        '$lte' => new MongoDB\BSON\UTCDateTime($end_of_day->getTimestamp() * 1000)
                    ]
                ]],
                ['$count' => 'total']
            ];
            
            $results = $collection->aggregate($pipeline)->toArray();
            $count = !empty($results) ? $results[0]['total'] : 0;
            
            set_transient('lof_mongo_requests_tonight', $count, 60);
            return (int) $count;
            
        } catch (Exception $e) {
            error_log('[LOF Mongo] Tonight count failed: ' . $e->getMessage());
        }
        
        return 0;
    }
    
    /**
     * Get total request count for the season
     * 
     * @return int Request count
     */
    public static function get_requests_season() {
        $cached = get_transient('lof_mongo_requests_season');
        if ($cached !== false) {
            return (int) $cached;
        }
        
        $client = self::get_client();
        if (!$client) return 0;
        
        try {
            $collection = $client->selectCollection(self::$database, 'show');
            
            $timezone = new DateTimeZone('America/Los_Angeles');
            $season_start = new DateTime('2025-12-01 00:00:00', $timezone);
            
            $pipeline = [
                ['$unwind' => '$stats.jukebox'],
                ['$match' => [
                    'stats.jukebox.dateTime' => [
                        '$gte' => new MongoDB\BSON\UTCDateTime($season_start->getTimestamp() * 1000)
                    ]
                ]],
                ['$count' => 'total']
            ];
            
            $results = $collection->aggregate($pipeline)->toArray();
            $count = !empty($results) ? $results[0]['total'] : 0;
            
            set_transient('lof_mongo_requests_season', $count, 300);
            return (int) $count;
            
        } catch (Exception $e) {
            error_log('[LOF Mongo] Season count failed: ' . $e->getMessage());
        }
        
        return 0;
    }
    
    /**
     * Get sequences with category data for badges
     * V1.5.1: Fixed to use ALL song counts, not just top 10
     * 
     * @return array Sequences with metadata
     */
    public static function get_sequences_with_stats() {
        $show = self::get_show();
        if (!$show || !isset($show['sequences'])) {
            return [];
        }
        
        // V1.5.1: Get ALL song counts, not just top 10
        $all_counts = self::get_all_song_counts_season();
        $top_tonight = self::get_top_songs_tonight(10);
        $top_season = self::get_top_songs_season(10);
        
        // Build tonight lookup map (for "Hot Tonight" badge - top 3)
        $tonight_map = [];
        foreach ($top_tonight as $i => $song) {
            $tonight_map[$song['sequence']] = $i + 1; // 1-indexed rank
        }
        
        // Build season rank lookup (for "Crowd Favorite" badge - #1 only)
        $season_rank_map = [];
        foreach ($top_season as $i => $song) {
            $season_rank_map[$song['sequence']] = $i + 1;
        }
        
        // Calculate thresholds for "Hidden Gem"
        // A song is a "hidden gem" if it has 0-2 requests AND there's enough data to be meaningful
        $total_requests = self::get_requests_season();
        $total_songs = 0;
        foreach ($show['sequences'] as $seq) {
            if (isset($seq['visible']) && $seq['visible'] && isset($seq['active']) && $seq['active']) {
                $total_songs++;
            }
        }
        
        // Only show "Hidden Gem" badges if we have meaningful data (at least 20 total requests)
        $show_gem_badges = ($total_requests >= 20);
        
        // Gem threshold: songs with <= 2 requests are hidden gems (if we have enough data)
        $gem_threshold = 2;
        
        $sequences = [];
        foreach ($show['sequences'] as $seq) {
            if (!isset($seq['name']) || !isset($seq['visible']) || !$seq['visible']) {
                continue;
            }
            if (!isset($seq['active']) || !$seq['active']) {
                continue;
            }
            
            $name = $seq['name'];
            $badges = [];
            $song_count = isset($all_counts[$name]) ? $all_counts[$name] : 0;
            
            // Hot Tonight badge (top 3 tonight)
            if (isset($tonight_map[$name]) && $tonight_map[$name] <= 3) {
                $badges[] = [
                    'type' => 'hot',
                    'icon' => '🔥',
                    'label' => 'Hot tonight'
                ];
            }
            
            // Crowd Favorite badge (#1 this season)
            if (isset($season_rank_map[$name]) && $season_rank_map[$name] === 1) {
                $badges[] = [
                    'type' => 'favorite',
                    'icon' => '👑',
                    'label' => 'Crowd fave'
                ];
            }
            
            // Hidden Gem: only if we have enough data AND song has very few requests
            // AND song doesn't already have a "hot" or "favorite" badge
            if ($show_gem_badges && $song_count <= $gem_threshold && empty($badges)) {
                $badges[] = [
                    'type' => 'gem',
                    'icon' => '💎',
                    'label' => 'Hidden gem'
                ];
            }
            
            $sequences[$name] = [
                'displayName' => $seq['displayName'] ?? $name,
                'badges' => $badges,
                'tonight_rank' => $tonight_map[$name] ?? null,
                'season_rank' => isset($season_rank_map[$name]) ? $season_rank_map[$name] : null,
                'season_count' => $song_count
            ];
        }
        
        return $sequences;
    }
    
    /**
     * Get requests per hour for tonight (for vibe check)
     * 
     * @return float Requests per hour
     */
    public static function get_requests_per_hour_tonight() {
        $client = self::get_client();
        if (!$client) return 0;
        
        try {
            $collection = $client->selectCollection(self::$database, 'show');
            
            $timezone = new DateTimeZone('America/Los_Angeles');
            $now = new DateTime('now', $timezone);
            $one_hour_ago = clone $now;
            $one_hour_ago->modify('-1 hour');
            
            $pipeline = [
                ['$unwind' => '$stats.jukebox'],
                ['$match' => [
                    'stats.jukebox.dateTime' => [
                        '$gte' => new MongoDB\BSON\UTCDateTime($one_hour_ago->getTimestamp() * 1000),
                        '$lte' => new MongoDB\BSON\UTCDateTime($now->getTimestamp() * 1000)
                    ]
                ]],
                ['$count' => 'total']
            ];
            
            $results = $collection->aggregate($pipeline)->toArray();
            return !empty($results) ? (float) $results[0]['total'] : 0;
            
        } catch (Exception $e) {
            error_log('[LOF Mongo] Requests per hour failed: ' . $e->getMessage());
        }
        
        return 0;
    }
}
