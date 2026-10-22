const Skills = makeFrontmatterCrud({
  globalName: 'Skills',
  containerId: 'skills-content',
  apiBase: '/api/skills/global',
  itemKey: 'name',
  idPrefix: 'skill',
  itemLabel: 'Skill',
  cardTitle: s => `<span style="color:var(--accent);font-family:var(--font-mono)">/${escapeHtml(s.name)}</span>`,
  editTitle: (item, name) => '/' + name,
  infoNote: `Skills are custom slash commands you can invoke with <code>/skill-name</code>.
    Each skill is a <code>SKILL.md</code> file with YAML frontmatter (name, description, allowed-tools, model, effort) and markdown instructions.
    Stored in <code>~/.claude/skills/&lt;name&gt;/SKILL.md</code> (global) or <code>.claude/skills/</code> (per-project).
    Use <code>$ARGUMENTS</code> in content to receive user input.`,
  emptyText: 'No custom skills configured',
  editExtraFields: (item, idp) =>
    formGroup('Allowed Tools', `<input type="text" id="${idp}-edit-tools" value="${escapeHtml(item.frontmatter['allowed-tools'] || '')}" placeholder="Read, Grep, Bash(npm *)">`)
    + skillModelEffortFields(item, idp),
  readEditExtras: (fm, idp) => {
    const tools = document.getElementById(`${idp}-edit-tools`).value.trim();
    if (tools) fm['allowed-tools'] = tools; else delete fm['allowed-tools'];
    readSkillModelEffort(fm, idp);
  },
  createFields: idp =>
    formGroup('Skill Name (folder name)', `<input type="text" id="${idp}-new-name" placeholder="my-skill">`)
    + formGroup('Description', `<input type="text" id="${idp}-new-desc" placeholder="What this skill does">`),
  createBody: idp => {
    const name = document.getElementById(`${idp}-new-name`).value.trim();
    const desc = document.getElementById(`${idp}-new-desc`).value.trim();
    if (!name) { toast('Name required', 'error'); return null; }
    return { key: name, frontmatter: { name, description: desc }, content: '# Instructions\n\n' };
  }
});
