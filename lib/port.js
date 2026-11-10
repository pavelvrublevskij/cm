const { readJson, writeDataJson } = require('./file-helpers');
const { APP_CONFIG_FILE } = require('./paths');

const DEFAULT_PORT = 3000;

/** PORT env var wins, then the port last chosen in run.sh / run.bat (data/app-config.json), then 3000. */
function getPort() {
  return parseInt(process.env.PORT, 10) || parseInt(readJson(APP_CONFIG_FILE, {}).port, 10) || DEFAULT_PORT;
}

function savePort(port) {
  const config = readJson(APP_CONFIG_FILE, {});
  config.port = parseInt(port, 10);
  writeDataJson(APP_CONFIG_FILE, config);
}

module.exports = { DEFAULT_PORT, getPort, savePort };
