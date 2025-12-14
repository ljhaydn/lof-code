<?php
/**
 * LOF MongoDB Connection
 * 
 * Connects to Remote Falcon's MongoDB to query song stats, request history,
 * and leaderboard data. This is read-only - we never write to RF's database.
 * 
 * @package Lights_On_Falcon
 * @since 1.5.0
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
            if (!extension_loaded('mongodb')) {
                error_log('[LOF Mongo] MongoDB extension not loaded');
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
                    '_id' => '$stats.jukebox.sequence',
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
                    '_id' => '$stats.jukebox.sequence',
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
            error_log('[LOF Mongo] Season songs query failed: ' . $e->getMessage());
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
     * 
     * @return array Sequences with metadata
     */
    public static function get_sequences_with_stats() {
        $show = self::get_show();
        if (!$show || !isset($show['sequences'])) {
            return [];
        }
        
        $top_tonight = self::get_top_songs_tonight(10);
        $top_season = self::get_top_songs_season(10);
        
        // Build lookup maps
        $tonight_map = [];
        foreach ($top_tonight as $i => $song) {
            $tonight_map[$song['sequence']] = $i + 1; // 1-indexed rank
        }
        
        $season_map = [];
        foreach ($top_season as $i => $song) {
            $season_map[$song['sequence']] = [
                'rank' => $i + 1,
                'count' => $song['count']
            ];
        }
        
        // Find the 48-hour threshold for "fresh" songs
        // We'd need createdDate on sequences, but RF doesn't track that
        // For now, we'll mark songs with low play counts as "hidden gems"
        $total_requests = self::get_requests_season();
        $avg_per_song = $total_requests / max(count($show['sequences']), 1);
        
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
            
            // Hot Tonight badge (top 3)
            if (isset($tonight_map[$name]) && $tonight_map[$name] <= 3) {
                $badges[] = [
                    'type' => 'hot',
                    'icon' => '🔥',
                    'label' => 'Hot Tonight'
                ];
            }
            
            // Crowd Favorite badge (#1 this season)
            if (isset($season_map[$name]) && $season_map[$name]['rank'] === 1) {
                $badges[] = [
                    'type' => 'favorite',
                    'icon' => '👑',
                    'label' => 'Crowd Favorite'
                ];
            }
            
            // Hidden Gem (bottom 25% by season requests)
            if (isset($season_map[$name])) {
                $song_count = $season_map[$name]['count'];
                if ($song_count < $avg_per_song * 0.25) {
                    $badges[] = [
                        'type' => 'gem',
                        'icon' => '💎',
                        'label' => 'Hidden Gem'
                    ];
                }
            } elseif (!isset($season_map[$name])) {
                // Never requested = definitely a hidden gem
                $badges[] = [
                    'type' => 'gem',
                    'icon' => '💎', 
                    'label' => 'Hidden Gem'
                ];
            }
            
            $sequences[$name] = [
                'displayName' => $seq['displayName'] ?? $name,
                'badges' => $badges,
                'tonight_rank' => $tonight_map[$name] ?? null,
                'season_rank' => isset($season_map[$name]) ? $season_map[$name]['rank'] : null,
                'season_count' => isset($season_map[$name]) ? $season_map[$name]['count'] : 0
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
