const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const BACKUPS_DIR = path.join(CLAUDE_DIR, 'backups');
const GLOBAL_CLAUDE_MD = path.join(CLAUDE_DIR, 'CLAUDE.md');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
const MCP_FILE = path.join(CLAUDE_DIR, '.mcp.json');
const KEYBINDINGS_FILE = path.join(CLAUDE_DIR, 'keybindings.json');
const SKILLS_DIR = path.join(CLAUDE_DIR, 'skills');
const OUTPUT_STYLES_DIR = path.join(CLAUDE_DIR, 'output-styles');
const PLUGINS_DIR = path.join(CLAUDE_DIR, 'plugins');

const DATA_DIR = process.env.CLAUDE_MANAGER_DATA_DIR
  ? path.resolve(process.env.CLAUDE_MANAGER_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const USAGE_DB = path.join(DATA_DIR, 'usage-index.json');
const APP_CONFIG_FILE = path.join(DATA_DIR, 'app-config.json');

module.exports = {
  CLAUDE_DIR, CLAUDE_JSON, PROJECTS_DIR, BACKUPS_DIR, GLOBAL_CLAUDE_MD,
  SETTINGS_FILE, MCP_FILE, KEYBINDINGS_FILE,
  SKILLS_DIR, OUTPUT_STYLES_DIR, PLUGINS_DIR,
  DATA_DIR, USAGE_DB, APP_CONFIG_FILE
};
