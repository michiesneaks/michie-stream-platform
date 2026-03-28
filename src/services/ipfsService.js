'use strict';

const path   = require('path');
const fs     = require('fs-extra');
/* const { create: createIpfs } = require('ipfs-http-client'); */
const logger = require('../config/logger');

const IPFS_GATEWAY = process.env.IPFS_GATEWAY || 'https://ipfs.io/ipfs/';

let ipfs = null;
/* try {
  ipfs = createIpfs({ url: process.env.IPFS_ENDPOINT || 'http://127.0.0.1:5001' });
  logger.info('IPFS client initialized');
} catch (err) {
  logger.warn({ err }, 'IPFS client not configured');
} */

/**
 * Adds an entire directory to IPFS and returns the folder CID.
 */
async function addDirectoryToIpfs(ipfsClient, dir) {
  const entries = [];

  async function walk(base) {
    for (const name of await fs.readdir(base)) {
      const full = path.join(base, name);
      const stat = await fs.stat(full);
      if (stat.isDirectory()) {
        await walk(full);
      } else {
        const rel = path.relative(dir, full).split(path.sep).join('/');
        entries.push({ path: rel, content: fs.createReadStream(full) });
      }
    }
  }

  await walk(dir);

  const added = [];
  for await (const result of ipfsClient.addAll(entries, { wrapWithDirectory: true })) {
    added.push(result);
  }

  const dirEntry = added.find((r) => r.path === '');
  if (!dirEntry) throw new Error('IPFS folder CID not found');

  return { folderCid: dirEntry.cid.toString(), files: added };
}

module.exports = { ipfs, IPFS_GATEWAY, addDirectoryToIpfs };
