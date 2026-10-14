const fs = require('fs');
const { DATA_DIR } = require('./paths');
const path = require('path');

const COLORS_FILE = path.join(DATA_DIR, 'session-colors.json');
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function readAll() {
  try { return JSON.parse(fs.readFileSync(COLORS_FILE, 'utf8')); }
  catch { return {}; }
}

function writeAll(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(COLORS_FILE, JSON.stringify(data));
}

function getSessionColors(slug) {
  return readAll()[slug] || {};
}

function setSessionColor(slug, sessionId, color) {
  const all = readAll();
  const colors = all[slug] || {};
  if (color) colors[sessionId] = color.toLowerCase();
  else delete colors[sessionId];
  if (Object.keys(colors).length) all[slug] = colors;
  else delete all[slug];
  writeAll(all);
}

function isValidColor(color) {
  return typeof color === 'string' && COLOR_RE.test(color);
}

module.exports = { getAllSessionColors: readAll, getSessionColors, setSessionColor, isValidColor };
