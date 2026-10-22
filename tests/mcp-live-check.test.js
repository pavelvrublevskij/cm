const { test, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app } = require('./helpers/app');
const mcpLive = require('../lib/mcp-live-check');

const realRun = mcpLive.runMcpList;
after(() => { mcpLive.runMcpList = realRun; });

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEF';
const SAMPLE = [
  'Checking MCP server health…',
  '[mcp-sdk] SEP-2352: stored OAuth credential has no \'issuer\' stamp',
  'claude.ai Claude Docs: https://docs.example/mcp - ✔ Connected',
  'claude.ai Linear: https://mcp.linear.app/mcp - ! Needs authentication',
  'claude.ai Atlassian: https://mcp.atlassian.com/v1/mcp - ! Connected · tools fetch failed — Request timed out',
  `atlassian: npx -y mcp-remote https://x.example --header Authorization:Bearer ${TOKEN} - ✘ Failed to connect — CONNECTION_CLOSED: Connection closed`,
  'context7: https://mcp.context7.com/mcp (HTTP) - ! Needs authentication',
  ''
].join('\r\n');

test('parseMcpList keeps name and status only, with a level per server', () => {
  const servers = mcpLive.parseMcpList(SAMPLE);
  assert.deepStrictEqual(servers.map(s => [s.name, s.level]), [
    ['claude.ai Claude Docs', 'ok'],
    ['claude.ai Linear', 'warn'],
    ['claude.ai Atlassian', 'warn'],
    ['atlassian', 'error'],
    ['context7', 'warn']
  ]);
  assert.strictEqual(servers[3].status, 'Failed to connect — CONNECTION_CLOSED: Connection closed');
  assert.strictEqual(servers[1].status, 'Needs authentication');
  assert.ok(!JSON.stringify(servers).includes(TOKEN), 'commands and their tokens are dropped');
  assert.ok(!JSON.stringify(servers).includes('mcp-remote'));
});

test('maskSecrets hides token-like strings in a status', () => {
  assert.strictEqual(mcpLive.maskSecrets('bad key ' + TOKEN), 'bad key …');
});

test('liveFindings turns failed servers into errors and auth problems into warnings', () => {
  const f = mcpLive.liveFindings(mcpLive.parseMcpList(SAMPLE));
  assert.strictEqual(f.length, 4);
  const failed = f.find(x => x.title.includes('"atlassian"'));
  assert.strictEqual(failed.severity, 'error');
  assert.match(failed.title, /failed to connect/);
  assert.strictEqual(failed.scope, 'Global');
  const linear = f.find(x => x.title.includes('claude.ai Linear'));
  assert.strictEqual(linear.severity, 'warn');
  assert.strictEqual(linear.scope, 'claude.ai');
  assert.ok(f.every(x => x.area === 'mcp' && x.live));
});

test('POST /api/health/mcp-live returns live servers and findings', async () => {
  mcpLive.runMcpList = async () => SAMPLE;
  const res = await request(app).post('/api/health/mcp-live');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.servers.length, 5);
  assert.strictEqual(res.body.findings.length, 4);
  assert.ok(res.body.checkedAt);
});

test('POST /api/health/mcp-live reports a failure of claude itself', async () => {
  mcpLive.runMcpList = async () => { throw new Error("'claude' is not recognized"); };
  const res = await request(app).post('/api/health/mcp-live');
  assert.strictEqual(res.status, 500);
  assert.match(res.body.error, /not recognized/);
});
