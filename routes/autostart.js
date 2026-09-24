const express = require('express');
const { wrapRoute, readJson, writeDataJson } = require('../lib/file-helpers');
const { APP_CONFIG_FILE } = require('../lib/paths');
const autostart = require('../lib/autostart');

const router = express.Router();

router.get('/', wrapRoute((req, res) => {
  const config = readJson(APP_CONFIG_FILE, {});
  const supported = autostart.isSupported();
  res.json({
    supported,
    enabled: supported ? autostart.isEnabled() : false,
    prompted: !!config.autostartPrompted
  });
}));

router.post('/enable', wrapRoute((req, res) => {
  if (!autostart.isSupported()) return res.status(400).json({ error: 'Autostart is not supported on this platform' });
  autostart.enable();
  res.json({ enabled: true });
}));

router.post('/disable', wrapRoute((req, res) => {
  if (autostart.isSupported()) autostart.disable();
  res.json({ enabled: false });
}));

router.post('/dismiss', wrapRoute((req, res) => {
  const config = readJson(APP_CONFIG_FILE, {});
  config.autostartPrompted = true;
  writeDataJson(APP_CONFIG_FILE, config);
  res.json({ ok: true });
}));

module.exports = router;
