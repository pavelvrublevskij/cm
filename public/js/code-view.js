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
    addCodeCopyButtons(container);
  },

  /**
   * Mount a code view in `host` and return an adapter with getValue()/refresh(), or null when
   * `host` is missing. Falls back to a plain textarea when the CodeMirror CDN is unavailable.
   * opts: { readOnly, onChange, onSave, trackChanges, changedLines }
   * trackChanges reserves a gutter + overview ruler for session-changed lines; changedLines is a
   * Set of 1-indexed line numbers to mark immediately (it may arrive later via setChangedLines).
   */
  mount(host, text, filePath, opts = {}) {
    if (!host) return null;

    if (typeof CodeMirror !== 'undefined') {
      const gutters = ['CodeMirror-linenumbers'];
      if (opts.trackChanges) gutters.push('sf-gutter-changes');
      const cm = CodeMirror(host, {
        value: text,
        mode: codeModeFor(filePath),
        lineNumbers: true,
        gutters,
        matchBrackets: true,
        styleActiveLine: true,
        indentUnit: 2,
        readOnly: !!opts.readOnly,
        extraKeys: opts.onSave ? { 'Ctrl-S': opts.onSave, 'Cmd-S': opts.onSave } : undefined
      });
      if (opts.onChange) cm.on('change', opts.onChange);
      if (opts.trackChanges && opts.changedLines) CodeView._applyChangeMarkers(cm, host, opts.changedLines);
      let searchMarks = [];
      return {
        getValue: () => cm.getValue(),
        refresh: () => cm.refresh(),
        setChangedLines: lines => CodeView._applyChangeMarkers(cm, host, lines),
        getViewState: () => {
          const cursor = cm.getCursor();
          return { cursor: { line: cursor.line, ch: cursor.ch }, scrollTop: cm.getScrollInfo().top };
        },
        setViewState: state => {
          if (!state) return;
          if (state.cursor) cm.setCursor(state.cursor);
          if (typeof state.scrollTop === 'number') cm.scrollTo(null, state.scrollTop);
        },
        highlightMatches: query => {
          const result = CodeView._highlightMatches(cm, searchMarks, query);
          searchMarks = result.marks;
          return result.count;
        }
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
      refresh: () => {},
      setChangedLines: () => {},
      getViewState: () => ({ selectionStart: ta.selectionStart, selectionEnd: ta.selectionEnd, scrollTop: ta.scrollTop }),
      setViewState: state => {
        if (!state) return;
        if (typeof state.selectionStart === 'number') { ta.selectionStart = state.selectionStart; ta.selectionEnd = state.selectionEnd; }
        if (typeof state.scrollTop === 'number') ta.scrollTop = state.scrollTop;
      },
      /** No CodeMirror, so no in-text highlight — just count and select the first hit. */
      highlightMatches: query => {
        if (!query) return 0;
        const lower = ta.value.toLowerCase();
        const q = query.toLowerCase();
        let count = 0, idx = 0, firstIdx = -1;
        while ((idx = lower.indexOf(q, idx)) !== -1) {
          if (firstIdx === -1) firstIdx = idx;
          count++;
          idx += q.length;
        }
        if (firstIdx !== -1) ta.setSelectionRange(firstIdx, firstIdx + query.length);
        return count;
      }
    };
  },

  /** Clear any previous search marks and highlight every occurrence of query, jumping to the first. */
  _highlightMatches(cm, prevMarks, query) {
    prevMarks.forEach(m => m.clear());
    if (!query) return { marks: [], count: 0 };
    const marks = [];
    const cursor = cm.getSearchCursor(query, { line: 0, ch: 0 }, { caseFold: true });
    let first = null;
    while (cursor.findNext()) {
      marks.push(cm.markText(cursor.from(), cursor.to(), { className: 'sf-search-match' }));
      if (!first) first = { from: cursor.from(), to: cursor.to() };
    }
    if (first) {
      cm.setSelection(first.from, first.to);
      cm.scrollIntoView(first, 100);
    }
    return { marks, count: marks.length };
  },

  /** Colour the gutter for each changed line and lay out matching ticks on an overview ruler. */
  _applyChangeMarkers(cm, host, changedLines) {
    const total = cm.lineCount();
    for (let i = 0; i < total; i++) cm.setGutterMarker(i, 'sf-gutter-changes', null);
    const existingRuler = host.querySelector('.sf-overview-ruler');
    if (existingRuler) existingRuler.remove();
    host.classList.remove('sf-has-ruler');

    if (!changedLines || !changedLines.size) {
      cm.refresh();
      return;
    }
    changedLines.forEach(line => {
      const idx = line - 1;
      if (idx < 0 || idx >= total) return;
      const marker = document.createElement('div');
      marker.className = 'sf-gutter-marker';
      cm.setGutterMarker(idx, 'sf-gutter-changes', marker);
    });

    const ruler = document.createElement('div');
    ruler.className = 'sf-overview-ruler';
    CodeView._buildRulerTicks(ruler, changedLines, total, cm);
    host.appendChild(ruler);
    host.classList.add('sf-has-ruler');
    cm.refresh();
  },

  /** Group consecutive changed lines into ranges so the ruler shows blocks, not a speckle of ticks. */
  _buildRulerTicks(ruler, changedLines, total, cm) {
    const sorted = [...changedLines].sort((a, b) => a - b);
    const ranges = [];
    for (const line of sorted) {
      const last = ranges[ranges.length - 1];
      if (last && line <= last.end + 1) last.end = Math.max(last.end, line);
      else ranges.push({ start: line, end: line });
    }
    ranges.forEach(r => {
      const tick = document.createElement('div');
      tick.className = 'sf-ruler-tick';
      tick.style.top = ((r.start - 1) / total * 100) + '%';
      tick.style.height = Math.max((r.end - r.start + 1) / total * 100, 0.8) + '%';
      tick.title = r.start === r.end ? `Line ${r.start}` : `Lines ${r.start}–${r.end}`;
      tick.addEventListener('click', () => {
        cm.setCursor(r.start - 1, 0);
        cm.scrollIntoView({ line: r.start - 1, ch: 0 }, 100);
        cm.focus();
      });
      ruler.appendChild(tick);
    });
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
