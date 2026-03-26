'use strict';

const logger      = require('../config/logger');
const sessionStore = require('../state/liveSessions');

/**
 * Attaches a WebSocket server to an existing HTTP/HTTPS server.
 * All session state is managed through the shared liveSessions store.
 */
function attachWebSocket(httpServer) {
  let WebSocketServer;
  try {
    ({ WebSocketServer } = require('ws'));
  } catch {
    try {
      const ws = require('ws');
      WebSocketServer = ws.Server || ws;
    } catch {
      logger.warn('ws package not found — WebSocket disabled. Run: npm install ws');
      return;
    }
  }

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  logger.info('WebSocket server attached at /ws');

  wss.on('connection', (ws) => {
    let sessionId = null;
    let role      = 'viewer';

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'join_session') {
        sessionId = msg.sessionId;
        role      = msg.name === 'HOST' ? 'host' : 'viewer';
        registerClient(ws, sessionId, role);
        return;
      }

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      if (sessionId && ['chat', 'reaction', 'tip', 'tip_alert'].includes(msg.type)) {
        if (msg.type === 'tip' && msg.amount) {
          sessionStore.addTip(sessionId, msg.amount);
        }
        broadcast(sessionId, msg);
      }
    });

    ws.on('close', () => {
      if (!sessionId) return;
      unregisterClient(ws, sessionId, role);
    });

    ws.on('error', () => ws.close());
  });
}

// ── Client registry (session → Set of ws connections) ────────────────────────
const wsSessionClients = new Map();

function registerClient(ws, sessionId, role) {
  if (!wsSessionClients.has(sessionId)) wsSessionClients.set(sessionId, new Set());
  wsSessionClients.get(sessionId).add(ws);

  if (role === 'viewer') {
    sessionStore.incrementViewer(sessionId);
    broadcast(sessionId, {
      type:        'viewer_count',
      viewerCount: sessionStore.getSession(sessionId)?.viewerCount || 0,
    });
  }
}

function unregisterClient(ws, sessionId, role) {
  const clients = wsSessionClients.get(sessionId);
  if (clients) {
    clients.delete(ws);
    if (!clients.size) wsSessionClients.delete(sessionId);
  }

  if (role === 'viewer') {
    sessionStore.decrementViewer(sessionId);
    broadcast(sessionId, {
      type:        'viewer_count',
      viewerCount: sessionStore.getSession(sessionId)?.viewerCount || 0,
    });
  }
}

function broadcast(sessionId, msg) {
  const clients = wsSessionClients.get(sessionId);
  if (!clients) return;
  const text = JSON.stringify(msg);
  clients.forEach((ws) => {
    if (ws.readyState === 1 /* OPEN */) ws.send(text);
  });
}

module.exports = { attachWebSocket };
