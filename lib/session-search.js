const MAX_SNIPPETS = 3;
const SNIPPET_RADIUS = 75;

function extractEntrySnippets(entry, q, qLower, existing) {
  const content = entry.message?.content;
  const role = entry.type;
  const searchBlocks = [];

  if (typeof content === 'string') {
    searchBlocks.push({ text: content, label: '' });
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text') {
        searchBlocks.push({ text: block.text, label: '' });
      } else if (block.type === 'tool_use') {
        const inputStr = typeof block.input === 'string' ? block.input : JSON.stringify(block.input);
        searchBlocks.push({ text: inputStr, label: block.name || 'tool' });
      } else if (block.type === 'tool_result') {
        let resultText = '';
        if (typeof block.content === 'string') {
          resultText = block.content;
        } else if (Array.isArray(block.content)) {
          resultText = block.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        }
        if (resultText) searchBlocks.push({ text: resultText, label: 'result' });
      }
    }
  }

  const snippets = [];
  for (const sb of searchBlocks) {
    if (existing + snippets.length >= MAX_SNIPPETS) break;
    const idx = sb.text.toLowerCase().indexOf(qLower);
    if (idx === -1) continue;
    const start = Math.max(0, idx - SNIPPET_RADIUS);
    const end = Math.min(sb.text.length, idx + q.length + SNIPPET_RADIUS);
    let snippet = (start > 0 ? '...' : '') + sb.text.slice(start, end) + (end < sb.text.length ? '...' : '');
    snippet = snippet.replace(/\n/g, ' ');
    snippets.push({ text: snippet, role, label: sb.label });
  }
  return snippets;
}

function extractMetaSnippet(fields, q, qLower) {
  for (const field of fields.filter(Boolean)) {
    if (!field.toLowerCase().includes(qLower)) continue;
    const idx = field.toLowerCase().indexOf(qLower);
    const start = Math.max(0, idx - SNIPPET_RADIUS);
    const end = Math.min(field.length, idx + q.length + SNIPPET_RADIUS);
    return { text: field.slice(start, end), role: 'meta', label: '' };
  }
  return null;
}

const FILTER_KEYS = { n: 'name', f: 'file', t: 'tool', b: 'branch' };
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * Splits a search query into free text plus `n:` (session name), `f:` (edited file), `t:` (tool)
 * and `b:` (git branch) filters. Filter values may be quoted: f:"my file.js". Values are lowercased.
 */
function parseSearchQuery(q) {
  const filters = { name: [], file: [], tool: [], branch: [] };
  const rest = [];
  const re = /(?:^|\s)([nftb]):(?:"([^"]*)"|(\S+))|(\S+)/g;
  let m;
  while ((m = re.exec(q))) {
    if (m[1]) {
      const value = (m[2] !== undefined ? m[2] : m[3]).trim().toLowerCase();
      if (value) filters[FILTER_KEYS[m[1]]].push(value);
    } else {
      rest.push(m[4]);
    }
  }
  const text = rest.join(' ');
  const hasFilters = Object.values(filters).some(v => v.length);
  return { text, textLower: text.toLowerCase(), filters, hasFilters };
}

/** Records the tools an entry used and the files it edited into `facts.tools` / `facts.files`. */
function collectEntryFacts(entry, facts) {
  if (entry.type !== 'assistant') return;
  const content = entry.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block.type !== 'tool_use' || !block.name) continue;
    facts.tools.set(block.name, (facts.tools.get(block.name) || 0) + 1);
    if (!EDIT_TOOLS.has(block.name) || !block.input) continue;
    const file = block.input.file_path || block.input.notebook_path;
    if (file) facts.files.add(String(file).replace(/\\/g, '/'));
  }
}

/**
 * Checks every filter against a session's facts ({ name, files, tools, branches }); all filters
 * must match. Returns one snippet per filter on success, or null when any filter misses.
 */
function matchFilters(filters, facts) {
  const snippets = [];
  for (const v of filters.name) {
    if (!facts.name || !facts.name.toLowerCase().includes(v)) return null;
    snippets.push({ text: facts.name, role: 'meta', label: 'name' });
  }
  for (const v of filters.file) {
    const hit = [...facts.files].find(f => f.toLowerCase().includes(v));
    if (!hit) return null;
    snippets.push({ text: hit, role: 'meta', label: 'file' });
  }
  for (const v of filters.tool) {
    const hit = [...facts.tools.keys()].find(t => t.toLowerCase().includes(v));
    if (!hit) return null;
    snippets.push({ text: `${hit} ×${facts.tools.get(hit)}`, role: 'meta', label: 'tool' });
  }
  for (const v of filters.branch) {
    const hit = facts.branches.find(b => b.toLowerCase().includes(v));
    if (!hit) return null;
    snippets.push({ text: hit, role: 'meta', label: 'branch' });
  }
  return snippets;
}

module.exports = { MAX_SNIPPETS, extractEntrySnippets, extractMetaSnippet, parseSearchQuery, collectEntryFacts, matchFilters };
