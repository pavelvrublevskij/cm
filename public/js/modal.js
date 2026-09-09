// --- Modal Factory ---

/**
 * Open a modal dialog.
 * @param {Object} opts
 * @param {string} opts.title - Modal title
 * @param {number} [opts.width] - Modal width in px
 * @param {string} opts.body - HTML string for the modal body
 * @param {Array} opts.buttons - Array of { label, primary?, danger?, onClick }
 * @param {Function} [opts.onClose] - Called after the modal is dismissed, however it was dismissed
 * @param {string} [opts.cancelLabel] - Label for the dismiss button (default "Cancel")
 * @param {boolean|{minWidth?: number, minHeight?: number}} [opts.resizable] - Adds a drag handle to resize the modal
 * @returns {HTMLElement} The overlay element (for external removal if needed)
 */
function openModal({ title, width, body, buttons = [], cls, onClose, cancelLabel, resizable }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const close = () => { overlay.remove(); if (onClose) onClose(); };

  const modal = document.createElement('div');
  modal.className = 'modal' + (cls ? ' ' + cls : '') + (resizable ? ' modal--resizable' : '');
  if (width) modal.style.width = width + 'px';

  const h3 = document.createElement('h3');
  h3.textContent = title;
  modal.appendChild(h3);

  const content = document.createElement('div');
  content.className = 'modal-body';
  content.innerHTML = body;
  modal.appendChild(content);

  const btnGroup = document.createElement('div');
  btnGroup.className = 'btn-group';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn';
  cancelBtn.textContent = cancelLabel || 'Cancel';
  cancelBtn.onclick = close;
  btnGroup.appendChild(cancelBtn);

  for (const { label, primary, danger, onClick } of buttons) {
    const btn = document.createElement('button');
    btn.className = 'btn' + (primary ? ' btn-primary' : '') + (danger ? ' btn-danger' : '');
    btn.textContent = label;
    btn.onclick = async () => {
      const result = await onClick();
      if (result !== false) close();
    };
    btnGroup.appendChild(btn);
  }

  modal.appendChild(btnGroup);
  if (resizable) addModalResizeHandle(modal, typeof resizable === 'object' ? resizable : {});
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  return overlay;
}

/** Drag-to-resize handle in the bottom-right corner. Requires the modal's class to set
 *  position: relative so the handle anchors to the modal box, not the viewport. */
function addModalResizeHandle(modal, { minWidth = 400, minHeight = 300 } = {}) {
  const handle = document.createElement('div');
  handle.className = 'modal-resize-handle';
  modal.appendChild(handle);
  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    const rect = modal.getBoundingClientRect();
    modal.style.position = 'fixed';
    modal.style.top = rect.top + 'px';
    modal.style.left = rect.left + 'px';
    modal.style.width = rect.width + 'px';
    modal.style.height = rect.height + 'px';
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = rect.width;
    const startH = rect.height;
    const onMove = e => {
      const newW = Math.max(minWidth, startW + (e.clientX - startX));
      const newH = Math.max(minHeight, startH + (e.clientY - startY));
      modal.style.width = newW + 'px';
      modal.style.height = newH + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      modal.style.position = '';
      modal.style.top = '';
      modal.style.left = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

/** Helper: create a form group with label + input HTML. */
function formGroup(label, inputHtml) {
  return `<div class="form-group"><label>${escapeHtml(label)}</label>${inputHtml}</div>`;
}

/** Helper: wrap form groups in a row. */
function formRow(...groups) {
  return `<div class="form-row">${groups.join('')}</div>`;
}

/** Helper: create a <select> element HTML from an array of options. */
function selectHtml(id, options, selected) {
  return `<select id="${id}">${options.map(o =>
    `<option value="${o}"${o === selected ? ' selected' : ''}>${o}</option>`
  ).join('')}</select>`;
}
