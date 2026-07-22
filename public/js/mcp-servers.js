// --- MCP Servers ---

const McpServers = {
  data: { servers: {} },
  cloudIntegrations: [],

  async load() {
    showLoading('mcp-servers-list');
    try {
      const [mcp, cloud] = await Promise.all([
        api('/api/mcp/global'),
        api('/api/mcp/cloud')
      ]);
      McpServers.data = mcp;
      McpServers.cloudIntegrations = cloud;
      McpServers.render();
    } catch (e) {
      toast('Could not load MCP config: ' + e.message, 'error');
    }
  },

  render() {
    const container = document.getElementById('mcp-servers-list');
    const servers = McpServers.data.servers || {};
    const names = Object.keys(servers);
    let html = '';

    // Info note
    html += `<div class="info-note">
      <strong>User-scope MCP Servers</strong> are available to you across all projects on this machine.
      They are stored in <code>~/.claude.json</code> under <code>mcpServers</code> (equivalent to <code>claude mcp add --scope user</code>).
      Supports <code>stdio</code>, <code>sse</code>, and <code>http</code> transport types.
    </div>`;

    // Cloud integrations
    html += '<h3 style="margin:16px 0 8px">Cloud-Managed Integrations</h3>';
    html += `<div class="info-note" style="margin-bottom:8px">
      These are managed by Anthropic via <code>claude.ai</code>. They use OAuth and cannot be edited locally.
      To add or remove cloud integrations, use <code>/mcp</code> in Claude Code or visit
      <a href="https://claude.ai/settings/connectors" target="_blank" rel="noopener">claude.ai settings &rarr; Connectors</a>.
      <br><br>
      <strong>Note:</strong> CM reads only local files, so the full list and live status
      (connected / needs auth / failed) are only available inside Claude Code's <code>/mcp</code> dialog,
      which fetches them from claude.ai. Below are the integrations we can detect on disk:
      <ul style="margin:6px 0 0 16px;padding:0">
        <li><code>authenticated</code> &mdash; OAuth token cached in <code>~/.claude/.credentials.json</code></li>
        <li><code>history</code> &mdash; name seen in <code>~/.claude.json</code> &rarr; <code>claudeAiMcpEverConnected</code>, no local token</li>
      </ul>
    </div>`;
    if (McpServers.cloudIntegrations.length === 0) {
      html += '<p style="color:var(--text-muted);margin-bottom:12px">No cloud integrations detected on disk</p>';
    } else {
      html += McpServers.cloudIntegrations.map(c => {
        const sourceLabel = c.source === 'history' ? 'history' : 'authenticated';
        const sourceStyle = c.source === 'history' ? 'color:var(--text-muted)' : 'color:var(--accent)';
        return `<div class="card" style="margin-bottom:6px">
          <div style="display:flex;align-items:center;gap:8px">
            <strong style="color:var(--accent);text-transform:capitalize">${escapeHtml(c.provider)}</strong>
            <span class="prop-type">cloud</span>
            <span class="prop-type" style="${sourceStyle}">${escapeHtml(sourceLabel)}</span>
            ${c.id ? `<span style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono)">${escapeHtml(c.id)}</span>` : ''}
          </div>
        </div>`;
      }).join('');
    }

    // User-scope servers
    html += '<h3 style="margin:20px 0 8px">User-Scope Servers</h3>';
    html += `<details class="info-note" style="margin-bottom:8px">
      <summary style="cursor:pointer;font-weight:600">What are these fields? How do I manage a server?</summary>
      <div style="margin-top:8px">
        <p>Each card represents one MCP server that Claude Code launches when a session starts. The fields describe <em>how</em> it's launched.</p>
        <p><strong>For <code>stdio</code> servers</strong> (the most common) Claude Code spawns a local process and talks to it over stdin/stdout:</p>
        <ul style="margin:4px 0 8px 16px;padding:0">
          <li><strong>Command</strong> — the executable to run (e.g. <code>npx</code>, <code>node</code>, <code>docker</code>, an absolute path to a binary).</li>
          <li><strong>Args</strong> — a JSON array of CLI arguments passed to that executable. Example: <code>["-y","@some/mcp-package"]</code>.</li>
          <li><strong>Env</strong> — a JSON object of environment variables injected into the spawned process. Typical home for API tokens: <code>{"JIRA_API_TOKEN":"..."}</code>.</li>
        </ul>
        <p><strong>For <code>sse</code> / <code>http</code> servers</strong> Claude Code just makes HTTP requests — there's no Command/Args/Env, only a <strong>URL</strong>.</p>
        <p><strong>Buttons:</strong></p>
        <ul style="margin:4px 0 8px 16px;padding:0">
          <li><strong>Disable</strong> — adds <code>"disabled": true</code> to the entry. <em>Note:</em> stock Claude Code does not officially honor this flag; treat it as a bookkeeping marker rather than a guaranteed off-switch.</li>
          <li><strong>Delete</strong> — removes the entry from <code>~/.claude.json</code>. Equivalent to <code>claude mcp remove &lt;name&gt; --scope user</code>.</li>
          <li><strong>Save</strong> (page footer) — persists your edits to <code>Command</code> / <code>Args</code> / <code>Env</code> / <code>URL</code>. A backup of the whole <code>~/.claude.json</code> is written to <code>~/.claude/backups/</code> first.</li>
        </ul>
        <p><strong>Adding a new server</strong> — click <em>+ Add Server</em>. You need the name (free-form), the transport type (<code>stdio</code>/<code>sse</code>/<code>http</code>), and the command or URL. Edit Args/Env afterwards by typing directly into the fields and pressing <em>Save</em>.</p>
        <p style="color:var(--text-muted);margin-top:8px">Equivalent CLI: <code>claude mcp add --scope user my-server npx -y @my/mcp-package</code></p>
      </div>
    </details>`;

    if (names.length === 0) {
      html += '<p style="color:var(--text-muted);margin-bottom:12px">No user-scope MCP servers configured</p>';
      container.innerHTML = html;
      return;
    }

    html += names.map(name => {
      const s = servers[name];
      return `
        <div class="card" style="margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:start">
            <div style="flex:1">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
                <strong style="font-family:var(--font-mono);color:var(--accent)">${escapeHtml(name)}</strong>
                <span class="prop-type">${escapeHtml(s.type || 'stdio')}</span>
                ${s.disabled ? '<span class="prop-type" style="color:var(--danger)">disabled</span>' : ''}
              </div>
              ${s.command ? `<div class="form-group"><label>Command</label><input type="text" value="${escapeHtml(s.command)}" onchange="McpServers.update('${escapeHtml(name)}','command',this.value)"></div>` : ''}
              ${s.url ? `<div class="form-group"><label>URL</label><input type="text" value="${escapeHtml(s.url)}" onchange="McpServers.update('${escapeHtml(name)}','url',this.value)"></div>` : ''}
              ${s.args ? `<div class="form-group"><label>Args</label><input type="text" value="${escapeHtml(JSON.stringify(s.args))}" onchange="McpServers.updateArgs('${escapeHtml(name)}',this.value)"></div>` : ''}
              ${s.env ? `<div class="form-group"><label>Env</label><textarea rows="2" style="font-family:var(--font-mono);font-size:12px" onchange="McpServers.updateEnv('${escapeHtml(name)}',this.value)">${escapeHtml(JSON.stringify(s.env, null, 2))}</textarea></div>` : ''}
            </div>
            <div class="btn-group" style="margin-left:12px">
              <button class="btn btn-sm" onclick="McpServers.toggle('${escapeHtml(name)}')">${s.disabled ? 'Enable' : 'Disable'}</button>
              <button class="btn btn-sm btn-danger" onclick="McpServers.remove('${escapeHtml(name)}')">Delete</button>
            </div>
          </div>
        </div>
      `;
    }).join('');
    container.innerHTML = html;
  },

  update(name, field, value) {
    McpServers.data.servers[name][field] = value;
  },

  updateArgs(name, value) {
    try { McpServers.data.servers[name].args = JSON.parse(value); } catch (_) { toast('Invalid JSON array', 'error'); }
  },

  updateEnv(name, value) {
    try { McpServers.data.servers[name].env = JSON.parse(value); } catch (_) { toast('Invalid JSON', 'error'); }
  },

  toggle(name) {
    const s = McpServers.data.servers[name];
    s.disabled = !s.disabled;
    McpServers.render();
  },

  remove(name) {
    delete McpServers.data.servers[name];
    McpServers.render();
  },

  addServer() {
    openModal({
      title: 'Add MCP Server',
      body: formGroup('Name', '<input type="text" id="mcp-new-name" placeholder="my-server">')
        + formGroup('Type', selectHtml('mcp-new-type', MCP_TYPES, 'stdio'))
        + formGroup('Command / URL', '<input type="text" id="mcp-new-cmd" placeholder="/path/to/server or http://...">'),
      buttons: [{
        label: 'Add', primary: true, onClick: () => {
          const name = document.getElementById('mcp-new-name').value.trim();
          const type = document.getElementById('mcp-new-type').value;
          const cmd = document.getElementById('mcp-new-cmd').value.trim();
          if (!name) { toast('Name required', 'error'); return false; }
          if (!McpServers.data.servers) McpServers.data.servers = {};
          const server = { type };
          if (type === 'stdio') { server.command = cmd; server.args = []; }
          else { server.url = cmd; }
          McpServers.data.servers[name] = server;
          McpServers.render();
        }
      }]
    });
  },

  async save() {
    try {
      await api('/api/mcp/global', { method: 'PUT', body: McpServers.data });
      toast('MCP servers saved');
    } catch (e) { toast('Save failed: ' + e.message, 'error'); }
  }
};
