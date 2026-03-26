'use strict';

const path = require('path');
const fs   = require('fs-extra');
const pino = require('pino');

const logsDir = path.resolve(process.cwd(), 'logs');
fs.ensureDirSync(logsDir);

const logger = pino(
  { level: process.env.LOG_LEVEL || 'info' },
  pino.destination(path.join(logsDir, 'metrics.log'))
);

module.exports = logger;
