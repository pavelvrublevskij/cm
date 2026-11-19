// Runs the CodeQL security scan locally (same config as the CodeQL workflow) and exits 1 on findings.
// Uses CODEQL_PATH, else the bundle extracted into .codeql/codeql, else `codeql` on PATH.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WORK = path.join(ROOT, '.codeql');
const DB = path.join(WORK, 'db');
const SARIF = path.join(WORK, 'results.sarif');
const CONFIG = path.join(ROOT, '.github', 'codeql', 'codeql-config.yml');

function findCodeql() {
  if (process.env.CODEQL_PATH) return process.env.CODEQL_PATH;
  const local = path.join(WORK, 'codeql', process.platform === 'win32' ? 'codeql.exe' : 'codeql');
  return fs.existsSync(local) ? local : 'codeql';
}

function run(codeql, args) {
  const r = spawnSync(codeql, args, { cwd: ROOT, stdio: 'inherit' });
  if (r.error) {
    console.error(`Cannot run CodeQL (${r.error.message}). See "CodeQL" in README.md.`);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status);
}

const codeql = findCodeql();
run(codeql, ['database', 'create', DB, '--language=javascript', '--source-root', ROOT,
  '--codescanning-config', CONFIG, '--overwrite']);
run(codeql, ['database', 'analyze', DB, 'codeql/javascript-queries:codeql-suites/javascript-code-scanning.qls',
  '--format=sarif-latest', '--output', SARIF, '--download']);

const results = JSON.parse(fs.readFileSync(SARIF, 'utf8')).runs.flatMap(r => r.results || []);
for (const r of results) {
  const loc = r.locations[0].physicalLocation;
  console.log(`${loc.artifactLocation.uri}:${loc.region.startLine}  [${r.ruleId}] ${r.message.text.split('\n')[0]}`);
}
console.log(`CodeQL: ${results.length} finding(s).`);
process.exit(results.length > 0 ? 1 : 0);
