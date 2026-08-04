const express = require('express');
const path = require('path');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Version endpoint with remote update check
const { version } = require('./package.json');
const https = require('https');

let latestVersionCache = { version: null, checkedAt: 0 };
const UPDATE_CHECK_INTERVAL = 60 * 60 * 1000; // 1 hour
const REMOTE_PACKAGE_URL = 'https://raw.githubusercontent.com/pavelvrublevskij/cm/main/package.json';

function checkLatestVersion() {
  return new Promise(resolve => {
    const now = Date.now();
    if (latestVersionCache.version && now - latestVersionCache.checkedAt < UPDATE_CHECK_INTERVAL) {
      return resolve(latestVersionCache.version);
    }
    https.get(REMOTE_PACKAGE_URL, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const remote = JSON.parse(data);
          latestVersionCache = { version: remote.version, checkedAt: now };
          resolve(remote.version);
        } catch (_) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

function isNewer(remote, local) {
  const r = remote.split('.').map(Number);
  const l = local.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] || 0) > (l[i] || 0)) return true;
    if ((r[i] || 0) < (l[i] || 0)) return false;
  }
  return false;
}

app.get('/api/version', async (req, res) => {
  const latest = await checkLatestVersion();
  const updateAvailable = latest && latest !== version && isNewer(latest, version);
  res.json({ version, latest, updateAvailable });
});

const fs = require('fs');
app.get('/api/changelog', (req, res) => {
  const file = path.join(__dirname, 'CHANGELOG.md');
  if (!fs.existsSync(file)) return res.json({ content: 'No changelog found.' });
  res.json({ content: fs.readFileSync(file, 'utf-8') });
});

// Auto-update via release zip
const { exec, spawn } = require('child_process');
const os = require('os');
const AdmZip = require('adm-zip');

async function fetchReleaseInfo() {
  try {
    const r = await fetch('https://api.github.com/repos/pavelvrublevskij/cm/releases/latest', {
      headers: { 'User-Agent': 'cm' }
    });
    if (r.ok) {
      const data = await r.json();
      if (data.zipball_url) {
        return { zipUrl: data.zipball_url, latestVersion: data.tag_name?.replace(/^v/, '') };
      }
    }
  } catch (_) {}
  return { zipUrl: 'https://github.com/pavelvrublevskij/cm/archive/refs/heads/main.zip', latestVersion: null };
}

function copyDirSync(src, dest) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

app.post('/api/update/zip', async (req, res) => {
  try {
    const { zipUrl, latestVersion } = await fetchReleaseInfo();
    if (latestVersion && !isNewer(latestVersion, version)) {
      return res.status(400).json({ error: 'Already on the latest version' });
    }
    const r = await fetch(zipUrl, { headers: { 'User-Agent': 'cm' }, redirect: 'follow' });
    if (!r.ok) throw new Error(`Download failed: HTTP ${r.status}`);
    const zipBuffer = Buffer.from(await r.arrayBuffer());

    const zip = new AdmZip(zipBuffer);
    const tmpDir = path.join(os.tmpdir(), 'cm-update-' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    zip.extractAllTo(tmpDir, true);

    const entries = fs.readdirSync(tmpDir);
    const srcDir = entries.length === 1 ? path.join(tmpDir, entries[0]) : tmpDir;
    copyDirSync(srcDir, __dirname);
    fs.rmSync(tmpDir, { recursive: true, force: true });

    await new Promise((resolve, reject) => {
      exec('npm install', { cwd: __dirname }, (err) => err ? reject(err) : resolve());
    });

    res.json({ ok: true });

    setTimeout(() => {
      const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
        detached: true,
        stdio: 'ignore',
        cwd: __dirname,
        env: { ...process.env, RESTART_DELAY_MS: '800' }
      });
      child.unref();
      process.exit(0);
    }, 200);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pricing endpoints
const pricing = require('./lib/pricing');

app.get('/api/pricing', (req, res) => {
  const history = pricing.readHistory();
  res.json({
    current: pricing.getCurrentPricing(),
    lastFetched: pricing.getLastFetchedAt(),
    source: pricing.PRICING_URL,
    historyCount: history.entries.length
  });
});

app.get('/api/pricing/history', (req, res) => {
  const history = pricing.readHistory();
  res.json(history.entries || []);
});

app.post('/api/pricing/fetch', async (req, res) => {
  try {
    const { models, changed } = await pricing.fetchAndUpdate();
    res.json({ ok: true, changed, models });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/pricing/manual', (req, res) => {
  try {
    const models = req.body.models;
    if (!models || typeof models !== 'object' || !Object.keys(models).length) {
      return res.status(400).json({ error: 'No pricing data provided' });
    }
    pricing.saveManualEntry(models, req.body.fetchedAt);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/pricing/history/:index', (req, res) => {
  try {
    const index = parseInt(req.params.index);
    const models = req.body.models;
    if (!models || typeof models !== 'object' || !Object.keys(models).length) {
      return res.status(400).json({ error: 'No pricing data provided' });
    }
    pricing.updateEntry(index, models, req.body.fetchedAt);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/pricing/config', (req, res) => {
  res.json({ url: pricing.getFetchUrl() });
});

app.put('/api/pricing/config', (req, res) => {
  try {
    pricing.setFetchUrl(req.body.url);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mount API routes
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/projects', require('./routes/sessions'));
app.use('/api/projects', require('./routes/terminal'));
app.use('/api/projects', require('./routes/memory'));
app.use('/api/claude-md', require('./routes/claude-md'));
app.use('/api/mcp', require('./routes/mcp'));
app.use('/api/keybindings', require('./routes/keybindings'));
app.use('/api/skills', require('./routes/skills'));
app.use('/api/agents', require('./routes/agents'));
app.use('/api/output-styles', require('./routes/output-styles'));
app.use('/api/plugins', require('./routes/plugins'));
app.use('/api/project-settings', require('./routes/project-settings'));
app.use('/api/usage', require('./routes/usage'));
app.use('/api/plans', require('./routes/plans'));
app.use('/api/file-history', require('./routes/file-history'));
app.use('/api/projects', require('./routes/git'));
app.use('/api/projects', require('./routes/scratchpad'));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  const http = require('http');
  const terminalServer = require('./lib/terminal-server');

  // Safety net: keep the server alive on otherwise-uncaught failures.
  // Root causes are still visible in the log; we don't exit.
  process.on('uncaughtException', err => console.error('[uncaughtException]', err));
  process.on('unhandledRejection', reason => console.error('[unhandledRejection]', reason));

  const startupDelay = parseInt(process.env.RESTART_DELAY_MS, 10) || 0;

  const startServer = () => {
  const server = http.createServer(app);
  server.on('upgrade', (req, socket, head) => {
    if (!terminalServer.handleUpgrade(req, socket, head)) socket.destroy();
  });
  server.listen(PORT, HOST, () => {
    console.log(`CM running at http://${HOST}:${PORT}`);

    // Auto-fetch pricing on startup if stale (>24h) or missing
    const lastFetch = pricing.getLastFetchedAt();
    const stale = !lastFetch || (Date.now() - new Date(lastFetch).getTime()) > 24 * 60 * 60 * 1000;
    if (stale) {
      pricing.fetchAndUpdate()
        .then(({ changed }) => console.log(changed ? 'Pricing updated from Anthropic' : 'Pricing checked, no changes'))
        .catch(e => console.log('Pricing fetch skipped:', e.message));
    }
  });
  };

  if (startupDelay) setTimeout(startServer, startupDelay);
  else startServer();
}

module.exports = app;
