const path = require('path');
const { DATA_DIR } = require('./paths');
const { readJson, writeDataJson } = require('./file-helpers');

// Per-project click counts for the terminal skills popover, kept out of ~/.claude/ (read-only).
// Shape: { "<project-slug>": { "<skill-name>": <count> } }
const SKILL_USAGE_DB = path.join(DATA_DIR, 'skill-usage.json');

function readUsage(slug) {
  const db = readJson(SKILL_USAGE_DB, {});
  const counts = db[slug];
  return counts && typeof counts === 'object' ? counts : {};
}

function recordUsage(slug, name) {
  const db = readJson(SKILL_USAGE_DB, {});
  const counts = (db[slug] && typeof db[slug] === 'object') ? db[slug] : {};
  counts[name] = (counts[name] || 0) + 1;
  db[slug] = counts;
  writeDataJson(SKILL_USAGE_DB, db);
  return counts[name];
}

module.exports = { SKILL_USAGE_DB, readUsage, recordUsage };
