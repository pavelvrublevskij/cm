// --- Global Agents ---
// Subagents in ~/.claude/agents/, available in every project (a project agent with the same name wins).

const Agents = makeFrontmatterCrud({
  globalName: 'Agents',
  containerId: 'agents-content',
  apiBase: '/api/agents/global',
  itemKey: 'filename',
  idPrefix: 'gagent',
  itemLabel: 'Agent',
  cardTitle: a => `<span style="color:var(--accent)">${escapeHtml(a.name)}</span>`,
  editTitle: (item, filename) => item.frontmatter.name || filename,
  editContentLabel: 'Instructions (system prompt)',
  infoNote: `Agents are subagents Claude can delegate tasks to, each with its own instructions, tools and model.
    Global agents live in <code>~/.claude/agents/</code> and work in every project; a project agent with the same name takes precedence.
    <strong>Name</strong> and <strong>Description</strong> are required — Claude reads the description to decide when to delegate.`,
  emptyText: 'No global agents yet',
  editRequired: true,
  editExtraFields: (item, idp) => agentOptionalFields(item.frontmatter, idp + '-edit'),
  readEditExtras: (fm, idp) => readAgentOptionalFields(fm, idp + '-edit'),
  validate: validateAgent,
  createFields: idp => agentCreateFields(idp, '~/.claude/agents/'),
  createBody: idp => agentCreateBody(idp, Agents.list)
});
