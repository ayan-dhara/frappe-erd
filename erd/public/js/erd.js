'use strict';

const LS_KEY = 'frappe_erd_state';

const MODULE_PALETTE = [
  '#6366f1','#8b5cf6','#ec4899','#ef4444','#f97316',
  '#eab308','#22c55e','#14b8a6','#06b6d4','#3b82f6',
  '#a855f7','#d946ef','#f43f5e','#84cc16','#10b981',
  '#0ea5e9','#f59e0b','#64748b',
];

const FIELD_COLORS = {
  'Link':               '#3b82f6',
  'Table':              '#8b5cf6',
  'Table MultiSelect':  '#8b5cf6',
  'Dynamic Link':       '#60a5fa',
  'Data':               '#94a3b8',
  'Small Text':         '#94a3b8',
  'Text':               '#94a3b8',
  'Long Text':          '#94a3b8',
  'Text Editor':        '#94a3b8',
  'Markdown Editor':    '#94a3b8',
  'Code':               '#94a3b8',
  'Password':           '#94a3b8',
  'Int':                '#f97316',
  'Float':              '#f97316',
  'Currency':           '#f97316',
  'Percent':            '#f97316',
  'Date':               '#14b8a6',
  'Datetime':           '#14b8a6',
  'Time':               '#14b8a6',
  'Duration':           '#14b8a6',
  'Check':              '#eab308',
  'Select':             '#ec4899',
  'Attach':             '#64748b',
  'Attach Image':       '#64748b',
  'Signature':          '#64748b',
  'Geolocation':        '#64748b',
  'Color':              '#64748b',
  'Rating':             '#64748b',
  'Autocomplete':       '#94a3b8',
};

const LAYOUT_TYPES = new Set([
  'Section Break','Column Break','Tab Break','HTML','Heading','HTML Editor','Fold','Page Break',
]);
const LINK_TYPES = new Set(['Link','Table','Table MultiSelect']);

function fieldColor(ft) { return FIELD_COLORS[ft] || '#64748b'; }

async function apiFetch(method, params = {}) {
  const url = new URL(`/api/method/${method}`, location.origin);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`${method} → ${res.status}`);
  return (await res.json()).message;
}

/* ─────────────────────────────────────────── */

class ERDApp {
  constructor() {
    this.modules      = [];          // ordered list of module names
    this.moduleColors = {};          // module → hex
    this.allDoctypes  = {};          // name → {name, module}
    this.schema       = {};          // name → schema with fields[]
    this.canvasNodes  = new Map();   // name → {x, y, el, expanded}
    this.transform    = { x: 0, y: 0, scale: 1 };
    this.showHidden   = false;
    this.search       = '';
    this.filterType   = 'all';   // 'all' | 'child' | 'non-child'
    this.collapsed    = new Set();
    this.checked      = new Set();
    this._pan         = null;
    this._drag        = null;
    this._didDrag     = false;
    this._hlNodes     = null;  // Set<string> | null
    this._hlEdge      = null;  // { src, tgt } | null

    this.$canvas   = document.getElementById('canvas');
    this.$nodes    = document.getElementById('nodes-layer');
    this.$edges    = document.getElementById('edges-layer');
    this.$xform    = document.getElementById('canvas-transform');
    this.$zoom     = document.getElementById('zoom-display');
    this.$loading  = document.getElementById('loading');
    this.$hint     = document.getElementById('canvas-hint');
    this.$modList  = document.getElementById('modules-list');
    this.$selCount = document.getElementById('selected-count');

    this._bindStatic();
    this.init();
  }

  /* ── Bootstrap ── */
  async init() {
    this._showLoading(true);
    try {
      this.modules = await apiFetch('erd.api.database.get_modules');
      this.modules.forEach((m, i) => {
        this.moduleColors[m] = MODULE_PALETTE[i % MODULE_PALETTE.length];
        this.collapsed.add(m);
      });
      const dts = await apiFetch('erd.api.database.get_doctypes');
      for (const dt of dts) this.allDoctypes[dt.name] = dt;

      const saved = this._loadState();
      if (saved) {
        for (const n of (saved.checked || [])) this.checked.add(n);
        this.showHidden = !!saved.showHidden;
        document.getElementById('btn-hidden').classList.toggle('active', this.showHidden);

        const toRestore = Object.keys(saved.canvas || {}).filter(n => this.allDoctypes[n]);
        if (toRestore.length) {
          const toFetch = toRestore.filter(n => !this.schema[n]);
          if (toFetch.length) {
            const chunk = await apiFetch('erd.api.database.get_schema', { doctypes: toFetch.join(',') });
            Object.assign(this.schema, chunk);
          }
          for (const name of toRestore) {
            if (this.schema[name]) {
              const { x, y } = saved.canvas[name];
              this._addNodeAt(name, x, y);
            }
          }
          this._drawEdges();
          this._updateHint();
          setTimeout(() => this._fitToScreen(), 80);
        }
      } else {
        // First visit: select all by default
        for (const name of Object.keys(this.allDoctypes)) this.checked.add(name);
      }

      this._renderSidebar();
    } catch (e) {
      console.error('ERD init failed', e);
    } finally {
      this._showLoading(false);
    }
  }

  /* ── Static event binding ── */
  _bindStatic() {
    document.getElementById('search-input').addEventListener('input', e => {
      this.search = e.target.value.trim();
      this._renderSidebar();
    });

    document.getElementById('filter-select').addEventListener('change', e => {
      this.filterType = e.target.value;
      this._renderSidebar();
    });
    document.getElementById('btn-load').addEventListener('click', () => this._loadSelected());

    // Module list delegation
    this.$modList.addEventListener('click', e => {
      // Module-level select-all checkbox
      if (e.target.dataset.modCb) {
        e.stopPropagation();
        return; // handled by change
      }
      const header = e.target.closest('.module-header');
      if (header) {
        const m = header.dataset.module;
        this.collapsed.has(m) ? this.collapsed.delete(m) : this.collapsed.add(m);
        this._renderSidebar();
        return;
      }
      if (e.target.type === 'checkbox') return; // handled by change
      const item = e.target.closest('.doctype-item');
      if (item) {
        const cb = item.querySelector('input[type=checkbox]');
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    this.$modList.addEventListener('change', e => {
      if (e.target.type !== 'checkbox') return;

      // Module-level bulk toggle
      if (e.target.dataset.modCb) {
        const mod = e.target.dataset.modCb;
        const dts = this._visibleDoctypesForModule(mod);
        dts.forEach(dt => e.target.checked ? this.checked.add(dt) : this.checked.delete(dt));
        this._updateSelCount();
        this.$modList.querySelectorAll(`input[data-dt]`).forEach(cb => {
          if (dts.includes(cb.dataset.dt)) {
            cb.checked = e.target.checked;
            cb.closest('.doctype-item')?.classList.toggle('checked', e.target.checked);
          }
        });
        this._saveState();
        return;
      }

      const dt = e.target.dataset.dt;
      e.target.checked ? this.checked.add(dt) : this.checked.delete(dt);
      this._updateSelCount();
      const item = e.target.closest('.doctype-item');
      if (item) item.classList.toggle('checked', e.target.checked);
      this._syncModuleCheckbox(e.target.closest('.module-section'));
      this._saveState();
    });

    // Toolbar buttons
    document.getElementById('btn-zoom-in').addEventListener('click',    () => this._zoom(1.2));
    document.getElementById('btn-zoom-out').addEventListener('click',   () => this._zoom(0.8));
    document.getElementById('btn-zoom-reset').addEventListener('click', () => { this.transform = { x: 0, y: 0, scale: 1 }; this._applyTransform(); });
    document.getElementById('btn-fit').addEventListener('click',        () => this._fitToScreen());
    document.getElementById('btn-auto-layout').addEventListener('click',() => this._autoLayout());
    document.getElementById('btn-clear').addEventListener('click',      () => this._clearCanvas());
    document.getElementById('btn-hidden').addEventListener('click', e => {
      this.showHidden = !this.showHidden;
      e.currentTarget.classList.toggle('active', this.showHidden);
      this._reRenderNodes();
      this._saveState();
    });

    // Canvas pan + click-to-clear highlight
    this.$canvas.addEventListener('mousedown', e => {
      if (e.target === this.$canvas || e.target.id === 'nodes-layer' || e.target.id === 'edges-layer' || e.target.id === 'canvas-transform') {
        this._pan = { sx: e.clientX, sy: e.clientY, tx: this.transform.x, ty: this.transform.y };
        this.$canvas.style.cursor = 'grabbing';
      }
    });
    this.$canvas.addEventListener('click', e => {
      if (e.target === this.$canvas || e.target.id === 'nodes-layer' || e.target.id === 'canvas-transform') {
        this._clearHighlight();
      }
    });
    document.addEventListener('mousemove', e => {
      if (this._pan) {
        this.transform.x = this._pan.tx + e.clientX - this._pan.sx;
        this.transform.y = this._pan.ty + e.clientY - this._pan.sy;
        this._applyTransform();
      }
      if (this._drag) {
        this._didDrag = true;
        const dx = (e.clientX - this._drag.mx) / this.transform.scale;
        const dy = (e.clientY - this._drag.my) / this.transform.scale;
        const n = this.canvasNodes.get(this._drag.name);
        n.x = this._drag.nx + dx;
        n.y = this._drag.ny + dy;
        n.el.style.left = n.x + 'px';
        n.el.style.top  = n.y + 'px';
        this._drawEdges();
      }
    });
    document.addEventListener('mouseup', () => {
      if (this._drag) {
        this.canvasNodes.get(this._drag.name)?.el.classList.remove('dragging');
        this._saveState();
      }
      this._pan = null;
      this._drag = null;
      this.$canvas.style.cursor = 'default';
    });

    // Wheel zoom
    this.$canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const rect = this.$canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const ns = Math.min(3, Math.max(0.08, this.transform.scale * factor));
      const r  = ns / this.transform.scale;
      this.transform.x = cx - r * (cx - this.transform.x);
      this.transform.y = cy - r * (cy - this.transform.y);
      this.transform.scale = ns;
      this._applyTransform();
    }, { passive: false });
  }

  /* ── Sidebar ── */
  _renderSidebar() {
    const q = this.search.toLowerCase();
    const grouped = {};
    for (const dt of Object.values(this.allDoctypes)) {
      if (!grouped[dt.module]) grouped[dt.module] = [];
      grouped[dt.module].push(dt);
    }

    let html = '';
    let anyVisible = false;

    for (const mod of this.modules) {
      const dts = (grouped[mod] || []).filter(dt =>
        (!q || dt.name.toLowerCase().includes(q)) && this._matchesFilter(dt)
      );
      if (!dts.length) continue;
      anyVisible = true;

      const color = this.moduleColors[mod] || '#64748b';
      const col   = this.collapsed.has(mod);

      const modDts    = dts.map(d => d.name);  // already filtered by search
      const selCount  = modDts.filter(n => this.checked.has(n)).length;
      const allSel    = selCount === modDts.length;
      const someSel   = selCount > 0 && !allSel;

      html += `<div class="module-section">
        <div class="module-header${col ? ' collapsed' : ''}" data-module="${_esc(mod)}">
          <input class="module-cb" type="checkbox" data-mod-cb="${_esc(mod)}"
            ${allSel ? 'checked' : ''} ${someSel ? 'data-indeterminate="1"' : ''}
            title="Select all in ${_esc(mod)}">
          <span class="module-dot" style="background:${color}"></span>
          <span class="module-name">${_esc(mod)}</span>
          <span class="module-count">${dts.length}</span>
          <span class="module-chevron">▾</span>
        </div>
        <div class="doctypes-list" style="display:${col ? 'none' : 'block'}">`;

      for (const dt of dts) {
        const onCanvas = this.canvasNodes.has(dt.name);
        const isChecked = this.checked.has(dt.name);
        html += `<label class="doctype-item${onCanvas ? ' on-canvas' : ''}${isChecked ? ' checked' : ''}">
          <input type="checkbox" data-dt="${_esc(dt.name)}"${isChecked ? ' checked' : ''}>
          <span class="doctype-label">${_esc(dt.name)}</span>
        </label>`;
      }

      html += `</div></div>`;
    }

    this.$modList.innerHTML = anyVisible ? html : `<div class="sidebar-empty">No doctypes match "${_esc(this.search)}"</div>`;
    // indeterminate can only be set via JS, not HTML
    this.$modList.querySelectorAll('.module-cb[data-indeterminate]').forEach(cb => { cb.indeterminate = true; });
    this._updateSelCount();
  }

  _updateSelCount() {
    const n = this.checked.size;
    this.$selCount.textContent = n ? `${n} selected` : '';
    document.getElementById('btn-load').disabled = n === 0;
  }

  /* ── Load Selected ── */
  async _loadSelected() {
    if (!this.checked.size) return;
    const toFetch = [...this.checked].filter(n => !this.schema[n]);
    this._showLoading(true);
    try {
      if (toFetch.length) {
        const chunk = await apiFetch('erd.api.database.get_schema', { doctypes: toFetch.join(',') });
        Object.assign(this.schema, chunk);
      }
      let added = 0;
      for (const name of this.checked) {
        if (!this.canvasNodes.has(name) && this.schema[name]) {
          this._addNodeAt(name, 0, 0);
          added++;
        }
      }
      if (added) this._computeLayout();
      this._updateHint();
      this._saveState();
      this._renderSidebar();
    } catch (e) {
      console.error('Load failed', e);
    } finally {
      this._showLoading(false);
    }
  }

  /* ── Canvas transform ── */
  _applyTransform() {
    this.$xform.style.transform = `translate(${this.transform.x}px,${this.transform.y}px) scale(${this.transform.scale})`;
    this.$zoom.textContent = Math.round(this.transform.scale * 100) + '%';
  }

  _zoom(f) {
    const rect = this.$canvas.getBoundingClientRect();
    const cx = rect.width / 2, cy = rect.height / 2;
    const ns = Math.min(3, Math.max(0.08, this.transform.scale * f));
    const r  = ns / this.transform.scale;
    this.transform.x = cx - r * (cx - this.transform.x);
    this.transform.y = cy - r * (cy - this.transform.y);
    this.transform.scale = ns;
    this._applyTransform();
  }

  _fitToScreen() {
    if (!this.canvasNodes.size) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of this.canvasNodes.values()) {
      const w = n.el.offsetWidth  || 240;
      const h = n.el.offsetHeight || 200;
      x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + w); y1 = Math.max(y1, n.y + h);
    }
    const pad = 60;
    const rect = this.$canvas.getBoundingClientRect();
    const cw = x1 - x0 + pad * 2;
    const ch = y1 - y0 + pad * 2;
    const sc = Math.min(rect.width / cw, rect.height / ch, 1.5);
    this.transform.scale = sc;
    this.transform.x = (rect.width  - cw * sc) / 2 - (x0 - pad) * sc;
    this.transform.y = (rect.height - ch * sc) / 2 - (y0 - pad) * sc;
    this._applyTransform();
  }

  /* ── Nodes ── */
  _addNodeAt(name, x, y) {
    const el = this._makeNodeEl(name, this.schema[name], x, y);
    this.$nodes.appendChild(el);
    this.canvasNodes.set(name, { x, y, el });
  }

  _makeNodeEl(name, schema, x, y) {
    const color  = this.moduleColors[schema.module] || '#6366f1';
    const fields = (schema.fields || []).filter(f =>
      !LAYOUT_TYPES.has(f.fieldtype) && (this.showHidden || !f.hidden)
    );
    const shown    = fields;
    const overflow = 0;

    const el = document.createElement('div');
    el.className = 'erd-node';
    el.dataset.doctype = name;
    el.style.cssText = `left:${x}px;top:${y}px`;

    const badges = [
      schema.istable      && 'child',
      schema.issingle     && 'single',
      schema.is_submittable && 'submit',
      schema.custom       && 'custom',
      schema.is_virtual   && 'virtual',
    ].filter(Boolean);

    const headerHtml = `
      <div class="node-header" style="background:${color}">
        <span class="node-title" title="${_esc(name)}">${_esc(name)}</span>
        <div class="node-badges">${badges.map(b => `<span class="node-badge">${b}</span>`).join('')}</div>
        <button class="node-close" data-close="${_esc(name)}" title="Remove">✕</button>
      </div>`;

    const fieldsHtml = shown.map(f => {
      const fc     = fieldColor(f.fieldtype);
      const isLink = LINK_TYPES.has(f.fieldtype);
      const arrow  = isLink && f.options
        ? `<span class="field-arrow" style="color:${fc}">→</span>` : '';
      return `<div class="node-field${isLink ? ' is-link' : ''}" data-fn="${_esc(f.fieldname)}" data-opts="${_esc(f.options||'')}">
        <span class="field-dot" style="background:${fc}"></span>
        <span class="field-name${f.reqd ? ' reqd' : ''}" title="${_esc(f.label||f.fieldname)}">${_esc(f.label||f.fieldname)}</span>
        <span class="field-type">${_esc(f.fieldtype)}</span>
        ${arrow}
      </div>`;
    }).join('');

    const overflowHtml = overflow > 0
      ? `<div class="node-overflow" data-expand="${_esc(name)}">▸ ${overflow} more field${overflow > 1 ? 's' : ''}…</div>`
      : '';

    el.innerHTML = `${headerHtml}<div class="node-fields">${fieldsHtml}</div>${overflowHtml}`;

    // Close
    el.querySelector('[data-close]').addEventListener('click', e => {
      e.stopPropagation();
      this._removeNode(name);
    });

    // Drag start
    el.addEventListener('mousedown', e => {
      if (e.target.closest('button')) return;
      e.stopPropagation();
      this._didDrag = false;
      el.classList.add('dragging', 'selected');
      const n = this.canvasNodes.get(name);
      this._drag = { name, mx: e.clientX, my: e.clientY, nx: n.x, ny: n.y };
    });

    // Node click → highlight all connections
    el.addEventListener('click', e => {
      if (this._didDrag || e.target.closest('button')) return;
      e.stopPropagation();

      // Click on a link/table field row → highlight that specific edge
      const fieldRow = e.target.closest('.node-field.is-link');
      if (fieldRow) {
        const tgt = fieldRow.dataset.opts;
        if (tgt && this.canvasNodes.has(tgt)) {
          this._hlNodes = new Set([name, tgt]);
          this._hlEdge  = { src: name, tgt };
          this._applyHighlight();
          return;
        }
      }

      // Click anywhere else on node → highlight all connected nodes + edges
      if (this._hlNodes?.has(name) && !this._hlEdge) {
        this._clearHighlight();
      } else {
        this._hlNodes = new Set([name]);
        this._hlEdge  = null;
        for (const p of this.$edges.querySelectorAll('path[data-src]')) {
          if (p.dataset.src === name || p.dataset.tgt === name) {
            this._hlNodes.add(p.dataset.src);
            this._hlNodes.add(p.dataset.tgt);
          }
        }
        this._applyHighlight();
      }
    });

    return el;
  }


  _removeNode(name) {
    this._clearHighlight();
    const n = this.canvasNodes.get(name);
    if (!n) return;
    n.el.remove();
    this.canvasNodes.delete(name);
    this.checked.delete(name);
    this._drawEdges();
    this._updateHint();
    this._saveState();
    this._renderSidebar();
  }

  _reRenderNodes() {
    for (const [name, n] of this.canvasNodes) {
      const fresh = this._makeNodeEl(name, this.schema[name], n.x, n.y);
      n.el.replaceWith(fresh);
      n.el = fresh;
    }
    this._drawEdges();
  }

  /* ── Edges ── */
  _drawEdges() {
    this.$edges.innerHTML = '';
    const seen = new Set();
    this._addArrowDefs();

    for (const [srcName, srcNode] of this.canvasNodes) {
      const schema = this.schema[srcName];
      if (!schema?.fields) continue;

      for (const f of schema.fields) {
        if (!LINK_TYPES.has(f.fieldtype) || !f.options) continue;
        const tgt = this.canvasNodes.get(f.options);
        if (!tgt) continue;

        const key = `${srcName}::${f.options}::${f.fieldname}`;
        if (seen.has(key)) continue;
        seen.add(key);

        this._drawEdge(srcNode, tgt, f, srcName);
      }
    }
    this._applyHighlight();
  }

  _addArrowDefs() {
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const mkMarker = (id, color) => {
      const m = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
      m.setAttribute('id', id);
      m.setAttribute('markerWidth', '8');
      m.setAttribute('markerHeight', '6');
      m.setAttribute('refX', '7');
      m.setAttribute('refY', '3');
      m.setAttribute('orient', 'auto');
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', 'M0,0 L0,6 L8,3 z');
      p.setAttribute('fill', color);
      m.appendChild(p);
      return m;
    };
    defs.appendChild(mkMarker('arr-link',  '#3b82f6'));
    defs.appendChild(mkMarker('arr-table', '#8b5cf6'));
    this.$edges.appendChild(defs);
  }

  _drawEdge(src, tgt, field, srcName) {
    const isTable = field.fieldtype !== 'Link';
    const color   = isTable ? '#8b5cf6' : '#3b82f6';
    const markId  = isTable ? 'arr-table' : 'arr-link';

    const sw = src.el.offsetWidth || 240;
    const tw = tgt.el.offsetWidth || 240;

    // Source Y: centre of the exact field row
    const fieldEl  = src.el.querySelector(`[data-fn="${CSS.escape(field.fieldname)}"]`);
    const srcFieldY = fieldEl
      ? fieldEl.offsetTop + fieldEl.offsetHeight / 2
      : src.el.offsetHeight / 2;

    // Target Y: centre of the header
    const headerEl  = tgt.el.querySelector('.node-header');
    const tgtHeaderY = headerEl
      ? headerEl.offsetTop + headerEl.offsetHeight / 2
      : 20;

    // Always: exit right edge of source field row → enter left edge of target header
    const x1 = src.x + sw,  y1 = src.y + srcFieldY;
    const x2 = tgt.x,       y2 = tgt.y + tgtHeaderY;

    const gap = Math.max(60, Math.abs(x2 - x1) * 0.45);
    const d = `M${x1},${y1} C${x1 + gap},${y1} ${x2 - gap},${y2} ${x2},${y2}`;

    const tgtName = field.options;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('opacity', '0.55');
    path.setAttribute('marker-end', `url(#${markId})`);
    path.setAttribute('pointer-events', 'stroke');
    path.dataset.src = srcName;
    path.dataset.tgt = tgtName;
    path.style.cursor = 'pointer';

    // Invisible fat stroke for easier clicking
    const hitPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hitPath.setAttribute('d', d);
    hitPath.setAttribute('fill', 'none');
    hitPath.setAttribute('stroke', 'transparent');
    hitPath.setAttribute('stroke-width', '12');
    hitPath.setAttribute('pointer-events', 'stroke');
    hitPath.dataset.src = srcName;
    hitPath.dataset.tgt = tgtName;
    hitPath.style.cursor = 'pointer';

    const handleEdgeClick = (e) => {
      e.stopPropagation();
      if (this._hlEdge?.src === srcName && this._hlEdge?.tgt === tgtName) {
        this._clearHighlight();
      } else {
        this._hlNodes = new Set([srcName, tgtName]);
        this._hlEdge  = { src: srcName, tgt: tgtName };
        this._applyHighlight();
      }
    };
    path.addEventListener('click', handleEdgeClick);
    hitPath.addEventListener('click', handleEdgeClick);

    const mx = (x1 + x2) / 2;
    const my = Math.min(y1, y2) - 5;
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', mx);
    label.setAttribute('y', my);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('fill', '#4a5580');
    label.setAttribute('font-size', '10');
    label.setAttribute('font-family', 'sans-serif');
    label.setAttribute('pointer-events', 'none');
    label.textContent = field.label || field.fieldname;

    this.$edges.appendChild(hitPath);
    this.$edges.appendChild(path);
    this.$edges.appendChild(label);
  }

  _doctypesForModule(mod) {
    return Object.values(this.allDoctypes)
      .filter(dt => dt.module === mod)
      .map(dt => dt.name);
  }

  _matchesFilter(dt) {
    if (this.filterType === 'child')     return !!dt.istable;
    if (this.filterType === 'non-child') return !dt.istable;
    return true;
  }

  _visibleDoctypesForModule(mod) {
    const q = this.search.toLowerCase();
    return Object.values(this.allDoctypes)
      .filter(dt => dt.module === mod &&
        (!q || dt.name.toLowerCase().includes(q)) &&
        this._matchesFilter(dt))
      .map(dt => dt.name);
  }

  _syncModuleCheckbox(section) {
    if (!section) return;
    const modCb = section.querySelector('.module-cb');
    if (!modCb) return;
    const mod    = modCb.dataset.modCb;
    const dts    = this._doctypesForModule(mod);
    const sel    = dts.filter(n => this.checked.has(n)).length;
    modCb.checked       = sel === dts.length;
    modCb.indeterminate = sel > 0 && sel < dts.length;
  }

  /* ── Highlight ── */
  _applyHighlight() {
    if (!this._hlNodes) {
      for (const [, n] of this.canvasNodes) n.el.classList.remove('erd-lit', 'erd-dim');
      this.$edges.querySelectorAll('path[data-src]').forEach(p => p.classList.remove('edge-lit', 'edge-dim'));
      return;
    }
    for (const [name, n] of this.canvasNodes) {
      n.el.classList.toggle('erd-lit', this._hlNodes.has(name));
      n.el.classList.toggle('erd-dim', !this._hlNodes.has(name));
    }
    for (const p of this.$edges.querySelectorAll('path[data-src]')) {
      const bothActive = this._hlNodes.has(p.dataset.src) && this._hlNodes.has(p.dataset.tgt);
      const lit = this._hlEdge
        ? (p.dataset.src === this._hlEdge.src && p.dataset.tgt === this._hlEdge.tgt)
        : bothActive;
      p.classList.toggle('edge-lit', lit);
      p.classList.toggle('edge-dim', !lit);
    }
  }

  _clearHighlight() {
    this._hlNodes = null;
    this._hlEdge  = null;
    this._applyHighlight();
  }

  /* ── Graph layout: topological columns, module-sorted rows ── */
  _computeLayout() {
    const names = [...this.canvasNodes.keys()];
    if (!names.length) return;

    const nodeSet = new Set(names);
    const fwd     = new Map(names.map(n => [n, new Set()]));
    const inDeg   = new Map(names.map(n => [n, 0]));
    const hasConn = new Set();

    for (const src of names) {
      for (const f of this.schema[src]?.fields || []) {
        if (!LINK_TYPES.has(f.fieldtype) || !f.options) continue;
        const tgt = f.options;
        if (!nodeSet.has(tgt) || tgt === src || fwd.get(src).has(tgt)) continue;
        fwd.get(src).add(tgt);
        inDeg.set(tgt, inDeg.get(tgt) + 1);
        hasConn.add(src);
        hasConn.add(tgt);
      }
    }

    // Isolated nodes (no edges to/from any other canvas node) → level 0, leftmost column
    const isolated  = names.filter(n => !hasConn.has(n));
    const connected = names.filter(n =>  hasConn.has(n));

    // Longest-path levels for connected nodes, starting at 1 (column 0 reserved for isolated)
    const level     = new Map(names.map(n => [n, 1]));
    const processed = new Set();
    const queue     = connected.filter(n => inDeg.get(n) === 0);
    queue.forEach(n => processed.add(n));

    while (queue.length) {
      const src = queue.shift();
      for (const tgt of fwd.get(src)) {
        level.set(tgt, Math.max(level.get(tgt), level.get(src) + 1));
        inDeg.set(tgt, inDeg.get(tgt) - 1);
        if (inDeg.get(tgt) === 0) { queue.push(tgt); processed.add(tgt); }
      }
    }

    // Cycle nodes go after the rest
    let next = Math.max(1, ...[...connected].map(n => level.get(n))) + 1;
    for (const n of connected) { if (!processed.has(n)) level.set(n, next++); }

    // Isolated nodes fixed at level 0
    for (const n of isolated) level.set(n, 0);

    // Group by level, sort within level by module then name
    const byLevel = new Map();
    for (const n of names) {
      const l = level.get(n);
      if (!byLevel.has(l)) byLevel.set(l, []);
      byLevel.get(l).push(n);
    }
    for (const ns of byLevel.values()) {
      ns.sort((a, b) => {
        const ma = this.schema[a]?.module || '';
        const mb = this.schema[b]?.module || '';
        return ma.localeCompare(mb) || a.localeCompare(b);
      });
    }

    const COL_W    = 480;
    const NODE_GAP = 48;
    const MOD_GAP  = 28;

    for (const [lvl, ns] of [...byLevel.entries()].sort(([a], [b]) => a - b)) {
      let y = 40, lastMod = null;
      for (const n of ns) {
        const mod = this.schema[n]?.module || '';
        if (lastMod !== null && mod !== lastMod) y += MOD_GAP;
        const node = this.canvasNodes.get(n);
        node.x = 40 + lvl * COL_W;
        node.y = y;
        node.el.style.left = node.x + 'px';
        node.el.style.top  = node.y + 'px';
        y += (node.el.offsetHeight || 200) + NODE_GAP;
        lastMod = mod;
      }
    }

    this._drawEdges();
    this._saveState();
    setTimeout(() => this._fitToScreen(), 80);
  }

  /* ── Helpers ── */
  _autoLayout() { this._computeLayout(); }

  _clearCanvas() {
    for (const n of this.canvasNodes.values()) n.el.remove();
    this.canvasNodes.clear();
    this.checked.clear();
    this.$edges.innerHTML = '';
    this._updateHint();
    this._saveState();
    this._renderSidebar();
  }

  _updateHint() {
    this.$hint.style.display = this.canvasNodes.size ? 'none' : 'flex';
  }

  _showLoading(v) {
    this.$loading.style.display = v ? 'flex' : 'none';
  }

  /* ── Persistence ── */
  _saveState() {
    const canvas = {};
    for (const [name, n] of this.canvasNodes) canvas[name] = { x: n.x, y: n.y };
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        checked:    [...this.checked],
        canvas,
        showHidden: this.showHidden,
      }));
    } catch (_) {}
  }

  _loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }
}

function _esc(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

document.addEventListener('DOMContentLoaded', () => { window._erd = new ERDApp(); });
