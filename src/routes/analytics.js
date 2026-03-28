'use strict';
const express = require('express');
const redisService = require('../services/redisService');
const router = express.Router();

// Middleware ensuring the Redis cache is active prior to processing
const requireRedis = (req, res, next) => {
    if (!redisService.getClient()) {
        return res.status(503).json({ error: 'Analytics service temporarily offline' });
    }
    next();
};

/**
 * POST /api/analytics/heartbeat
 * Ingests periodic telemetry pulses from the client media player.
 */
router.post('/heartbeat', requireRedis, async (req, res, next) => {
    try {
        const { cid, sessionId, elapsedSeconds, isNewPlay } = req.body;
        
        if (!cid ||!sessionId ||!elapsedSeconds) {
            return res.status(400).json({ error: 'Malformed telemetry payload' });
        }

        const redis = redisService.getClient();
        const assetHashKey = `stats:asset:${cid}`;
        const sessionKey = `stats:session:${sessionId}`;

        // Validate session existence to mitigate artificial metric inflation
        const sessionExists = await redis.exists(sessionKey);
        if (!sessionExists &&!isNewPlay) {
            return res.status(400).json({ error: 'Session expired or invalid' });
        }
        
        // Extend session TTL for four hours to accommodate extensive streaming
        await redis.setEx(sessionKey, 14400, 'active');

        // Utilize Redis pipelining for atomic, high-performance metric aggregations
        const multi = redis.multi();

        // Accumulate total streaming duration
        multi.hIncrBy(assetHashKey, 'totalTimeSeconds', elapsedSeconds); 
        
        // Elevate the asset within the global time-based leaderboard
        multi.zIncrBy('leaderboard:assets:time', elapsedSeconds, cid);

        // Register unique initialization events
        if (isNewPlay) {
            multi.hIncrBy(assetHashKey, 'totalPlays', 1);
            multi.zIncrBy('leaderboard:assets:plays', 1, cid);
        }

        await multi.exec();
        res.json({ success: true, recorded: true });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/analytics/asset/:cid
 * Exposes specific aggregated metrics for individual catalog assets.
 */
router.get('/asset/:cid', requireRedis, async (req, res, next) => {
    try {
        const redis = redisService.getClient();
        const data = await redis.hGetAll(`stats:asset:${req.params.cid}`);
        
        const totalPlays = parseInt(data.totalPlays || '0', 10);
        const totalTimeSeconds = parseInt(data.totalTimeSeconds || '0', 10);
        
        // Dynamically compute the average retention duration
        const averagePlayTimeSeconds = totalPlays > 0? Math.floor(totalTimeSeconds / totalPlays) : 0;

        res.json({
            cid: req.params.cid,
            totalPlays,
            totalTimeSeconds,
            averagePlayTimeSeconds
        });
    } catch (err) {
        next(err);
    }
});



// GET /api/analytics/assets/batch?cids=cid1,cid2,cid3
router.get('/assets/batch', requireRedis, async (req, res, next) => {
  try {
    const cids = String(req.query.cids || '').split(',').filter(Boolean).slice(0, 100);
    if (!cids.length) return res.json({});
    const redis = redisService.getClient();
    const results = {};
    await Promise.all(cids.map(async (cid) => {
      const data = await redis.hGetAll(`stats:asset:${cid}`);
      const totalPlays = parseInt(data.totalPlays || '0', 10);
      const totalTimeSeconds = parseInt(data.totalTimeSeconds || '0', 10);
      results[cid] = {
        totalPlays,
        totalTimeSeconds,
        averagePlayTimeSeconds: totalPlays > 0 ? Math.floor(totalTimeSeconds / totalPlays) : 0,
      };
    }));
    res.json(results);
  } catch (err) { next(err); }
});


module.exports = router;