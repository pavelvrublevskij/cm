const https = require('https');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./paths');
const { readJson, writeDataJson } = require('./file-helpers');

const PRICING_FILE = path.join(DATA_DIR, 'pricing-history.json');
const PRICING_URL = 'https://platform.claude.com/docs/en/docs/about-claude/pricing';

const FALLBACK_PRICING = {
  'claude-opus-5':             { input: 5,    output: 25,  cache_write: 6.25,  cache_read: 0.50 },
  'claude-opus-4-8':           { input: 5,    output: 25,  cache_write: 6.25,  cache_read: 0.50 },
  'claude-opus-4-6':           { input: 5,    output: 25,  cache_write: 6.25,  cache_read: 0.50 },
  'claude-opus-4-5':           { input: 5,    output: 25,  cache_write: 6.25,  cache_read: 0.50 },
  'claude-sonnet-5':           { input: 2,    output: 10,  cache_write: 2.50,  cache_read: 0.20 },
  'claude-sonnet-4-6':         { input: 3,    output: 15,  cache_write: 3.75,  cache_read: 0.30 },
  'claude-sonnet-4-5':         { input: 3,    output: 15,  cache_write: 3.75,  cache_read: 0.30 },
  'claude-haiku-4-5':          { input: 1,    output: 5,   cache_write: 1.25,  cache_read: 0.10 },
};

function readHistory() {
  return readJson(PRICING_FILE, { entries: [] });
}

function normalizeModelName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, '-').replace(/\./g, '-');
}

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.get(parsed, { headers: { 'User-Agent': 'ClaudeManager/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, parsed).href;
        res.resume();
        return fetchPage(next).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Matches a tiered-pricing qualifier the pricing page appends after a model name via <br/>,
// e.g. "Claude Sonnet 5" + "through August 31, 2026" / "starting September 1, 2026".
const PRICING_TIER_QUALIFIER = /\s+(?:through|starting)\s+[A-Za-z]+\s+\d{1,2},?\s*\d{4}\b.*$/i;

function cellText(html) {
  // Tags like <br/> separate distinct text (e.g. a model name and a pricing-tier date
  // qualifier) — replace with a space before stripping tags so they don't get glued together.
  return html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// The name cell also contains a tagline in a sibling element with no separator before it
// (e.g. "Claude Sonnet 5" + "The best combination of speed and intelligence"), so the model
// name itself is extracted from its link text rather than the full cell text.
function extractModelName(html) {
  const anchorMatch = html.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
  const raw = anchorMatch ? anchorMatch[1] : html;
  return cellText(raw).replace(/\(deprecated\)/gi, '').replace(PRICING_TIER_QUALIFIER, '').trim();
}

function findColumn(headers, pattern) {
  return headers.findIndex(h => pattern.test(h));
}

function parseCells(rowHtml) {
  const cellPattern = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  const cells = [];
  let cellMatch;
  while ((cellMatch = cellPattern.exec(rowHtml)) !== null) cells.push(cellMatch[1]);
  return cells;
}

function parsePricingFromHtml(html) {
  const models = {};
  const tablePattern = /<table[\s\S]*?<\/table>/gi;
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const parsePrice = str => { const m = cellText(str).match(/([\d.]+)/); return m ? parseFloat(m[1]) : NaN; };

  let tableMatch;
  while ((tableMatch = tablePattern.exec(html)) !== null) {
    const tableHtml = tableMatch[0];

    // Column order isn't fixed across page revisions, so map columns by header text
    // (e.g. "Model | Input | Output | 5m writes | 1h writes | Hits and refreshes") instead
    // of by position. A table without both an Input and an Output header isn't a per-token
    // model pricing table (e.g. batch-token or tool-use-overhead tables also list models).
    //
    // <thead> can hold more than one header row (an outer grouping row with colSpan cells
    // above an inner row of the actual per-column labels); only the row with the most cells
    // lines up 1:1 with each data row's <td>s, so that's the one used for column lookup.
    const theadMatch = tableHtml.match(/<thead[\s\S]*?<\/thead>/i);
    const headerSource = theadMatch ? theadMatch[0] : tableHtml;
    const headerRows = [...headerSource.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(r => parseCells(r[1]).map(cellText));
    if (!headerRows.length) continue;
    const headers = headerRows.reduce((a, b) => (b.length > a.length ? b : a));
    const inputIdx = findColumn(headers, /^input$/i);
    const outputIdx = findColumn(headers, /^output$/i);
    if (inputIdx === -1 || outputIdx === -1) continue;
    const cacheWriteIdx = findColumn(headers, /5m/i);
    const cacheReadIdx = findColumn(headers, /hit|refresh/i);

    rowPattern.lastIndex = 0;
    let rowMatch;
    while ((rowMatch = rowPattern.exec(tableHtml)) !== null) {
      const cells = parseCells(rowMatch[1]);
      if (cells.length <= Math.max(inputIdx, outputIdx)) continue;
      if (!/Claude\s/i.test(cellText(cells[0]))) continue;

      const name = extractModelName(cells[0]);
      const input = parsePrice(cells[inputIdx]);
      const output = parsePrice(cells[outputIdx]);
      const cacheWrite = (cacheWriteIdx >= 0 && cacheWriteIdx < cells.length) ? parsePrice(cells[cacheWriteIdx]) : NaN;
      const cacheRead = (cacheReadIdx >= 0 && cacheReadIdx < cells.length) ? parsePrice(cells[cacheReadIdx]) : NaN;

      const key = normalizeModelName(name);
      // A model can appear in multiple rows when it has dated pricing tiers (e.g. an
      // introductory rate followed by a standard rate starting on a later date), or in
      // more than one table (e.g. both the standard and batch-token tables). The first
      // row encountered is the currently-applicable tier, so don't let a later row for
      // the same model silently overwrite it.
      if (!isNaN(input) && !isNaN(output) && !(key in models)) {
        models[key] = {
          input,
          output,
          cache_write: isNaN(cacheWrite) ? input * 1.25 : cacheWrite,
          cache_read: isNaN(cacheRead) ? input * 0.1 : cacheRead
        };
      }
    }
  }

  return models;
}

function pricingEqual(a, b) {
  if (!a || !b) return false;
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    if (keysA[i] !== keysB[i]) return false;
    const ra = a[keysA[i]], rb = b[keysB[i]];
    if (ra.input !== rb.input || ra.output !== rb.output ||
        ra.cache_write !== rb.cache_write || ra.cache_read !== rb.cache_read) return false;
  }
  return true;
}

async function fetchAndUpdate() {
  const url = getFetchUrl();
  const html = await fetchPage(url);
  const models = parsePricingFromHtml(html);
  if (Object.keys(models).length === 0) {
    throw new Error('No pricing data found on page');
  }
  const history = readHistory();
  const last = history.entries.length ? history.entries[history.entries.length - 1].models : null;
  const changed = !pricingEqual(last, models);
  if (changed) {
    history.entries.push({ fetchedAt: new Date().toISOString(), models });
    writeDataJson(PRICING_FILE, history);
  }
  return { models, changed };
}

function getPricingForDate(dateStr) {
  const history = readHistory();
  if (!history.entries.length) return FALLBACK_PRICING;

  if (!dateStr) return history.entries[history.entries.length - 1].models;

  // Find latest entry fetched before or on the given date
  let best = null;
  for (const entry of history.entries) {
    if (entry.fetchedAt <= dateStr) best = entry;
  }
  return best ? best.models : history.entries[0].models;
}

function getCurrentPricing() {
  const history = readHistory();
  if (!history.entries.length) return FALLBACK_PRICING;
  return history.entries[history.entries.length - 1].models;
}

function resolveModelPrice(modelId, pricingMap) {
  if (!modelId) return null;
  if (pricingMap[modelId]) return pricingMap[modelId];

  // Strip a trailing variant annotation: "claude-opus-5[1m]" -> "claude-opus-5"
  const noVariant = modelId.replace(/\[[^\]]*\]$/, '');
  if (pricingMap[noVariant]) return pricingMap[noVariant];

  // Strip date suffix: "claude-haiku-4-5-20251001" -> "claude-haiku-4-5"
  const noDate = noVariant.replace(/-\d{8,}$/, '');
  if (pricingMap[noDate]) return pricingMap[noDate];

  // Longest prefix match
  let best = null, bestLen = 0;
  for (const key of Object.keys(pricingMap)) {
    if (noDate.startsWith(key) && key.length > bestLen) {
      best = key; bestLen = key.length;
    }
  }
  return best ? pricingMap[best] : null;
}

function getLastFetchedAt() {
  const history = readHistory();
  if (!history.entries.length) return null;
  return history.entries[history.entries.length - 1].fetchedAt;
}

function saveManualEntry(models, fetchedAt) {
  const history = readHistory();
  history.entries.push({ fetchedAt: fetchedAt || new Date().toISOString(), source: 'manual', models });
  writeDataJson(PRICING_FILE, history);
}

function updateEntry(index, models, fetchedAt) {
  const history = readHistory();
  if (index < 0 || index >= history.entries.length) throw new Error('Invalid history index');
  history.entries[index].models = models;
  if (fetchedAt) history.entries[index].fetchedAt = fetchedAt;
  history.entries[index].source = 'manual';
  history.entries.sort((a, b) => new Date(a.fetchedAt) - new Date(b.fetchedAt));
  writeDataJson(PRICING_FILE, history);
}

function getFetchUrl() {
  const history = readHistory();
  return history.fetchUrl || PRICING_URL;
}

function setFetchUrl(url) {
  if (!url || typeof url !== 'string') throw new Error('Invalid URL');
  const history = readHistory();
  history.fetchUrl = url;
  writeDataJson(PRICING_FILE, history);
}

module.exports = {
  FALLBACK_PRICING, PRICING_URL,
  fetchAndUpdate, getCurrentPricing, getPricingForDate,
  resolveModelPrice, getLastFetchedAt, readHistory, parsePricingFromHtml,
  saveManualEntry, updateEntry, getFetchUrl, setFetchUrl
};
