'use strict';

const redis  = require('redis');
const logger = require('../config/logger');

let client = null;

async function connect() {
  try {
    client = redis.createClient({ url: process.env.REDIS_URL || 'redis://127.0.0.1:6379' });
    client.on('error', (err) => logger.error({ err }, 'Redis error'));
    await client.connect();
    logger.info('Redis connected');
  } catch (err) {
    logger.warn({ err }, 'Redis unavailable — continuing without cache');
    client = null;
  }
}

function getClient() {
  return client;
}

module.exports = { connect, getClient };
