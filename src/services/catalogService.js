'use strict';

const path = require('path');
const fs   = require('fs-extra');

const CATALOG_PATH = path.resolve(process.cwd(), 'catalog.json');

async function loadCatalog() {
  try {
    return JSON.parse(await fs.readFile(CATALOG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

async function saveCatalog(catalog) {
  await fs.writeFile(CATALOG_PATH, JSON.stringify(catalog, null, 2));
}

async function getCatalogEntry(contentId) {
  const catalog = await loadCatalog();
  return catalog[contentId] || null;
}

/**
 * Applies a partial patch to a single catalog entry and persists.
 * Throws if the entry does not exist.
 */
async function patchCatalogEntry(contentId, patch) {
  const catalog = await loadCatalog();
  if (!catalog[contentId]) throw new Error(`Catalog entry not found: ${contentId}`);
  catalog[contentId] = Object.assign({}, catalog[contentId], patch);
  await saveCatalog(catalog);
  return catalog[contentId];
}

/**
 * Adds a new entry to the catalog index.
 */
async function addCatalogEntry(contentId, entry) {
  const catalog = await loadCatalog();
  catalog[contentId] = { ...entry, uploadedAt: Date.now() };
  await saveCatalog(catalog);
}

module.exports = {
  loadCatalog,
  saveCatalog,
  getCatalogEntry,
  patchCatalogEntry,
  addCatalogEntry,
};
