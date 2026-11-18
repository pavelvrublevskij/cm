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
//   transferKind      - optional 'agents' | 'skills': adds Export/Import buttons and a per-card
//                       Export / Copy to… / Delete menu (/api/<kind>/export|import|copy/<scope>)

function makeFrontmatterCrud(opts) {
  const m = {
    list: [],
    slug: null,

    _base() { return typeof opts.apiBase === 'function' ? opts.apiBase() : opts.apiBase; },
    _scope() { return m.slug ? `project/${m.slug}` : 'global'; },

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
      const transferBar = opts.transferKind
        ? `<div style="display:flex;gap:8px;justify-content:flex-end;margin-bottom:12px">
            ${m.list.length ? `<button class="btn btn-sm" onclick="${opts.globalName}.exportItems()">Export all</button>` : ''}
            <button class="btn btn-sm" onclick="${opts.globalName}.triggerImport()">Import</button>
          </div>`
        : '';
      if (m.list.length === 0) {
        container.innerHTML = note + transferBar + (opts.emptyHtml || `<div class="empty-state"><p>${opts.emptyText || 'No items'}</p></div>`) + createBtn;
        return;
      }
      const key = opts.itemKey;
      const cards = m.list.map(item => {
        // A JS string literal inside a double-quoted attribute: names come from imported zips, so a
        // quote in one must not end the string (the browser decodes &quot; back before running it).
        const k = escapeAttr(JSON.stringify(String(item[key])));
        const actions = opts.transferKind
          ? `<div class="action-menu">
              <button class="btn btn-sm action-menu-btn" onclick="event.stopPropagation(); Sessions.toggleActionMenu(this)" aria-label="${opts.itemLabel} actions">&#8942;</button>
              <div class="action-menu-panel">
                <button class="action-menu-item" onclick="event.stopPropagation(); ${opts.globalName}.exportItems(${k})">Export</button>
                <button class="action-menu-item" onclick="event.stopPropagation(); ${opts.globalName}.showCopy(${k})">Copy to…</button>
                <button class="action-menu-item" onclick="event.stopPropagation(); ${opts.globalName}.remove(${k})">Delete</button>
              </div>
            </div>`
          : `<button class="prop-action-btn danger" onclick="event.stopPropagation(); ${opts.globalName}.remove(${k})">&#10005;</button>`;
        return `
        <div class="card" style="cursor:pointer" onclick="${opts.globalName}.edit(${k})">
          <div style="display:flex;justify-content:space-between;align-items:start">
            <div>
              <div style="font-weight:600;margin-bottom:4px">${opts.cardTitle(item)}</div>
              <div style="font-size:13px;color:var(--text-secondary)">${escapeHtml(item.description || '')}</div>
            </div>
            ${actions}
          </div>
        </div>
      `;
      }).join('');
      container.innerHTML = note + transferBar + '<div class="card-grid">' + cards + '</div>' + createBtn;
    },

    async edit(keyValue) {
      try {
        const item = opts.editFromList
          ? m.list.find(i => String(i[opts.itemKey]) === String(keyValue))
          : await api(`${m._base()}/${encodeURIComponent(keyValue)}`);
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
                await api(`${m._base()}/${encodeURIComponent(keyValue)}`, { method: 'PUT', body: { frontmatter: fm, content } });
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
        await api(`${m._base()}/${encodeURIComponent(keyValue)}`, { method: 'DELETE' });
        toast('Deleted');
        m.load(m.slug !== null ? m.slug : undefined);
      } catch (e) { toast('Delete failed: ' + e.message, 'error'); }
    },

    /** Download one item (keyValue) or, without it, every item in this scope as a zip. */
    async exportItems(keyValue) {
      document.querySelectorAll('.action-menu-panel.open').forEach(p => p.classList.remove('open'));
      try {
        const query = keyValue ? '?names=' + encodeURIComponent(keyValue) : '';
        const res = await fetch(`/api/${opts.transferKind}/export/${m._scope()}${query}`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || res.statusText);
        }
        const count = parseInt(res.headers.get('X-File-Count') || '0', 10);
        const url = URL.createObjectURL(await res.blob());
        const a = document.createElement('a');
        a.href = url;
        a.download = keyValue
          ? `${String(keyValue).replace(/\.md$/, '')}.zip`
          : `${opts.transferKind}-${m.slug ? decodeName(m.slug) : 'global'}-${new Date().toISOString().slice(0, 10)}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast(`Exported ${count} ${opts.itemLabel.toLowerCase()}${count === 1 ? '' : 's'}`);
      } catch (e) { toast('Export failed: ' + e.message, 'error'); }
    },

    triggerImport() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.zip,application/zip';
      input.onchange = () => {
        const file = input.files && input.files[0];
        if (!file) return;
        file.arrayBuffer().then(buf => m.doImport(buf, false))
          .catch(e => toast('Could not read file: ' + e.message, 'error'));
      };
      input.click();
    },

    async doImport(buffer, overwrite) {
      try {
        const res = await fetch(`/api/${opts.transferKind}/import/${m._scope()}?overwrite=${overwrite ? '1' : '0'}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/zip' },
          body: buffer
        });
        const data = await res.json();
        if (res.status === 409 && data.conflicts) {
          m._confirmOverwrite(data.conflicts, () => m.doImport(buffer, true));
          return;
        }
        if (!res.ok) throw new Error(data.error || res.statusText);
        toast(`Imported ${data.imported} ${opts.itemLabel.toLowerCase()}${data.imported === 1 ? '' : 's'}`);
        m.load(m.slug !== null ? m.slug : undefined);
      } catch (e) { toast('Import failed: ' + e.message, 'error'); }
    },

    /** Pick Global or another project and copy the item there. */
    showCopy(keyValue) {
      document.querySelectorAll('.action-menu-panel.open').forEach(p => p.classList.remove('open'));
      const targets = (m.slug ? [{ value: 'global', label: 'Global (~/.claude)' }] : [])
        .concat(Projects.data.filter(p => p.slug !== m.slug).map(p => ({ value: p.slug, label: p.path })));
      const idp = opts.idPrefix;
      openModal({
        title: `Copy ${opts.itemLabel}: ${keyValue}`,
        body: formGroup('Copy to', `<select id="${idp}-copy-target">${targets.map(t =>
          `<option value="${escapeHtml(t.value)}">${escapeHtml(t.label)}</option>`).join('')}</select>`),
        buttons: [{
          label: 'Copy', primary: true, onClick: () => {
            m.copyTo(keyValue, document.getElementById(`${idp}-copy-target`).value, false);
          }
        }]
      });
    },

    async copyTo(keyValue, target, overwrite) {
      try {
        const res = await fetch(`/api/${opts.transferKind}/copy/${m._scope()}/${encodeURIComponent(keyValue)}?overwrite=${overwrite ? '1' : '0'}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target })
        });
        const data = await res.json();
        if (res.status === 409 && data.conflicts) {
          m._confirmOverwrite(data.conflicts, () => m.copyTo(keyValue, target, true));
          return;
        }
        if (!res.ok) throw new Error(data.error || res.statusText);
        toast(opts.itemLabel + ' copied');
      } catch (e) { toast('Copy failed: ' + e.message, 'error'); }
    },

    _confirmOverwrite(conflicts, retry) {
      const list = conflicts.map(c => `<li><code>${escapeHtml(c)}</code></li>`).join('');
      openModal({
        title: `Overwrite existing ${opts.itemLabel.toLowerCase()}s?`,
        body: `<p>The following ${conflicts.length} ${opts.itemLabel.toLowerCase()}${conflicts.length === 1 ? '' : 's'} already exist and will be overwritten (backups are created):</p>
               <ul style="margin:8px 0 0 16px;max-height:200px;overflow:auto">${list}</ul>`,
        buttons: [{ label: 'Overwrite', danger: true, onClick: retry }]
      });
    }
  };

  return m;
}
