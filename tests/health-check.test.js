const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { app, HOME, paths } = require('./helpers/app');
const { commandExists, CLAUDE_MD_MAX_CHARS, MEMORY_INDEX_MAX_LINES } = require('../lib/health-check');

function slugForPath(p) {
  const win = p.match(/^([A-Za-z]):[\\\/](.*)/);
  if (win) return `${win[1].toUpperCase()}--${win[2].replace(/[\\\/\.]/g, '-')}`;
  return p.replace(/^\//, '').replace(/[\/\.]/g, '-');
}

const PROJ = path.join(HOME, 'healthproj');
const SLUG = slugForPath(PROJ);
const SECRET = 'sk-super-secret-value';

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function skill(dir, name, frontmatter) {
  write(path.join(dir, name, 'SKILL.md'), frontmatter === null ? 'no frontmatter\n' : `---\n${frontmatter}\n---\nBody\n`);
}

before(() => {
  write(path.join(paths.CLAUDE_DIR, 'settings.local.json'), '{ "permissions": { "allow": [ } }');
  write(path.join(PROJ, '.claude', 'settings.json'), '{"ok": true}');
  fs.mkdirSync(path.join(paths.PROJECTS_DIR, SLUG), { recursive: true });

  write(path.join(PROJ, '.mcp.json'), JSON.stringify({ mcpServers: {
    missing: { command: 'definitely-not-a-real-command-xyz', args: ['--token', SECRET], env: { API_KEY: SECRET } },
    present: { command: process.execPath },
    badurl: { type: 'http', url: 'not a url' },
    templated: { command: '${MY_TOOL}' },
    nocmd: { type: 'stdio' }
  } }));

  const skills = path.join(PROJ, '.claude', 'skills');
  fs.mkdirSync(path.join(skills, 'no-skill-file'), { recursive: true });
  skill(skills, 'no-desc', 'name: no-desc');
  skill(skills, 'short-desc', 'name: short-desc\ndescription: Does stuff');
  skill(skills, 'long-desc', 'name: long-desc\ndescription: ' + 'x'.repeat(1100));
  skill(skills, 'good-skill', 'name: good-skill\ndescription: Formats SQL queries consistently; use when the user asks to tidy or format SQL.');
  skill(skills, 'Bad Name', 'name: Bad Name\ndescription: Formats SQL queries consistently; use when the user asks to tidy SQL.');
  fs.mkdirSync(path.join(skills, '.trash'), { recursive: true });
  fs.mkdirSync(path.join(paths.SKILLS_DIR, 'synced', 'abc'), { recursive: true });

  write(path.join(PROJ, 'CLAUDE.md'), 'a'.repeat(CLAUDE_MD_MAX_CHARS + 10));
  write(path.join(PROJ, 'CLAUDE.local.md'), 'small');

  const mem = path.join(paths.PROJECTS_DIR, SLUG, 'memory');
  write(path.join(mem, 'MEMORY.md'), '- [A](a.md) — a\n- [Gone](gone.md) — removed\n- [B](b.md) — b\n');
  write(path.join(mem, 'a.md'), '---\nname: alpha\n---\nSame text here.\n');
  write(path.join(mem, 'b.md'), '---\nname: beta\n---\nSame   text here.\n');
  write(path.join(mem, 'orphan.md'), '---\nname: orphan\n---\nNot in the index.\n');
});

let data;
async function result() {
  if (!data) {
    const res = await request(app).get('/api/health');
    assert.strictEqual(res.status, 200);
    data = res.body;
  }
  return data;
}

function find(area, re, scope) {
  return data.findings.filter(f => f.area === area && re.test(f.title) && (!scope || f.scope === scope));
}

test('invalid JSON is an error; valid project settings are not reported', async () => {
  await result();
  const bad = find('json', /Invalid JSON in settings\.local\.json/, 'Global');
  assert.strictEqual(bad.length, 1);
  assert.strictEqual(bad[0].severity, 'error');
  assert.ok(!data.findings.some(f => f.area === 'json' && f.location === path.join(PROJ, '.claude', 'settings.json')));
});

test('MCP servers are checked statically and secrets are never echoed', async () => {
  await result();
  assert.strictEqual(find('mcp', /"missing" will not start/, 'healthproj').length, 1);
  assert.strictEqual(find('mcp', /"present"/).length, 0, 'a command that exists is fine');
  assert.strictEqual(find('mcp', /"badurl" has an invalid URL/).length, 1);
  assert.strictEqual(find('mcp', /"templated"/).length, 0, '${VAR} commands are not judged');
  assert.strictEqual(find('mcp', /"nocmd" has no command/).length, 1);
  assert.ok(!JSON.stringify(data).includes(SECRET), 'args and env values stay out of the report');
});

test('skills without SKILL.md or a usable description are flagged; managed folders are skipped', async () => {
  await result();
  assert.strictEqual(find('skills', /"no-skill-file" has no SKILL\.md/).length, 1);
  assert.strictEqual(find('skills', /"no-desc" has no description/)[0].severity, 'warn');
  assert.strictEqual(find('skills', /"short-desc" has a very short description/)[0].severity, 'info');
  assert.strictEqual(find('skills', /"long-desc" description is too long/).length, 1);
  assert.strictEqual(find('skills', /"Bad Name" has an unusual name/).length, 1);
  assert.strictEqual(find('skills', /good-skill/).length, 0);
  assert.strictEqual(find('skills', /\.trash|synced/).length, 0);
});

test('an oversized CLAUDE.md is a warning; small ones are fine', async () => {
  await result();
  const big = find('claude-md', /CLAUDE\.md is large/, 'healthproj');
  assert.strictEqual(big.length, 1);
  assert.strictEqual(big[0].location, path.join(PROJ, 'CLAUDE.md'));
  assert.strictEqual(big[0].slug, SLUG);
  assert.strictEqual(find('claude-md', /CLAUDE\.local\.md/).length, 0);
});

test('memories: stale index entries, unindexed files and duplicates', async () => {
  await result();
  const stale = find('memory', /points to a missing memory/);
  assert.strictEqual(stale.length, 1);
  assert.match(stale[0].detail, /gone\.md/);
  const orphan = find('memory', /"orphan\.md" is not in MEMORY\.md/);
  assert.strictEqual(orphan.length, 1);
  assert.strictEqual(orphan[0].severity, 'info');
  const dup = find('memory', /Duplicate memories/);
  assert.strictEqual(dup.length, 1);
  assert.match(dup[0].detail, /a\.md, b\.md/);
});

test('a too-long MEMORY.md is flagged', () => {
  const dir = path.join(paths.PROJECTS_DIR, SLUG, 'memory');
  const original = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf-8');
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), original + '\n'.repeat(MEMORY_INDEX_MAX_LINES + 5));
  const { runHealthCheck } = require('../lib/health-check');
  const r = runHealthCheck();
  assert.ok(r.findings.some(f => f.area === 'memory' && /MEMORY\.md is too long/.test(f.title)));
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), original);
});

test('results are sorted errors first and counted', async () => {
  await result();
  const order = { error: 0, warn: 1, info: 2 };
  const ranks = data.findings.map(f => order[f.severity]);
  assert.deepStrictEqual(ranks, [...ranks].sort((a, b) => a - b));
  const counts = { error: 0, warn: 0, info: 0 };
  data.findings.forEach(f => counts[f.severity]++);
  assert.deepStrictEqual(data.counts, counts);
  assert.ok(data.projectCount >= 1);
});

test('commandExists finds commands on PATH, by path, and not otherwise', () => {
  const dir = path.dirname(process.execPath);
  const name = path.basename(process.execPath).replace(/\.exe$/i, '');
  assert.strictEqual(commandExists(name, { PATH: dir, PATHEXT: '.EXE' }), true);
  assert.strictEqual(commandExists(process.execPath, {}), true);
  assert.strictEqual(commandExists('definitely-not-a-real-command-xyz', { PATH: dir }), false);
  assert.strictEqual(commandExists('', { PATH: dir }), false);
});
