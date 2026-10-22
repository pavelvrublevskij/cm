const crypto = require('crypto');
const { INSIGHTS_HISTORY_FILE } = require('./paths');
const { readJson, writeDataJson } = require('./file-helpers');

// Oldest reports are dropped beyond this many.
const MAX_REPORTS = 50;

function readReports() {
  const data = readJson(INSIGHTS_HISTORY_FILE, { reports: [] });
  return Array.isArray(data.reports) ? data.reports : [];
}

function writeReports(reports) {
  writeDataJson(INSIGHTS_HISTORY_FILE, { reports });
}

/** Save a finished analysis; newest first. Returns the stored entry. */
function saveReport({ report, model, effort, scope, sessionLinks, generatedAt }) {
  const entry = { id: crypto.randomUUID(), generatedAt, model, effort, scope, sessionLinks, report };
  writeReports([entry].concat(readReports()).slice(0, MAX_REPORTS));
  return entry;
}

/** All saved reports without their (large) report text. */
function listReports() {
  return readReports().map(({ report, sessionLinks, ...meta }) => meta);
}

function getReport(id) {
  return readReports().find(r => r.id === id) || null;
}

function deleteReport(id) {
  const reports = readReports();
  const next = reports.filter(r => r.id !== id);
  if (next.length === reports.length) return false;
  writeReports(next);
  return true;
}

module.exports = { saveReport, listReports, getReport, deleteReport, MAX_REPORTS };
