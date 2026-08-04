// --- Shared code viewer: split layout, CodeMirror mount, rendered preview ---
// Used by the session Files tab (editable) and the Scratchpad tab (read-only).

const CodeView = {
  PREVIEW_EXTS: ['md', 'markdown', 'html', 'htm'],
  STRUCTURE_WIDTH_KEY: 'claude-manager-files-structure-width',
  STRUCTURE_COLLAPSED_KEY: 'claude-manager-files-structure-collapsed',
  MIN_STRUCTURE_PX: 180,
  MIN_PANE_PX: 260,
  CLICK_THRESHOLD_PX: 4,

  /** Markdown and HTML have a rendered form worth showing beside the source. */
  isPreviewable(filePath) {
    return CodeView.PREVIEW_EXTS.includes(filePath.split('.').pop().toLowerCase());
  },

  /** Markdown renders inline; HTML renders in a sandboxed iframe so its scripts can't touch CM. */
  preview(container, text, filePath) {
    const lower = filePath.toLowerCase();
    if (lower.endsWith('.html') || lower.endsWith('.htm')) {
      container.innerHTML = `<iframe class="sf-preview-frame" sandbox srcdoc="${escapeHtml(text)}" title="Preview of ${escapeHtml(filePath)}"></iframe>`;
      return;
    }
    container.innerHTML = `<div class="sf-preview-pane markdown-body">${renderMarkdown(text)}</div>`;
  },

  /**
   * Mount a code view in `host` and return an adapter with getValue()/refresh(), or null when
   * `host` is missing. Falls back to a plain textarea when the CodeMirror CDN is unavailable.
   * opts: { readOnly, onChange, onSave }
   */
  mount(host, text, filePath, opts = {}) {
    if (!host) return null;

    if (typeof CodeMirror !== 'undefined') {
      const cm = CodeMirror(host, {
        value: text,
        mode: codeModeFor(filePath),
        lineNumbers: true,
        matchBrackets: true,
        styleActiveLine: true,
        indentUnit: 2,
        readOnly: !!opts.readOnly,
        extraKeys: opts.onSave ? { 'Ctrl-S': opts.onSave, 'Cmd-S': opts.onSave } : undefined
      });
      if (opts.onChange) cm.on('change', opts.onChange);
      return {
        getValue: () => cm.getValue(),
        refresh: () => cm.refresh()
      };
    }

    host.innerHTML = `<textarea class="sf-textarea" id="sf-textarea" spellcheck="false"${opts.readOnly ? ' readonly' : ''}></textarea>`;
    const ta = host.querySelector('#sf-textarea');
    ta.value = text;
    if (opts.onChange) ta.addEventListener('input', opts.onChange);
    if (opts.onSave) {
      ta.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
          e.preventDefault();
          opts.onSave();
        }
      });
    }
    return {
      getValue: () => ta.value,
      refresh: () => {}
    };
  },

  // --- split layout: resizable, collapsible structure column ---

  /** Apply the stored width and collapsed state to every split layout on the page. */
  applyState() {
    const width = localStorage.getItem(CodeView.STRUCTURE_WIDTH_KEY);
    const collapsed = localStorage.getItem(CodeView.STRUCTURE_COLLAPSED_KEY) === '1';
    document.querySelectorAll('.sf-layout').forEach(layout => {
      if (width) layout.style.setProperty('--sf-structure-width', width);
      layout.classList.toggle('sf-structure-collapsed', collapsed);
    });
  },

  toggleStructure(layout) {
    if (!layout) return;
    const collapsed = layout.classList.toggle('sf-structure-collapsed');
    localStorage.setItem(CodeView.STRUCTURE_COLLAPSED_KEY, collapsed ? '1' : '0');
    CodeView.applyState();
    CodeView._refreshEditors();
  },

  /** Drag the divider to resize; a click without movement toggles the column instead. */
  startDrag(ev) {
    ev.preventDefault();
    const layout = ev.target.closest('.sf-layout');
    if (!layout) return;
    const rect = layout.getBoundingClientRect();
    const startX = ev.clientX;
    const wasCollapsed = layout.classList.contains('sf-structure-collapsed');
    let dragMode = false;

    const onMove = e => {
      if (!dragMode && Math.abs(e.clientX - startX) > CodeView.CLICK_THRESHOLD_PX) {
        dragMode = true;
        if (wasCollapsed) layout.classList.remove('sf-structure-collapsed');
      }
      if (!dragMode) return;
      let px = e.clientX - rect.left;
      px = Math.max(CodeView.MIN_STRUCTURE_PX, Math.min(px, rect.width - CodeView.MIN_PANE_PX));
      layout.style.setProperty('--sf-structure-width', (px / rect.width * 100).toFixed(2) + '%');
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      if (!dragMode) {
        CodeView.toggleStructure(layout);
        return;
      }
      localStorage.setItem(CodeView.STRUCTURE_COLLAPSED_KEY, '0');
      const width = layout.style.getPropertyValue('--sf-structure-width');
      if (width) localStorage.setItem(CodeView.STRUCTURE_WIDTH_KEY, width.trim());
      CodeView.applyState();
      CodeView._refreshEditors();
    };

    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  },

  /** CodeMirror needs a nudge after its container changes size. */
  _refreshEditors() {
    if (typeof SessionFiles !== 'undefined' && SessionFiles.editor) SessionFiles.editor.refresh();
    if (typeof Sessions !== 'undefined' && Sessions._spEditor) Sessions._spEditor.refresh();
  }
};
