const path = require('path');
const { DATA_DIR } = require('./paths');
const { readJson, writeDataJson, isSafeKey } = require('./file-helpers');

// Per-project click counts for the terminal skills popover, kept out of ~/.claude/ (read-only).
// Shape: { "<project-slug>": { "<skill-name>": <count> } }
const SKILL_USAGE_DB = path.join(DATA_DIR, 'skill-usage.json');

function readUsage(slug) {
  const db = readJson(SKILL_USAGE_DB, {});
  const counts = db[slug];
  return counts && typeof counts === 'object' ? counts : {};
}

function recordUsage(slug, name) {
  // The slug is guarded so db[slug] stays a plain entry; a skill may be named "constructor".
  if (!isSafeKey(slug) || name === '__proto__') throw new Error('Invalid key');
  const db = readJson(SKILL_USAGE_DB, {});
  const counts = (db[slug] && typeof db[slug] === 'object') ? db[slug] : {};
  counts[name] = (Object.prototype.hasOwnProperty.call(counts, name) ? counts[name] : 0) + 1;
  db[slug] = counts;
  writeDataJson(SKILL_USAGE_DB, db);
  return counts[name];
}

module.exports = { SKILL_USAGE_DB, readUsage, recordUsage };
