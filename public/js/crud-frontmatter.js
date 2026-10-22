// opts:
//   globalName      - string name of the global variable ('Skills', 'OutputStyles', etc.)
//   containerId     - DOM element id to render into
//   apiBase         - string or () => string API path prefix
//   itemKey         - 'name' | 'filename' — unique identifier field
//   idPrefix        - short prefix for unique modal input IDs
//   itemLabel       - singular label ('Skill', 'Output Style', ...)
//   cardTitle(item) - returns inner HTML for the card title line
//   infoNote        - optional HTML string for info-note header
//   emptyHtml       - optional full HTML for empty state (overrides emptyText)
//   emptyText       - short empty-state message
//   addCreateBtn    - bool: add "+ New" button inside container (for project tabs)
//   editFromList    - bool: read item from this.list instead of fetching (when no GET :key endpoint)
//   editTitle(item, keyValue) - optional: returns modal title suffix
//   editContentLabel - label for the content textarea (default 'Content')
//   editExtraFields(item, idp) - optional: returns extra formGroup HTML between name/desc and content
//   readEditExtras(fm, idp)   - optional: reads extra inputs, mutates fm before save
//   validate(fm)      - optional: returns an error message to block Save, or null
//   editRequired      - bool: mark Name and Description as required (*) in the edit modal
//   createFields(idp) - returns form HTML for the create modal body
//   createBody(idp)   - reads create inputs, returns { key, frontmatter, content } or null on error
//   onLoad(list)      - optional hook after successful load

function makeFrontmatterCrud(opts) {
  const m = {
    list: [],
    slug: null,

    _base() { return typeof opts.apiBase === 'function' ? opts.apiBase() : opts.apiBase; },

    async load(slug) {
      if (slug !== undefined) m.slug = slug;
      const container = document.getElementById(opts.containerId);
      showLoading(container);
      try {
        m.list = await api(m._base());
        if (opts.onLoad) opts.onLoad(m.list);
        m.render();
      } catch (e) { toast('Could not load ' + opts.itemLabel.toLowerCase() + 's: ' + e.message, 'error'); }
    },

    render() {
      const container = document.getElementById(opts.containerId);
      const note = opts.infoNote ? `<div class="info-note">${opts.infoNote}</div>` : '';
      const createBtn = opts.addCreateBtn
        ? `<div style="text-align:center;margin-top:12px"><button class="btn" onclick="${opts.globalName}.showCreate()">+ New ${opts.itemLabel}</button></div>`
        : '';
      if (m.list.length === 0) {
        container.innerHTML = note + (opts.emptyHtml || `<div class="empty-state"><p>${opts.emptyText || 'No items'}</p></div>`) + createBtn;
        return;
      }
      const key = opts.itemKey;
      const cards = m.list.map(item => `
        <div class="card" style="cursor:pointer" onclick="${opts.globalName}.edit('${escapeHtml(String(item[key]))}')">
          <div style="display:flex;justify-content:space-between;align-items:start">
            <div>
              <div style="font-weight:600;margin-bottom:4px">${opts.cardTitle(item)}</div>
              <div style="font-size:13px;color:var(--text-secondary)">${escapeHtml(item.description || '')}</div>
            </div>
            <button class="prop-action-btn danger" onclick="event.stopPropagation(); ${opts.globalName}.remove('${escapeHtml(String(item[key]))}')">&#10005;</button>
          </div>
        </div>
      `).join('');
      container.innerHTML = note + '<div class="card-grid">' + cards + '</div>' + createBtn;
    },

    async edit(keyValue) {
      try {
        const item = opts.editFromList
          ? m.list.find(i => String(i[opts.itemKey]) === String(keyValue))
          : await api(`${m._base()}/${keyValue}`);
        if (!item) return;
        const idp = opts.idPrefix;
        const extra = opts.editExtraFields ? opts.editExtraFields(item, idp) : '';
        const titleSuffix = opts.editTitle ? opts.editTitle(item, keyValue) : keyValue;
        openModal({
          title: `Edit ${opts.itemLabel}: ${titleSuffix}`,
          width: 700,
          body: formRow(
              formGroup(opts.editRequired ? 'Name *' : 'Name', `<input type="text" id="${idp}-edit-name" value="${escapeHtml(item.frontmatter.name || String(keyValue))}">`),
              formGroup(opts.editRequired ? 'Description *' : 'Description', `<input type="text" id="${idp}-edit-desc" value="${escapeHtml(item.frontmatter.description || '')}">`)
            )
            + extra
            + formGroup(opts.editContentLabel || 'Content', `<textarea id="${idp}-edit-content" rows="12">${escapeHtml(item.content || '')}</textarea>`),
          buttons: [{
            label: 'Save', primary: true, onClick: async () => {
              const fm = { ...item.frontmatter };
              fm.name = document.getElementById(`${idp}-edit-name`).value;
              fm.description = document.getElementById(`${idp}-edit-desc`).value;
              if (opts.readEditExtras) opts.readEditExtras(fm, idp);
              const invalid = opts.validate ? opts.validate(fm) : null;
              if (invalid) { toast(invalid, 'error'); return false; }
              const content = document.getElementById(`${idp}-edit-content`).value;
              try {
                await api(`${m._base()}/${keyValue}`, { method: 'PUT', body: { frontmatter: fm, content } });
                toast(opts.itemLabel + ' saved');
                m.load(m.slug !== null ? m.slug : undefined);
              } catch (e) { toast('Save failed: ' + e.message, 'error'); return false; }
            }
          }]
        });
      } catch (e) { toast('Could not load ' + opts.itemLabel.toLowerCase() + ': ' + e.message, 'error'); }
    },

    showCreate() {
      const idp = opts.idPrefix;
      openModal({
        title: 'Create ' + opts.itemLabel,
        body: opts.createFields(idp),
        buttons: [{
          label: 'Create', primary: true, onClick: async () => {
            const result = opts.createBody(idp);
            if (!result) return false;
            try {
              await api(`${m._base()}/${result.key}`, { method: 'PUT', body: { frontmatter: result.frontmatter, content: result.content } });
              toast(opts.itemLabel + ' created');
              m.load(m.slug !== null ? m.slug : undefined);
            } catch (e) { toast('Create failed: ' + e.message, 'error'); return false; }
          }
        }]
      });
    },

    async remove(keyValue) {
      if (!confirm(`Delete ${opts.itemLabel.toLowerCase()} "${keyValue}"?`)) return;
      try {
        await api(`${m._base()}/${keyValue}`, { method: 'DELETE' });
        toast('Deleted');
        m.load(m.slug !== null ? m.slug : undefined);
      } catch (e) { toast('Delete failed: ' + e.message, 'error'); }
    }
  };

  return m;
}
