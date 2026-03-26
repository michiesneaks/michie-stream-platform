'use strict';

const path = require('path');
const fs   = require('fs-extra');

const DJ_SETS_PATH = path.resolve(process.cwd(), 'dj_sets.json');
fs.ensureFileSync(DJ_SETS_PATH);

async function loadDjSets() {
  try {
    return JSON.parse(await fs.readFile(DJ_SETS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

async function saveDjSets(sets) {
  await fs.writeFile(DJ_SETS_PATH, JSON.stringify(sets, null, 2));
}

module.exports = { loadDjSets, saveDjSets };
