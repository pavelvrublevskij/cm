const SETTINGS_DEFAULTS = { outputStyle: '' };

const Settings = {
  data: {},
  showRaw: false,
  _loaded: false,

  async load() {
    showLoading('settings-visual');
    try {
      const res = await api('/api/settings');
      Settings.data = JSON.parse(res.content);
      for (const [key, val] of Object.entries(SETTINGS_DEFAULTS)) {
        if (!(key in Settings.data)) Settings.data[key] = val;
      }
      Settings._loaded = true;
      Settings.render();
      document.getElementById('settings-editor').value = JSON.stringify(Settings.data, null, 2);
    } catch (e) {
      Settings.data = {};
      Settings.render();
      toast('Could not load settings: ' + e.message, 'error');
    }
  },

  async ensureLoaded() {
    if (!Settings._loaded) await Settings.load();
  },

  renderCleanupWarning() {
    const el = document.getElementById('cleanup-warning');
    if (!el) return;
    if (Settings.data && Settings.data.cleanupPeriodDays === undefined) {
      el.style.display = '';
      el.innerHTML = '&#9888; <code>cleanupPeriodDays</code> is not set &mdash; Claude Code deletes local session transcripts after 30 days by default. Click to choose how many days to keep them.';
    } else {
      el.style.display = 'none';
    }
  },

  openCleanupPrompt() {
    openModal({
      title: 'Session Retention',
      body: '<div class="info-note" style="margin-bottom:10px">'
        + 'Claude Code automatically deletes local session transcripts (under <code>~/.claude/projects/</code>) older than <code>cleanupPeriodDays</code>, which defaults to <strong>30 days</strong> when this key is absent from settings.json. '
        + 'Once deleted, a transcript cannot be recovered. Set an explicit value here if you want to keep session history longer.'
        + '</div>'
        + formGroup('Days to keep sessions', '<input type="number" id="cleanup-days-input" min="1" value="365">'),
      buttons: [{
        label: 'Save', primary: true, onClick: async () => {
          const input = document.getElementById('cleanup-days-input');
          const days = parseInt(input.value, 10);
          if (!days || days < 1) { toast('Enter a number of days (1 or more)', 'error'); return false; }
          Settings.data.cleanupPeriodDays = days;
          document.getElementById('settings-editor').value = JSON.stringify(Settings.data, null, 2);
          await Settings.save();
          Settings.render();
          if (typeof Sessions !== 'undefined') Sessions.renderCleanupWarning();
        }
      }]
    });
  },

  async reload() {
    await Settings.load();
    toast('Settings reloaded');
  },

  async save() {
    if (Settings.showRaw) {
      const raw = document.getElementById('settings-editor').value;
      try {
        Settings.data = JSON.parse(raw);
      } catch (e) {
        toast('Invalid JSON: ' + e.message, 'error');
        return;
      }
    }
    try {
      const content = JSON.stringify(Settings.data, null, 2);
      await api('/api/settings', { method: 'PUT', body: { content } });
      toast('Settings saved');
    } catch (e) {
      toast('Save failed: ' + e.message, 'error');
    }
  },

  toggleReference() {
    const el = document.getElementById('settings-reference');
    if (el.style.display === 'none') {
      el.style.display = '';
      if (!el.innerHTML) el.innerHTML = Settings.referenceHtml();
    } else {
      el.style.display = 'none';
    }
  },

  referenceHtml() {
    const sections = [
      { title: 'General', keys: [
        ['model', 'string', 'Claude model to use: <code>default</code>, <code>sonnet</code>, <code>opus</code>, <code>haiku</code>, or a specific model ID'],
        ['fallbackModel', 'string[]', 'Models tried in order when the primary model is overloaded/unavailable'],
        ['availableModels', 'string[]', 'Restrict which models users can select'],
        ['enforceAvailableModels', 'boolean', 'Also constrain the default model selection to <code>availableModels</code>'],
        ['modelOverrides', 'object', 'Map Anthropic model IDs to Bedrock/Vertex/Foundry deployment names'],
        ['effortLevel', 'string', 'Reasoning effort: <code>"low"</code>, <code>"medium"</code>, <code>"high"</code>, <code>"xhigh"</code>'],
        ['alwaysThinkingEnabled', 'boolean', 'When false, extended thinking is disabled'],
        ['agent', 'string', 'Name of a built-in or custom agent to use for the main thread'],
        ['outputStyle', 'string', 'Output style for assistant responses'],
        ['language', 'string', 'Preferred language for responses and voice dictation'],
        ['env', 'object', 'Environment variables as key-value pairs'],
        ['includeGitInstructions', 'boolean', 'Include built-in commit/PR workflow instructions in the system prompt'],
        ['attribution', 'object', '<code>commit</code>/<code>pr</code>/<code>sessionUrl</code> — customize or hide co-authorship attribution text'],
        ['cleanupPeriodDays', 'number', 'Days to retain local chat transcripts before auto-cleanup (default 30, min 1)'],
        ['autoCompactEnabled', 'boolean', 'Automatically compact the conversation when context fills'],
        ['autoCompactWindow', 'number', 'Context size threshold that triggers auto-compact (100000–1000000)'],
      ]},
      { title: 'Permissions', keys: [
        ['permissions.defaultMode', 'string', 'Default permission mode: <code>default</code>, <code>acceptEdits</code>, <code>plan</code>, <code>auto</code>, <code>dontAsk</code>, <code>bypassPermissions</code>'],
        ['permissions.allow', 'string[]', 'Auto-approve rules, e.g. <code>"Bash(npm run build)"</code>, <code>"Read(.env)"</code>'],
        ['permissions.ask', 'string[]', 'Rules requiring user confirmation'],
        ['permissions.deny', 'string[]', 'Rules to block entirely'],
        ['permissions.additionalDirectories', 'string[]', 'Extra paths to grant file access beyond the working directory'],
        ['permissions.disableBypassPermissionsMode', 'string', 'Set <code>"disable"</code> to prevent bypass mode'],
        ['permissions.disableAutoMode', 'string', 'Set <code>"disable"</code> to prevent auto mode'],
        ['skipDangerousModePermissionPrompt', 'boolean', 'Whether the bypass-permissions opt-in dialog has already been accepted'],
        ['skipAutoPermissionPrompt', 'boolean', 'Whether the auto mode opt-in dialog has already been accepted'],
      ]},
      { title: 'Auto Mode', keys: [
        ['autoMode.environment', 'string[]', 'Descriptions of trusted infrastructure'],
        ['autoMode.allow', 'string[]', 'Natural-language allow rules (exceptions to soft_deny)'],
        ['autoMode.soft_deny', 'string[]', 'Natural-language block rules that user intent can clear'],
        ['autoMode.hard_deny', 'string[]', 'Natural-language security-boundary rules user intent cannot clear'],
        ['autoMode.classifyAllShell', 'boolean', 'Route every shell command through the classifier, ignoring existing allow rules'],
        ['useAutoModeDuringPlan', 'boolean', 'Whether plan mode uses auto-mode semantics (default true)'],
      ]},
      { title: 'Sandbox', keys: [
        ['sandbox.enabled', 'boolean', 'Enable filesystem/network sandboxing'],
        ['sandbox.failIfUnavailable', 'boolean', 'Exit at startup if sandboxing is enabled but cannot start'],
        ['sandbox.allowUnsandboxedCommands', 'boolean', 'Allow escaping the sandbox via <code>dangerouslyDisableSandbox</code> (default true)'],
        ['sandbox.filesystem.allowRead / denyRead', 'string[]', 'Paths to allow/deny reading'],
        ['sandbox.filesystem.allowWrite / denyWrite', 'string[]', 'Paths to allow/deny writing'],
        ['sandbox.network.allowedDomains / deniedDomains', 'string[]', 'Domains to allow/deny for network access'],
        ['sandbox.network.allowLocalBinding', 'boolean', 'Allow binding local ports inside the sandbox'],
        ['sandbox.credentials.files', 'object[]', '<code>{path, mode:"deny"}</code> — credential files/dirs to hide from sandboxed reads'],
        ['sandbox.credentials.envVars', 'object[]', '<code>{name, mode:"deny"|"mask"}</code> — env vars to unset or mask inside the sandbox'],
        ['sandbox.ripgrep', 'object', 'Custom ripgrep <code>command</code>/<code>args</code> for the bundled search tool'],
      ]},
      { title: 'Hooks', keys: [
        ['hooks.SessionStart / SessionEnd', 'hook[]', 'When a session begins/resumes or ends'],
        ['hooks.UserPromptSubmit', 'hook[]', 'When the user submits a prompt'],
        ['hooks.PreToolUse / PostToolUse', 'hook[]', 'Before/after a tool runs (PreToolUse can block)'],
        ['hooks.PostToolUseFailure / PostToolBatch', 'hook[]', 'After a tool fails, or after a batch of tool calls'],
        ['hooks.Stop / SubagentStop', 'hook[]', 'When the main thread or a subagent finishes'],
        ['hooks.SubagentStart', 'hook[]', 'When a subagent spawns'],
        ['hooks.Notification / PermissionRequest / PermissionDenied', 'hook[]', 'Attention, permission prompt, and permission-denied events'],
        ['hooks.PreCompact / PostCompact', 'hook[]', 'Before/after context compaction'],
        ['hooks.FileChanged / CwdChanged', 'hook[]', 'When a watched file changes, or the working directory changes'],
        ['disableAllHooks', 'boolean', 'Disable all hooks and the status line'],
        ['disableSkillShellExecution', 'boolean', 'Disable inline shell execution in skills/custom commands'],
      ]},
      { title: 'Plugins & MCP', keys: [
        ['enabledPlugins', 'object', 'Map of <code>"plugin@marketplace"</code> → enabled (boolean or version constraint array)'],
        ['extraKnownMarketplaces', 'object', 'Additional marketplace sources to register for this repo/user'],
        ['pluginConfigs', 'object', 'Per-plugin MCP server config and option values, keyed by plugin ID'],
        ['skillOverrides', 'object', 'Per-skill listing mode: <code>"name-only"</code>, <code>"user-invocable-only"</code>, <code>"off"</code>'],
        ['disableBundledSkills', 'boolean', 'Remove skills/workflows/slash-commands that ship with Claude Code'],
        ['enableAllProjectMcpServers', 'boolean', 'Auto-approve all MCP servers declared in the project'],
        ['enabledMcpjsonServers / disabledMcpjsonServers', 'string[]', 'Approve/reject specific MCP servers from <code>.mcp.json</code>'],
        ['disableClaudeAiConnectors', 'boolean', 'Stop auto-fetching claude.ai MCP cloud connectors'],
      ]},
      { title: 'Skills, Memory & Context', keys: [
        ['skillListingMaxDescChars', 'number', 'Per-skill description character cap in the skill listing (default 1536)'],
        ['skillListingBudgetFraction', 'number', 'Fraction of context reserved for the skill listing (default 0.01)'],
        ['autoMemoryEnabled', 'boolean', 'Enable the auto-memory directory for this project'],
        ['autoMemoryDirectory', 'string', 'Custom path for auto-memory storage'],
        ['autoDreamEnabled', 'boolean', 'Enable background memory consolidation ("auto-dream")'],
        ['claudeMdExcludes', 'string[]', 'Glob patterns/paths of CLAUDE.md files to exclude from loading'],
        ['plansDirectory', 'string', 'Custom directory for plan files (default <code>~/.claude/plans/</code>)'],
        ['respectGitignore', 'boolean', 'Whether the file picker respects <code>.gitignore</code> (default true)'],
        ['fileSuggestion', 'object', '<code>{type:"command", command}</code> — custom @ mention file suggestion source'],
        ['fileCheckpointingEnabled', 'boolean', 'Snapshot files before edits so <code>/rewind</code> can restore them'],
      ]},
      { title: 'Session & Workflow', keys: [
        ['ultracode', 'boolean', 'Enable ultracode: xhigh effort + standing workflow orchestration for the session'],
        ['enableWorkflows / disableWorkflows', 'boolean', 'Enable or disable the Workflows feature'],
        ['workflowKeywordTriggerEnabled', 'boolean', 'Whether the "ultracode" keyword in a prompt triggers Workflow mode (default true)'],
        ['enableArtifact / disableArtifact', 'boolean', 'Enable or disable the Artifact tool'],
        ['todoFeatureEnabled', 'boolean', 'Enable the todo/task tracking panel'],
        ['fastMode', 'boolean', 'Enable fast mode (faster output, same model tier)'],
        ['fastModePerSessionOptIn', 'boolean', 'Fast mode does not persist across sessions when true'],
        ['promptSuggestionEnabled', 'boolean', 'Show prompt suggestions'],
        ['askUserQuestionTimeout', 'string', 'Idle time before questions auto-continue: <code>"60s"</code>, <code>"5m"</code>, <code>"10m"</code>, <code>"never"</code>'],
        ['showClearContextOnPlanAccept', 'boolean', 'Offer a "clear context" option when a plan is approved'],
        ['switchModelsOnFlag', 'boolean', 'Auto-switch models when a safety check flags a message, instead of pausing'],
      ]},
      { title: 'UI & Display', keys: [
        ['theme', 'string', '<code>auto</code>, <code>dark</code>, <code>light</code>, plus daltonized/ANSI variants'],
        ['editorMode', 'string', 'Prompt input key bindings: <code>normal</code> or <code>vim</code>'],
        ['tui', 'string', 'Renderer: <code>fullscreen</code> (flicker-free, virtualized) or <code>default</code>'],
        ['viewMode / defaultView', 'string', 'Default transcript view mode on startup'],
        ['verbose', 'boolean', 'Show full tool output instead of truncated summaries'],
        ['showThinkingSummaries', 'boolean', 'Show API-side thinking summaries in the transcript'],
        ['showTurnDuration', 'boolean', 'Show "Cooked for Nm Ns" after each assistant turn'],
        ['showMessageTimestamps', 'boolean', 'Stamp each assistant message with its arrival time'],
        ['spinnerTipsEnabled / spinnerTipsOverride', 'boolean/object', 'Show or customize tips in the spinner'],
        ['spinnerVerbs', 'object', 'Customize spinner verbs (<code>append</code> or <code>replace</code> mode)'],
        ['syntaxHighlightingDisabled', 'boolean', 'Disable syntax highlighting in diffs'],
        ['terminalProgressBarEnabled', 'boolean', 'Emit OSC 9;4 progress sequences during long operations'],
        ['terminalTitleFromRename', 'boolean', 'Whether <code>/rename</code> updates the terminal tab title (default true)'],
        ['prefersReducedMotion', 'boolean', 'Reduce/disable UI animations'],
        ['autoScrollEnabled / wheelScrollAccelerationEnabled', 'boolean', 'Auto-scroll to bottom / ramp mouse-wheel scroll speed (fullscreen mode)'],
        ['axScreenReader', 'boolean', 'Render screen-reader-friendly output (flat text, no decoration)'],
      ]},
      { title: 'Notifications & Status Line', keys: [
        ['statusLine', 'object', '<code>{type:"command", command}</code> — custom status line, plus <code>padding</code>/<code>refreshInterval</code>'],
        ['subagentStatusLine', 'object', 'Custom per-subagent status line shown in the agent panel'],
        ['preferredNotifChannel', 'string', 'OS notification channel: <code>auto</code>, <code>iterm2</code>, <code>terminal_bell</code>, <code>kitty</code>, <code>ghostty</code>, etc.'],
        ['inputNeededNotifEnabled', 'boolean', 'Push to mobile when a permission prompt or question is waiting'],
        ['agentPushNotifEnabled', 'boolean', 'Allow Claude to push proactive mobile notifications'],
        ['companyAnnouncements', 'string[]', 'Announcements to display at startup (one chosen at random)'],
        ['prUrlTemplate', 'string', 'URL template for PR footer links, e.g. <code>https://.../{owner}/{repo}/pull/{number}</code>'],
        ['footerLinksRegexes', 'object', 'Extra clickable footer badges triggered by regex matches on turn output'],
      ]},
      { title: 'Remote, Teammates & Voice', keys: [
        ['remote.defaultEnvironmentId', 'string', 'Default environment ID for cloud sessions'],
        ['remoteControlAtStartup', 'boolean', 'Start the Remote Control bridge automatically each session'],
        ['disableRemoteControl', 'boolean', 'Disable Remote Control entirely'],
        ['isolatePeerMachines', 'boolean', 'Require explicit approval before a peer session on another machine can be reached'],
        ['disableAgentView', 'boolean', 'Disable agent view (<code>claude agents</code>, <code>--bg</code>, the background daemon)'],
        ['teammateMode', 'string', 'How spawned teammates execute: <code>auto</code>, <code>tmux</code>, <code>iterm2</code>, <code>in-process</code>'],
        ['daemonColdStart', 'string', '<code>transient</code> spawns a background service for this login; <code>ask</code> offers to install it persistently'],
        ['autoUploadSessions', 'boolean', 'Mirror local sessions to claude.ai as view-only'],
        ['voice.enabled / voiceEnabled', 'boolean', 'Enable voice mode (hold-to-talk dictation)'],
        ['voice.mode', 'string', '<code>hold</code> (hold to talk) or <code>tap</code> (tap to start/stop)'],
        ['voice.autoSubmit', 'boolean', 'Submit the prompt automatically when hold-to-talk is released'],
        ['channelsEnabled', 'boolean', 'Allow MCP servers with channel capability to push inbound messages'],
      ]},
      { title: 'Auth & Integration Helpers', keys: [
        ['apiKeyHelper', 'string', 'Path to a script that outputs authentication values'],
        ['awsCredentialExport / awsAuthRefresh', 'string', 'Scripts that export/refresh AWS credentials'],
        ['gcpAuthRefresh', 'string', 'Command to refresh GCP authentication'],
        ['otelHeadersHelper', 'string', 'Path to a script that outputs OpenTelemetry headers'],
        ['forceLoginMethod', 'string', 'Force a login method: <code>claudeai</code>, <code>console</code>, or <code>gateway</code>'],
        ['skipWebFetchPreflight', 'boolean', 'Skip the WebFetch blocklist preflight check'],
      ]},
    ];
    const deprecated = [
      ['includeCoAuthoredBy', 'boolean', 'Superseded by <code>attribution</code> (set <code>attribution.commit</code>/<code>.pr</code> to <code>""</code> to hide instead)'],
      ['notificationCommand', 'string', 'No longer part of the schema — use <code>preferredNotifChannel</code> or a <code>hooks.Notification</code> command hook'],
      ['defaultMode (root level)', 'string', 'Not a real top-level key — use <code>permissions.defaultMode</code>'],
      ['disableAutoMode / disableBypassPermissionsMode (root level)', 'string', 'Root-level duplicates of the <code>permissions.*</code> equivalents — prefer the nested form'],
    ];
    const enterprise = [
      ['policyHelper', 'Executable that computes managed settings at startup (admin policy sources only)'],
      ['allowedMcpServers / deniedMcpServers', 'Enterprise allow/deny list of MCP servers across all scopes'],
      ['strictKnownMarketplaces / blockedMarketplaces', 'Restrict or block plugin marketplace sources before download'],
      ['disableSideloadFlags', 'Reject CLI flags that bypass marketplace restrictions'],
      ['allowManagedHooksOnly / allowManagedPermissionRulesOnly / allowManagedMcpServersOnly', 'Restrict hooks/permissions/MCP servers to managed settings only'],
      ['requiredMinimumVersion / requiredMaximumVersion', 'Block startup unless the Claude Code version is in range'],
      ['sshConfigs', 'Pre-configured SSH connections for remote environments'],
      ['claudeMd / pluginTrustMessage', 'Org-wide instructions and plugin-install disclaimer text'],
      ['forceLoginOrgUUID / forceRemoteSettingsRefresh', 'Restrict login to specific orgs; force a fresh managed-settings fetch at startup'],
    ];
    let html = '';
    for (const s of sections) {
      html += '<div class="ref-section"><h4>' + s.title + '</h4><table class="ref-table"><thead><tr><th>Key</th><th>Type</th><th>Description</th></tr></thead><tbody>';
      for (const [key, type, desc] of s.keys) {
        html += '<tr><td><code>' + key + '</code></td><td><code>' + type + '</code></td><td>' + desc + '</td></tr>';
      }
      html += '</tbody></table></div>';
    }
    html += '<div class="ref-section ref-section-deprecated"><h4>Deprecated / Incorrect Keys</h4><table class="ref-table"><thead><tr><th>Key</th><th>Type</th><th>Description</th></tr></thead><tbody>';
    for (const [key, type, desc] of deprecated) {
      html += '<tr class="ref-row-deprecated"><td><code>' + key + '</code></td><td><code>' + type + '</code></td><td>' + desc + '</td></tr>';
    }
    html += '</tbody></table></div>';
    html += '<div class="ref-section"><h4>Enterprise / Managed Settings Only</h4><table class="ref-table"><thead><tr><th>Key</th><th>Description</th></tr></thead><tbody>';
    for (const [key, desc] of enterprise) {
      html += '<tr><td><code>' + key + '</code></td><td>' + desc + '</td></tr>';
    }
    html += '</tbody></table></div>';
    html += '<div class="ref-footer">';
    html += '<div style="margin-bottom:6px"><strong>Hook object format:</strong><br>';
    html += '<code>matcher</code> — filter pattern<br>';
    html += '<code>type</code> — <code>command</code> | <code>http</code> | <code>prompt</code><br>';
    html += '<code>command</code> — shell command to run<br>';
    html += '<code>url</code> — HTTP endpoint<br>';
    html += '<code>timeout</code> — seconds</div>';
    html += '<div style="margin-bottom:6px"><strong>Permission rules:</strong> <code>Tool</code> or <code>Tool(pattern)</code><br>';
    html += 'e.g. <code>Bash(npm *)</code> · <code>Read(/src/*)</code> · <code>WebFetch(domain:github.com)</code></div>';
    html += '<div>Docs: <a href="https://docs.anthropic.com/en/docs/claude-code/settings" target="_blank" rel="noopener">Settings</a>';
    html += ' · <a href="https://docs.anthropic.com/en/docs/claude-code/hooks" target="_blank" rel="noopener">Hooks</a>';
    html += ' · <a href="https://docs.anthropic.com/en/docs/claude-code/security" target="_blank" rel="noopener">Permissions &amp; Security</a></div>';
    html += '</div>';
    return html;
  },

  toggleRaw() {
    Settings.showRaw = !Settings.showRaw;
    document.getElementById('settings-visual').style.display = Settings.showRaw ? 'none' : '';
    document.getElementById('settings-raw').style.display = Settings.showRaw ? '' : 'none';
    if (Settings.showRaw) {
      document.getElementById('settings-editor').value = JSON.stringify(Settings.data, null, 2);
    } else {
      try {
        Settings.data = JSON.parse(document.getElementById('settings-editor').value);
        Settings.render();
      } catch (_) {}
    }
  },

  render() {
    const container = document.getElementById('settings-visual');
    container.innerHTML = '';
    container.appendChild(Settings.buildTree(Settings.data, []));
    Settings.renderCleanupWarning();
  },

  buildTree(obj, path) {
    const frag = document.createDocumentFragment();
    for (const key of Object.keys(obj)) {
      frag.appendChild(Settings.buildNode(key, obj[key], path));
    }
    return frag;
  },

  buildNode(key, value, parentPath) {
    const fullPath = [...parentPath, key];
    const type = Settings.getType(value);
    const node = document.createElement('div');
    node.className = 'prop-node';

    const isObj = type === 'object';
    const isArr = type === 'array';
    const isExpandable = isObj || isArr;

    // Header
    const header = document.createElement('div');
    header.className = 'prop-header';

    // Toggle
    const toggle = document.createElement('button');
    toggle.className = 'prop-toggle' + (isExpandable ? ' open' : ' leaf');
    toggle.innerHTML = '&#9654;';
    if (isExpandable) {
      toggle.onclick = () => {
        toggle.classList.toggle('open');
        const children = node.querySelector('.prop-children');
        if (children) children.style.display = toggle.classList.contains('open') ? '' : 'none';
      };
    }
    header.appendChild(toggle);

    // Key
    const keyEl = document.createElement('span');
    keyEl.className = 'prop-key';
    keyEl.textContent = key;
    header.appendChild(keyEl);

    // Type badge
    const typeEl = document.createElement('span');
    typeEl.className = 'prop-type';
    typeEl.textContent = type;
    header.appendChild(typeEl);

    // Value editor (for primitives)
    if (!isExpandable) {
      const valueEl = document.createElement('div');
      valueEl.className = 'prop-value';
      valueEl.appendChild(Settings.buildValueInput(value, type, fullPath));
      header.appendChild(valueEl);
    }

    // Actions
    const actions = document.createElement('div');
    actions.className = 'prop-actions';

    const delBtn = document.createElement('button');
    delBtn.className = 'prop-action-btn danger';
    delBtn.title = 'Delete';
    delBtn.innerHTML = '&#10005;';
    delBtn.onclick = () => {
      Settings.deletePath(fullPath);
      Settings.render();
    };
    actions.appendChild(delBtn);
    header.appendChild(actions);

    node.appendChild(header);

    // Children for objects/arrays
    if (isExpandable) {
      const children = document.createElement('div');
      children.className = 'prop-children';

      if (isObj) {
        for (const k of Object.keys(value)) {
          children.appendChild(Settings.buildNode(k, value[k], fullPath));
        }
      } else if (isArr) {
        value.forEach((item, i) => {
          children.appendChild(Settings.buildNode(String(i), item, fullPath));
        });
      }

      // Add child button
      const addRow = document.createElement('div');
      addRow.className = 'add-prop-row';
      addRow.innerHTML = `
        <input type="text" placeholder="${isArr ? 'value' : 'key'}" class="add-key">
        <select class="add-type">
          ${VALUE_TYPES.map(t => `<option value="${t}">${t}</option>`).join('')}
        </select>
        <button class="btn btn-sm">+ Add</button>
      `;
      addRow.querySelector('button').onclick = () => {
        const keyInput = addRow.querySelector('.add-key');
        const typeSelect = addRow.querySelector('.add-type');
        const newKey = isArr ? String(value.length) : keyInput.value.trim();
        if (!newKey) { toast('Key is required', 'error'); return; }
        const newType = typeSelect.value;
        const parent = Settings.getPath(fullPath);
        if (!isArr && parent.hasOwnProperty(newKey)) { toast('Key already exists', 'error'); return; }
        const defaultVal = Settings.defaultValue(newType);
        if (isArr) {
          parent.push(newType === 'string' ? keyInput.value : defaultVal);
        } else {
          parent[newKey] = defaultVal;
        }
        Settings.render();
      };
      children.appendChild(addRow);

      node.appendChild(children);
    }

    return node;
  },

  buildValueInput(value, type, fullPath) {
    if (type === 'boolean') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = value;
      input.onchange = () => Settings.setPath(fullPath, input.checked);
      return input;
    }
    if (type === 'number') {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = value;
      input.onchange = () => {
        const num = Number(input.value);
        if (!isNaN(num)) Settings.setPath(fullPath, num);
      };
      return input;
    }
    if (type === 'null') {
      const span = document.createElement('span');
      span.style.color = 'var(--text-muted)';
      span.textContent = 'null';
      return span;
    }
    // string
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.onchange = () => Settings.setPath(fullPath, input.value);
    return input;
  },

  getType(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  },

  defaultValue(type) {
    switch (type) {
      case 'string': return '';
      case 'number': return 0;
      case 'boolean': return false;
      case 'object': return {};
      case 'array': return [];
      default: return null;
    }
  },

  getPath(pathArr) {
    let obj = Settings.data;
    for (const key of pathArr) obj = obj[key];
    return obj;
  },

  setPath(pathArr, value) {
    let obj = Settings.data;
    for (let i = 0; i < pathArr.length - 1; i++) obj = obj[pathArr[i]];
    obj[pathArr[pathArr.length - 1]] = value;
  },

  deletePath(pathArr) {
    let obj = Settings.data;
    for (let i = 0; i < pathArr.length - 1; i++) obj = obj[pathArr[i]];
    const key = pathArr[pathArr.length - 1];
    if (Array.isArray(obj)) {
      obj.splice(Number(key), 1);
    } else {
      delete obj[key];
    }
  },

  addRootProperty() {
    openModal({
      title: 'Add Root Property',
      body: formGroup('Key', '<input type="text" id="new-root-key" placeholder="propertyName">')
        + formGroup('Type', selectHtml('new-root-type', VALUE_TYPES, 'string')),
      buttons: [{
        label: 'Add', primary: true, onClick: () => {
          const key = document.getElementById('new-root-key').value.trim();
          const type = document.getElementById('new-root-type').value;
          if (!key) { toast('Key is required', 'error'); return false; }
          if (Settings.data.hasOwnProperty(key)) { toast('Key already exists', 'error'); return false; }
          Settings.data[key] = Settings.defaultValue(type);
          Settings.render();
        }
      }]
    });
  }
};
