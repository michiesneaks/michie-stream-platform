'use strict';
/**
 * Michie Stream Platform — server entry point
 *
 * This file does exactly three things:
 *   1. Boots infrastructure (Redis, env, global error handlers)
 *   2. Mounts middleware and routes onto Express
 *   3. Starts the HTTP/HTTPS server and attaches WebSocket
 *
 * Business logic lives in src/routes/ and src/services/.
 * Constants live in src/config/constants.js.
 *
 * ENV variables: see README or the top of the original server.cjs for full list.
 */

// ── Global error handling ─────────────────────────────────────────────────────
process.on('uncaughtException',  (err) => { console.error('Uncaught Exception:',  err.stack || err); process.exit(1); });
process.on('unhandledRejection', (reason) => { console.error('Unhandled Rejection:', reason?.stack || reason); process.exit(1); });

require('dotenv').config();

const path        = require('path');
const express     = require('express');
const helmet      = require('helmet');
const compression = require('compression');
const rateLimit   = require('express-rate-limit');
const fs          = require('fs-extra');

const logger          = require('./config/logger');
const walletNormalizer = require('./middleware/walletNormalizer');
const redisService    = require('./services/redisService');
const { attachWebSocket } = require('./websocket/wsServer');

// ── Route modules ─────────────────────────────────────────────────────────────
const profileRoutes      = require('./routes/profiles');
const subscriptionRoutes = require('./routes/subscriptions');
const nftPlatformRoutes  = require('./routes/nftPlatform');
const accessRoutes       = require('./routes/access');
const royaltyRoutes      = require('./routes/royalties');
const uploadRoutes       = require('./routes/upload');
const catalogRoutes      = require('./routes/catalog');
const playlistRoutes     = require('./routes/playlists');
const favoritesRoutes    = require('./routes/favorites');
const djSetRoutes        = require('./routes/djSets');
const liveRoutes         = require('./routes/live');
const streamKeyRoutes    = require('./routes/streamKeys');
const playTokenRoutes    = require('./routes/playTokens');
const utilityRoutes      = require('./routes/utility');
const analyticsRoutes    = require('./src/routes/analytics');

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();

app.set('trust proxy', 1);

app.use(helmet({
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      scriptSrc:  ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      imgSrc:     ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'wss:', 'https:'],
    },
  },
}));

app.use(compression());

app.use(rateLimit({
  windowMs:       15 * 60 * 1000,
  max:            1000,
  standardHeaders: true,
  legacyHeaders:  false,
  message:        'Too many requests — try again later',
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(process.cwd(), 'public')));
app.use(express.static(process.cwd()));

app.get('/', (req, res) => res.sendFile(path.join(process.cwd(), 'public', 'index.html')));

app.use(walletNormalizer);

// ── Route mounting ────────────────────────────────────────────────────────────
// Profiles
app.use('/api/profile',                  profileRoutes);
app.post('/api/create-profile',          (req, res, next) => { req.url = '/create-profile'; profileRoutes(req, res, next); });
app.post('/api/update-profile',          (req, res, next) => { req.url = '/update-profile'; profileRoutes(req, res, next); });

// Subscription / capability upgrades
app.post('/api/subscribe',               (req, res, next) => { req.url = '/'; subscriptionRoutes(req, res, next); });

// Platform NFT flows
app.use('/api',                          nftPlatformRoutes);   
// /api/claim-platform-nft, /api/check-platform-nft

// Access + supporter sub-account controls
app.use('/api/access',                   accessRoutes);        
// GET  /api/access/:wallet
app.post('/api/add-supporter-subaccount',    (req, res, next) => { req.url = '/add-supporter-subaccount';    accessRoutes(req, res, next); });
app.post('/api/toggle-supporter-subaccount', (req, res, next) => { req.url = '/toggle-supporter-subaccount'; accessRoutes(req, res, next); });

// Royalties + playlist earnings
app.use('/api',                          royaltyRoutes);       
// /api/tip, /api/nft-sale-fee, /api/set-royalty-splits, /api/royalty-splits, /api/playlist-earnings/:wallet

// Upload + catalog
app.use('/api/upload',                   uploadRoutes);
app.use('/api/catalog',                  catalogRoutes);

// Playlist management + analytics
app.use('/api/playlists',                playlistRoutes);
app.use('/api/analytics', analyticsRoutes);

// CRUD, add/remove/reorder, per-playlist analytics, creator asset playlist analytics
app.post('/api/create-playlist',         (req, res, next) => { req.url = '/'; playlistRoutes(req, res, next); }); // legacy alias kept for older UI flows

// Favorites remain separate; conversion can create a rich playlist
app.use('/api/favorites',                favoritesRoutes);

// DJ sets
app.post('/api/start-dj-set',            (req, res, next) => { req.url = '/start'; djSetRoutes(req, res, next); });
app.post('/api/end-dj-set',              (req, res, next) => { req.url = '/end';   djSetRoutes(req, res, next); });

// Live sessions
app.post('/api/live-start',              (req, res, next) => { req.url = '/start';        liveRoutes(req, res, next); });
app.post('/api/live-end/:sessionId',     (req, res, next) => { req.url = '/end/' + req.params.sessionId; liveRoutes(req, res, next); });
app.post('/api/live-ingest/:sessionId',  (req, res, next) => { req.url = '/ingest/' + req.params.sessionId; liveRoutes(req, res, next); });
app.get('/api/live-concerts',            (req, res, next) => { req.url = '/concerts';     liveRoutes(req, res, next); });
app.post('/api/start-live-encode',       (req, res, next) => { req.url = '/start-encode'; liveRoutes(req, res, next); });
app.get('/api/live-recording/:sessionId',(req, res, next) => { req.url = '/recording/' + req.params.sessionId; liveRoutes(req, res, next); });

// Creator streaming credentials
app.use('/api/stream-key',               streamKeyRoutes);

// Play-token flow (proof updates playlist analytics when playlistId is present)
app.post('/api/request-play-token',      (req, res, next) => { req.url = '/request'; playTokenRoutes(req, res, next); });
app.post('/api/submit-play-proof',       (req, res, next) => { req.url = '/proof';   playTokenRoutes(req, res, next); });

// Utility endpoints
app.use('/api',                          utilityRoutes);       
// /api/fees, /api/convert-currency, /api/nfts

// ── Error handlers ────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

// ── Server startup ────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 3001);

async function startServer() {
  await redisService.connect();

  const net         = require('net');
  const isPortInUse = (port) => new Promise((resolve) => {
    const t = net.createServer();
    t.once('error', () => resolve(true));
    t.once('listening', () => { t.close(); resolve(false); });
    t.listen(port);
  });

  if (process.env.TLS_KEY_PATH && process.env.TLS_CERT_PATH) {
    if (!fs.existsSync(process.env.TLS_KEY_PATH) || !fs.existsSync(process.env.TLS_CERT_PATH)) {
      throw new Error('TLS certificate files not found');
    }
    const tlsOptions = {
      key:              fs.readFileSync(process.env.TLS_KEY_PATH),
      cert:             fs.readFileSync(process.env.TLS_CERT_PATH),
      minVersion:       'TLSv1.3',
      ciphers:          'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256',
      honorCipherOrder: true,
    };
    const httpsServer = require('https').createServer(tlsOptions, app);
    attachWebSocket(httpsServer);
    httpsServer.listen(443, () => logger.info('HTTPS server on port 443'));

    const port80InUse = await isPortInUse(80);
    if (!port80InUse) {
      require('http').createServer((req, res) => {
        res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` });
        res.end();
      }).listen(80, () => logger.info('HTTP redirect on port 80'));
    }
  } else {
    logger.warn('TLS not configured — starting HTTP server');
    const httpServer = require('http').createServer(app);
    attachWebSocket(httpServer);
    httpServer.listen(PORT, () => logger.info(`HTTP server on http://localhost:${PORT}`));
  }
}

startServer().catch((err) => {
  logger.error({ err }, 'Server failed to start');
  process.exit(1);
});

module.exports = { app };
