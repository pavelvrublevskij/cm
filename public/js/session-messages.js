Object.assign(Sessions, {
  _detailSearchQuery: '',

  renderMessage(msg) {
    const time = msg.timestamp ? (() => {
      const d = new Date(msg.timestamp);
      const today = new Date();
      const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
      return sameDay
        ? d.toLocaleTimeString()
        : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString();
    })() : '';
    let bodyHtml = '';
    const hasText = msg.content.some(b => b.type === 'text' && b.text && b.text.trim());
    const hasAgentBlock = msg.content.some(b =>
      (b.type === 'tool_use' && b.name === 'Agent') ||
      (b.type === 'tool_result' && b.agentId)
    );

    for (const block of msg.content) {
      if (block.type === 'text') {
        bodyHtml += `<div class="chat-text">${renderChatMarkdown(block.text)}</div>`;
      } else if (block.type === 'tool_use') {
        if (block.name === 'Agent') {
          bodyHtml += Sessions._renderAgentLaunchBlock(block);
        } else {
          const toolId = 'tool-' + Math.random().toString(36).slice(2, 8);
          const { headerSuffix, bodyContent } = Sessions.formatToolUse(block.name, block.input);
          bodyHtml += `
            <div class="chat-tool">
              <div class="chat-tool-header" onclick="document.getElementById('${toolId}').classList.toggle('open')">
                &#9654; <span class="tool-name">${escapeHtml(block.name)}</span>${headerSuffix}
              </div>
              <div class="chat-tool-body" id="${toolId}">${bodyContent}</div>
            </div>
          `;
        }
      } else if (block.type === 'tool_result') {
        if (block.agentId) {
          bodyHtml += Sessions._renderAgentResultBlock(block);
        } else if (block.text) {
          const resId = 'res-' + Math.random().toString(36).slice(2, 8);
          bodyHtml += `
            <div class="chat-tool-result">
              <div class="chat-tool-header" onclick="document.getElementById('${resId}').classList.toggle('open')">
                &#9654; Result
              </div>
              <div class="chat-tool-body" id="${resId}">${escapeHtml(block.text)}</div>
            </div>
          `;
        }
      }
    }

    return `
      <div class="chat-msg ${msg.role}${(hasText || hasAgentBlock) ? '' : ' chat-msg-tools-only'}">
        <div class="chat-role ${msg.role}">
          <span class="chat-role-label">${msg.role === 'user' ? 'You' : 'Claude'}</span>
          ${msg.model && msg.role === 'assistant' ? `<span class="chat-model">${escapeHtml(shortModel(msg.model))}</span>` : ''}
          <span class="chat-time">${time}</span>
        </div>
        ${bodyHtml}
      </div>
    `;
  },

  _renderAgentLaunchBlock(block) {
    const input = block.input || {};
    const type = escapeHtml(input.subagent_type || 'Agent');
    const desc = escapeHtml((input.description || '').trim());
    const prompt = (input.prompt || '').trim();
    const promptPreview = escapeHtml(prompt.slice(0, 400));
    const id = 'alp-' + Math.random().toString(36).slice(2, 8);
    const hasPrompt = prompt.length > 0;

    return `<div class="chat-agent-launch">
      <div class="agent-launch-header"${hasPrompt ? ` onclick="Sessions._toggleAgentLaunchPrompt('${id}')"` : ''}>
        <span class="agent-launch-type">${type}</span>
        ${desc ? `<span class="agent-launch-desc">${desc}</span>` : ''}
        ${hasPrompt ? `<span class="agent-launch-expand" id="${id}-btn">&#9654; prompt</span>` : ''}
      </div>
      ${hasPrompt ? `<div class="agent-launch-prompt" id="${id}" style="display:none"><pre>${promptPreview}${prompt.length > 400 ? '\n…' : ''}</pre></div>` : ''}
    </div>`;
  },

  _renderAgentResultBlock(block) {
    const agentId = escapeHtml(block.agentId);
    const type = escapeHtml(block.agentType || 'Agent');
    const convId = 'agconv-' + block.agentId.slice(0, 16);
    return `<div class="chat-agent-result">
      <div class="chat-agent-result-header" onclick="Sessions._expandAgentConv('${agentId}', '${escapeHtml(convId)}')">
        <span class="agent-result-arrow" id="${escapeHtml(convId)}-arrow">&#9654;</span>
        <span class="agent-result-type">${type}</span>
        <span class="agent-result-label">completed</span>
        <span class="agent-result-link">view conversation</span>
      </div>
      <div class="chat-agent-conv" id="${escapeHtml(convId)}" style="display:none"></div>
    </div>`;
  },

  _toggleAgentLaunchPrompt(id) {
    const el = document.getElementById(id);
    const btn = document.getElementById(id + '-btn');
    if (!el) return;
    const open = el.style.display !== 'none';
    el.style.display = open ? 'none' : 'block';
    if (btn) btn.innerHTML = open ? '&#9654; prompt' : '&#9660; prompt';
  },

  async _expandAgentConv(agentId, convId) {
    const convEl = document.getElementById(convId);
    const arrowEl = document.getElementById(convId + '-arrow');
    if (!convEl) return;

    const isOpen = convEl.style.display !== 'none';
    convEl.style.display = isOpen ? 'none' : 'block';
    if (arrowEl) arrowEl.innerHTML = isOpen ? '&#9654;' : '&#9660;';
    if (isOpen || convEl.dataset.loaded) return;

    const { slug, sessionId } = Sessions.detailState;
    convEl.innerHTML = '<div class="loading"><div class="spinner"></div> Loading sub-agent conversation…</div>';

    try {
      const data = await api(`/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(agentId)}`);
      convEl.dataset.loaded = '1';
      if (!data.messages || !data.messages.length) {
        convEl.innerHTML = '<div class="empty-state"><p>No messages recorded</p></div>';
        return;
      }
      convEl.innerHTML = data.messages.map(m => Sessions.renderMessage(m)).join('');
      addCodeCopyButtons(convEl);
    } catch (e) {
      convEl.innerHTML = `<div class="empty-state"><p>${escapeHtml(e.message)}</p></div>`;
    }
  },

  onDetailSearch: debounce(async function(value) {
    const q = value.trim();
    Sessions._detailSearchQuery = q;
    if (q.length >= 2) Sessions._saveToHistoryDebounced(q, Sessions._detailSearchKey(Sessions.detailState.slug));
    if (q && Sessions.detailState.hasMore) {
      await Sessions.loadAllMessages();
      if (Sessions._detailSearchQuery !== q) return;
    }
    Sessions.applyDetailFilter(q);
  }, 500),

  async loadAllMessages() {
    while (Sessions.detailState.hasMore && !Sessions.detailState.loading) {
      await Sessions.loadMore();
    }
  },

  applyDetailFilter(query) {
    const container = document.getElementById('session-messages');
    const countEl = document.getElementById('session-detail-search-count');
    const messages = container.querySelectorAll('.chat-msg');
    const showTools = Sessions.showToolDetails();

    container.querySelectorAll('mark.search-highlight').forEach(m => {
      const parent = m.parentNode;
      parent.replaceChild(document.createTextNode(m.textContent), m);
      parent.normalize();
    });

    if (!query) {
      messages.forEach(msg => msg.style.display = '');
      if (countEl) countEl.textContent = '';
      return;
    }

    const qLower = query.toLowerCase();
    let matchedMessages = 0;
    let totalMatches = 0;

    messages.forEach(msg => {
      if (!showTools && msg.classList.contains('chat-msg-tools-only')) {
        msg.style.display = '';
        return;
      }
      let text;
      if (showTools) {
        text = msg.textContent.toLowerCase();
      } else {
        text = Array.from(msg.querySelectorAll('.chat-text'))
          .map(n => n.textContent).join(' ').toLowerCase();
      }
      if (text.includes(qLower)) {
        msg.style.display = '';
        matchedMessages++;
        const scope = showTools ? msg : msg.querySelectorAll('.chat-text');
        if (showTools) {
          totalMatches += Sessions.highlightInNode(msg, query);
        } else {
          scope.forEach(n => { totalMatches += Sessions.highlightInNode(n, query); });
        }
      } else {
        msg.style.display = 'none';
      }
    });

    if (countEl) {
      countEl.textContent = matchedMessages
        ? `${totalMatches} matches in ${matchedMessages} messages`
        : 'No matches';
    }
  },

  highlightInNode(root, query) {
    const qLower = query.toLowerCase();
    let count = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: n => n.parentNode.tagName === 'SCRIPT' || n.parentNode.tagName === 'STYLE'
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    });
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) textNodes.push(node);

    for (const textNode of textNodes) {
      const text = textNode.nodeValue;
      const lower = text.toLowerCase();
      let idx = lower.indexOf(qLower);
      if (idx === -1) continue;

      const frag = document.createDocumentFragment();
      let last = 0;
      while (idx !== -1) {
        if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)));
        const mark = document.createElement('mark');
        mark.className = 'search-highlight';
        mark.textContent = text.slice(idx, idx + query.length);
        frag.appendChild(mark);
        count++;
        last = idx + query.length;
        idx = lower.indexOf(qLower, last);
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      textNode.parentNode.replaceChild(frag, textNode);
    }
    return count;
  },

  formatToolUse(name, input) {
    const basename = p => p ? escapeHtml(p.split(/[/\\]/).pop()) : '';
    const param = html => `<span class="tool-param">${html}</span>`;

    switch (name) {
      case 'Edit': {
        const file = basename(input.file_path || '');
        return {
          headerSuffix: file ? ` ${param(file)}` : '',
          bodyContent: Sessions.renderEditDiff(input)
        };
      }
      case 'Write': {
        const file = basename(input.file_path || '');
        const preview = (input.content || '').slice(0, 600);
        return {
          headerSuffix: file ? ` ${param(file)}` : '',
          bodyContent: `<div class="tool-file-path">${escapeHtml(input.file_path || '')}</div><pre class="tool-code">${escapeHtml(preview)}${(input.content || '').length > 600 ? '\n…' : ''}</pre>`
        };
      }
      case 'Read': {
        const file = basename(input.file_path || '');
        const extras = [input.offset ? `offset:${input.offset}` : '', input.limit ? `limit:${input.limit}` : ''].filter(Boolean).join('  ');
        return {
          headerSuffix: file ? ` ${param(file)}${extras ? ` <span class="tool-param-muted">${escapeHtml(extras)}</span>` : ''}` : '',
          bodyContent: `<div class="tool-file-path">${escapeHtml(input.file_path || '')}</div>`
        };
      }
      case 'Bash': {
        const cmd = input.command || '';
        const preview = cmd.slice(0, 80) + (cmd.length > 80 ? '…' : '');
        return {
          headerSuffix: cmd ? ` ${param(escapeHtml(preview))}` : '',
          bodyContent: `<pre class="tool-code">${escapeHtml(cmd)}</pre>`
        };
      }
      case 'Glob':
        return {
          headerSuffix: input.pattern ? ` ${param(escapeHtml(input.pattern))}` : '',
          bodyContent: escapeHtml(JSON.stringify(input, null, 2))
        };
      case 'Grep':
        return {
          headerSuffix: input.pattern ? ` ${param(escapeHtml(input.pattern))}` : '',
          bodyContent: escapeHtml(JSON.stringify(input, null, 2))
        };
      case 'Agent': {
        const desc = input.description ? input.description.slice(0, 60) : '';
        return {
          headerSuffix: desc ? ` ${param(escapeHtml(desc))}` : '',
          bodyContent: escapeHtml(JSON.stringify(input, null, 2))
        };
      }
      case 'WebFetch': {
        let host = '';
        try { host = new URL(input.url || '').hostname; } catch (_) { host = (input.url || '').slice(0, 60); }
        return {
          headerSuffix: host ? ` ${param(escapeHtml(host))}` : '',
          bodyContent: escapeHtml(JSON.stringify(input, null, 2))
        };
      }
      case 'WebSearch':
        return {
          headerSuffix: input.query ? ` ${param(escapeHtml(input.query.slice(0, 60)))}` : '',
          bodyContent: escapeHtml(JSON.stringify(input, null, 2))
        };
      default:
        return { headerSuffix: '', bodyContent: escapeHtml(JSON.stringify(input, null, 2)) };
    }
  },

  renderEditDiff(input) {
    const filePath = input.file_path ? `<div class="tool-file-path">${escapeHtml(input.file_path)}</div>` : '';
    const replaceAll = input.replace_all ? `<div class="tool-replace-all">replace_all</div>` : '';
    const oldStr = input.old_string != null ? `
      <div class="tool-diff-section tool-diff-old">
        <div class="tool-diff-label">Before</div>
        <pre>${escapeHtml(input.old_string.trim())}</pre>
      </div>` : '';
    const newStr = input.new_string != null ? `
      <div class="tool-diff-section tool-diff-new">
        <div class="tool-diff-label">After</div>
        <pre>${escapeHtml(input.new_string.trim())}</pre>
      </div>` : '';
    return `${filePath}${replaceAll}<div class="tool-diff">${oldStr}${newStr}</div>`;
  }
});
