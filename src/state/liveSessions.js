'use strict';

/**
 * In-memory live session store.
 * Shared by live routes and the WebSocket server.
 * Sessions are transient — lost on server restart (by design for MVP).
 *
 * Each session shape:
 *   { sessionId, wallet, title, artistName, quality, accountType,
 *     startTime, endTime?, alive, chunks[], chunkCount,
 *     viewerCount, peakViewers, tipsTotal }
 */
const liveSessions = new Map();

function getSession(sessionId) {
  return liveSessions.get(sessionId) || null;
}

function createSession(sessionId, data) {
  const session = {
    sessionId,
    chunks:      [],
    chunkCount:  0,
    viewerCount: 0,
    peakViewers: 0,
    tipsTotal:   0,
    alive:       true,
    startTime:   Date.now(),
    ...data,
  };
  liveSessions.set(sessionId, session);
  return session;
}

function endSession(sessionId) {
  const session = liveSessions.get(sessionId);
  if (!session) return null;
  session.alive   = false;
  session.endTime = Date.now();
  return session;
}

function incrementViewer(sessionId) {
  const session = liveSessions.get(sessionId);
  if (!session) return;
  session.viewerCount++;
  if (session.viewerCount > session.peakViewers) session.peakViewers = session.viewerCount;
}

function decrementViewer(sessionId) {
  const session = liveSessions.get(sessionId);
  if (!session || session.viewerCount <= 0) return;
  session.viewerCount--;
}

function addTip(sessionId, amount) {
  const session = liveSessions.get(sessionId);
  if (!session) return;
  session.tipsTotal += parseFloat(amount) || 0;
}

function getAllActive() {
  return Array.from(liveSessions.values()).filter((s) => s.alive);
}

module.exports = {
  liveSessions,
  getSession,
  createSession,
  endSession,
  incrementViewer,
  decrementViewer,
  addTip,
  getAllActive,
};
