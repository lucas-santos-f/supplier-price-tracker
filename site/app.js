(function () {
  'use strict';

  const RAW = window.PRICE_DATA.raw;
  const SOURCES = window.PRICE_DATA.sources;
  const A = window.Analysis;
  const SVG = 'http://www.w3.org/2000/svg';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const COMMODITY = { copper: 'Copper', aluminum: 'Aluminum', zinc: 'Zinc', nickel: 'Nickel', iron_ore: 'Iron ore' };
  const SEVERITY = {
    high: { label: 'High', color: 'var(--critical)' },
    medium: { label: 'Medium', color: 'var(--serious)' },
    low: { label: 'Low', color: 'var(--warning)' },
  };

  const money = (v, digits = 2) => (v == null ? '–' : 'R$ ' + v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
  const signed = (v, unit = '%', digits = 1) => (v == null ? '–' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(digits) + unit);
  const monthLabel = (m, short) => {
    const [y, mo] = m.split('-').map(Number);
    return MONTHS[mo - 1] + ' ' + (short ? String(y).slice(2) : y);
  };

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === 'style') node.style.cssText = v;
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const child of children.flat()) {
      if (child == null) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function svg(tag, attrs, text) {
    const node = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    if (text != null) node.textContent = text;
    return node;
  }

  function lineKey(s) {
    return el('span', { class: 'key' + (s.dash ? ' ' + s.dash : ''), style: `border-top-color:${s.color}` });
  }

  function niceTicks(lo, hi, count) {
    if (lo === hi) { lo -= 1; hi += 1; }
    const raw = (hi - lo) / (count - 1);
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / pow;
    const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
    const ticks = [];
    for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + step / 2; v += step) {
      ticks.push(Number(v.toFixed(10)));
    }
    return ticks;
  }

  // Line chart with one y axis, a crosshair tooltip and direct labels at the line ends.
  function lineChart(host, opts) {
    host.textContent = '';
    const legend = el('div', { class: 'legend' }, opts.series.map((s) => el('span', { class: 'legend-item' }, lineKey(s), s.name)));
    const wrap = el('div', { class: 'chart-wrap', tabindex: 0, 'aria-label': opts.title + '. Use the left and right arrow keys to read each month.' });
    const tip = el('div', { class: 'tooltip', hidden: true, 'aria-live': 'polite' });
    host.append(legend, wrap);

    let state = null;

    function draw() {
      const W = Math.max(280, wrap.clientWidth);
      const narrow = W < 600;
      const H = narrow ? 240 : 310;
      const m = { l: 58, r: narrow ? 14 : 132, t: 10, b: 28 };
      const values = opts.series.flatMap((s) => s.values).filter((v) => v != null);
      const ticks = niceTicks(Math.min(...values), Math.max(...values), 5);
      const lo = ticks[0];
      const hi = ticks[ticks.length - 1];
      const n = opts.months.length;
      const x = (i) => m.l + ((W - m.l - m.r) * i) / (n - 1);
      const y = (v) => m.t + (H - m.t - m.b) * (1 - (v - lo) / (hi - lo));

      const root = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opts.title });
      for (const t of ticks) {
        root.append(svg('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), stroke: t === lo ? 'var(--axis)' : 'var(--grid)', 'stroke-width': 1 }));
        root.append(svg('text', { x: m.l - 8, y: y(t) + 4, 'text-anchor': 'end' }, opts.tick(t)));
      }
      const every = narrow ? 6 : 3;
      for (let i = n - 1; i >= 0; i -= every) {
        root.append(svg('text', { x: x(i), y: H - 8, 'text-anchor': 'middle' }, monthLabel(opts.months[i], true)));
      }

      const labels = [];
      for (const s of opts.series) {
        let d = '';
        let last = null;
        s.values.forEach((v, i) => {
          if (v == null) return;
          if (last == null) d += `M${x(i)},${y(v)}`;
          else if (s.step) d += `H${x(i)}V${y(v)}`;
          else d += `L${x(i)},${y(v)}`;
          last = { i, v };
        });
        if (!d) continue;
        const dash = s.dash === 'dashed' ? '6 4' : s.dash === 'dotted' ? '1 4' : null;
        const path = svg('path', { d, fill: 'none', stroke: s.color, 'stroke-width': s.dash === 'dotted' ? 2.5 : 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
        if (dash) path.setAttribute('stroke-dasharray', dash);
        root.append(path);
        labels.push({ s, y: y(last.v), x: x(last.i) });
      }

      if (!narrow) {
        labels.sort((a, b) => a.y - b.y);
        for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 15);
        const overflow = labels.length ? labels[labels.length - 1].y - (H - m.b) : 0;
        if (overflow > 0) labels.forEach((l) => (l.y -= overflow));
        for (const l of labels) {
          const lx = W - m.r + 10;
          root.append(svg('line', { x1: lx, x2: lx + 12, y1: l.y, y2: l.y, stroke: l.s.color, 'stroke-width': 2 }));
          root.append(svg('text', { x: lx + 17, y: l.y + 4, class: 'direct' }, l.s.short || l.s.name));
        }
      }

      const cross = svg('g', { visibility: 'hidden' });
      cross.append(svg('line', { y1: m.t, y2: H - m.b, stroke: 'var(--axis)', 'stroke-width': 1 }));
      const dots = opts.series.map((s) => {
        const dot = svg('circle', { r: 4, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2 });
        cross.append(dot);
        return dot;
      });
      root.append(cross);
      const hit = svg('rect', { x: m.l - 6, y: m.t, width: W - m.l - m.r + 12, height: H - m.t - m.b, fill: 'transparent' });
      root.append(hit);

      wrap.textContent = '';
      wrap.append(root, tip);
      state = { x, y, n, W, m, cross, dots, index: state ? state.index : null };

      hit.addEventListener('pointermove', (e) => {
        const box = root.getBoundingClientRect();
        const i = Math.round(((e.clientX - box.left - m.l) / (W - m.l - m.r)) * (n - 1));
        show(Math.max(0, Math.min(n - 1, i)));
      });
      hit.addEventListener('pointerleave', hide);
    }

    function show(i) {
      if (!state) return;
      state.index = i;
      const { x, y, cross, dots, W } = state;
      cross.setAttribute('visibility', 'visible');
      cross.firstChild.setAttribute('x1', x(i));
      cross.firstChild.setAttribute('x2', x(i));
      tip.textContent = '';
      tip.append(el('div', { class: 'when' }, monthLabel(opts.months[i])));
      opts.series.forEach((s, k) => {
        const v = s.values[i];
        dots[k].setAttribute('visibility', v == null ? 'hidden' : 'visible');
        if (v == null) return;
        dots[k].setAttribute('cx', x(i));
        dots[k].setAttribute('cy', y(v));
        const held = s.held && s.held[i];
        tip.append(el('div', { class: 'row' }, lineKey(s), el('strong', null, opts.format(v)), el('span', { class: 'name' }, s.name), held ? el('span', { class: 'held' }, 'held') : null));
      });
      tip.hidden = false;
      const left = x(i) + 14 + tip.offsetWidth > W ? x(i) - 14 - tip.offsetWidth : x(i) + 14;
      tip.style.left = Math.max(0, left) + 'px';
    }

    function hide() {
      if (!state) return;
      state.cross.setAttribute('visibility', 'hidden');
      tip.hidden = true;
    }

    wrap.addEventListener('keydown', (e) => {
      if (!state || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      e.preventDefault();
      const current = state.index == null ? state.n - 1 : state.index;
      show(Math.max(0, Math.min(state.n - 1, current + (e.key === 'ArrowRight' ? 1 : -1))));
    });
    wrap.addEventListener('focus', () => show(state && state.index != null ? state.index : opts.months.length - 1));
    wrap.addEventListener('blur', hide);

    draw();
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { draw(); hide(); });
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }

  function sparkline(values, color) {
    const W = 160;
    const H = 34;
    const pts = values.map((v, i) => [i, v]).filter((p) => p[1] != null);
    const lo = Math.min(...pts.map((p) => p[1]));
    const hi = Math.max(...pts.map((p) => p[1]));
    const x = (i) => 3 + ((W - 6) * i) / (values.length - 1);
    const y = (v) => 3 + (H - 6) * (1 - (v - lo) / (hi - lo || 1));
    const root = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' });
    root.append(svg('path', { d: pts.map((p, k) => (k ? 'L' : 'M') + x(p[0]) + ',' + y(p[1])).join(''), fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round' }));
    const last = pts[pts.length - 1];
    root.append(svg('circle', { cx: x(last[0]), cy: y(last[1]), r: 3, fill: color }));
    return root;
  }

  function statusIcon(severity) {
    const icon = svg('svg', { width: 14, height: 14, viewBox: '0 0 14 14', 'aria-hidden': 'true' });
    const color = SEVERITY[severity].color;
    if (severity === 'high') icon.append(svg('path', { d: 'M7 1 13 12H1Z', fill: color }));
    else if (severity === 'medium') icon.append(svg('rect', { x: 2, y: 2, width: 10, height: 10, rx: 2, fill: color }));
    else icon.append(svg('circle', { cx: 7, cy: 7, r: 5, fill: color }));
    return icon;
  }

  // --- state ---------------------------------------------------------------

  const KEY = { ws: 'supplypulse.workspace', keys: 'supplypulse.keys', series: 'supplypulse.series' };
  const store = {
    get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  };
  const clone = (x) => JSON.parse(JSON.stringify(x));

  function sampleWorkspace() {
    const web = RAW.web || {};
    const metal = [...new Set(RAW.quotes.map((q) => q.supplier))].sort();
    const pages = [...(web.quotes || []), ...(web.links || [])].map((q) => q.supplier);
    return {
      version: 1,
      mode: 'sample',
      items: clone(RAW.items).concat(clone(web.items || [])),
      suppliers: [...new Set(metal.concat(pages))],
      quotes: clone(RAW.quotes).concat(clone(web.quotes || [])),
      apis: [],
      links: clone(web.links || []),
    };
  }

  function loadWorkspace() {
    const ws = store.get(KEY.ws, null);
    if (!ws) return sampleWorkspace();
    if (!Array.isArray(ws.links)) ws.links = [];
    if (!Array.isArray(ws.apis)) ws.apis = [];
    return ws;
  }

  const state = {
    ws: loadWorkspace(),
    keys: store.get(KEY.keys, {}),
    series: store.get(KEY.series, {}), // {'bcb:433': {fetched, values: {month: value}}}
    saved: true,
  };

  // Built-in market table, with any newer USD/BRL and IGP-M fetched from Banco Central on top.
  function marketTable() {
    const market = clone(RAW.market);
    const put = (key, field) => {
      const s = state.series[key];
      if (!s) return;
      for (const [m, v] of Object.entries(s.values)) (market[m] = market[m] || {})[field] = v;
    };
    put('bcb:3698', 'usd_brl');
    put('bcb:189', 'igpm_pct');
    return market;
  }

  function seriesValues() {
    return Object.fromEntries(Object.entries(state.series).map(([k, s]) => [k, s.values]));
  }

  let D = null;
  let colorOf = () => 'var(--s1)';

  function recompute() {
    D = A.build(state.ws, marketTable(), seriesValues());
    // Colour follows the supplier in the order they were added, so it stays the same on every item and a new
    // supplier does not repaint the others. Past eight, one grey.
    const names = state.ws.suppliers;
    colorOf = (name) => { const i = names.indexOf(name); return i >= 0 && i < 8 ? `var(--s${i + 1})` : 'var(--muted)'; };
  }

  function commit(change, opts) {
    change(state.ws);
    state.ws.mode = 'custom';
    state.saved = store.set(KEY.ws, state.ws);
    renderAll();
    if (!opts || opts.setup !== false) setup.render();
    else setup.status();
  }

  function replaceWorkspace(ws) {
    state.ws = ws;
    if (ws.mode === 'sample') {
      try { localStorage.removeItem(KEY.ws); state.saved = true; } catch (e) { state.saved = false; }
    } else {
      state.saved = store.set(KEY.ws, ws);
    }
    renderAll();
    setup.render();
  }

  // --- page ---------------------------------------------------------------

  let selected = null;
  let mode = 'price';
  let disposeChart = null;
  const $ = (id) => document.getElementById(id);

  function renderHeader() {
    const marketNote = D.marketAsOf && D.marketAsOf < D.asOf ? ` Market data up to ${monthLabel(D.marketAsOf)}.` : '';
    $('asof').textContent = `Quotes up to ${monthLabel(D.asOf)}.${marketNote} ` +
      (state.ws.mode === 'sample' ? 'Showing the sample items and quotes.' : 'Showing your items and quotes, saved in this browser.');
    const saving = D.flags.reduce((sum, f) => sum + (f.saving_brl || 0), 0);
    const ig = D.igpmIndex;
    const igpm12 = ig[ig.length - 1] != null && ig[ig.length - 13] != null ? (ig[ig.length - 1] / ig[ig.length - 13]) * 100 - 100 : null;
    const tiles = [
      ['Possible saving, per year', money(saving, 0), 'switching the current supplier where a cheaper valid quote exists'],
      ['Open flags', String(D.flags.length), D.flags.filter((f) => f.severity === 'high').length + ' high'],
      ['USD/BRL', D.fx.last == null ? '–' : D.fx.last.toFixed(4), signed(D.fx.change_6m) + ' in 6 months'],
      ['IGP-M, 12 months', signed(igpm12), 'inflation reference for price reviews'],
    ];
    $('kpis').replaceChildren(...tiles.map(([label, value, sub]) =>
      el('div', { class: 'tile' }, el('div', { class: 'label' }, label), el('div', { class: 'value' }, value), el('div', { class: 'sub' }, sub))));
  }

  function renderFlags() {
    const byId = Object.fromEntries(D.items.map((i) => [i.id, i]));
    if (!D.flags.length) {
      $('flags').replaceChildren(el('li', { class: 'empty' }, 'Nothing needs attention with the quotes loaded.'));
      return;
    }
    $('flags').replaceChildren(...D.flags.map((f) => {
      const sev = SEVERITY[f.severity];
      const go = el('button', { type: 'button' }, f.item);
      go.addEventListener('click', () => {
        select(f.item);
        $('item-title').scrollIntoView({ behavior: 'smooth' });
      });
      return el('li', null,
        el('span', { class: 'status' }, statusIcon(f.severity), sev.label),
        el('div', null, el('span', { class: 'flag-item' }, go, ' · ' + (byId[f.item] ? byId[f.item].description : '')), el('div', null, f.message)));
    }));
  }

  function renderTabs() {
    if (!D.items.some((i) => i.id === selected)) selected = D.items.length ? D.items[0].id : null;
    $('item-tabs').replaceChildren(...D.items.map((item) => {
      const b = el('button', { type: 'button', 'data-item': item.id, 'aria-pressed': String(item.id === selected) }, item.id);
      b.addEventListener('click', () => select(item.id));
      return b;
    }));
  }

  // Price in force each month: the last quote carries until the next one.
  function inForce(values) {
    const out = [];
    const held = [];
    let last = null;
    let lastIndex = -1;
    values.forEach((v, i) => { if (v != null) lastIndex = i; });
    values.forEach((v, i) => {
      if (v != null) last = v;
      out.push(i <= lastIndex ? last : null);
      held.push(v == null && last != null && i <= lastIndex);
    });
    return { values: out, held };
  }

  function indexed(values) {
    const base = values.find((v) => v != null);
    return values.map((v) => (v == null || !base ? null : (v / base) * 100));
  }

  function renderItem() {
    const item = D.items.find((i) => i.id === selected);
    if (disposeChart) { disposeChart(); disposeChart = null; }
    if (!item) {
      $('item-name').textContent = 'No items yet';
      $('item-meta').textContent = 'Add items and quotes under "Your items, suppliers and price sources" above.';
      $('chart').replaceChildren();
      $('monthly').replaceChildren();
      $('suppliers').replaceChildren();
      return;
    }
    document.querySelectorAll('#item-tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.item === selected)));
    $('item-name').textContent = `${item.id} · ${item.description}`;
    const volume = item.annualVolume ? `Planned volume ${item.annualVolume.toLocaleString('en-US')} ${item.unit}/year. ` : '';
    $('item-meta').textContent = `Price per ${item.unit}. ${volume}Compared with: ${item.refDetail}. Current supplier: ${item.currentSupplier || 'not set'}.`;

    const series = Object.entries(item.prices).map(([name, raw]) => {
      const f = inForce(raw);
      return { name, color: colorOf(name), values: mode === 'index' ? indexed(f.values) : f.values, held: f.held, step: true };
    });
    if (item.refKind === 'cost') {
      series.push({ name: item.refLabel, short: item.refLabel === 'Material cost' ? 'Material' : item.refLabel, color: 'var(--ink-2)', dash: 'dashed', values: mode === 'index' ? indexed(item.material) : item.material });
    } else if (item.refKind === 'index' && mode === 'index') {
      series.push({ name: item.refLabel, color: 'var(--ink-2)', dash: 'dashed', values: indexed(item.material) });
    }
    if (mode === 'index') series.push({ name: 'IGP-M', color: 'var(--muted)', dash: 'dotted', values: D.igpmIndex });

    const digits = item.unit === 'pc' ? 3 : 2;
    const hasPrices = series.some((s) => s.values.some((v) => v != null) && s.step);
    if (!hasPrices) {
      $('chart').replaceChildren(el('p', { class: 'note' }, 'No quotes for this item in the last 24 months.'));
    } else {
      disposeChart = lineChart($('chart'), {
        title: `${item.description}: ${mode === 'index' ? 'indexed prices' : 'prices in BRL'} by month`,
        months: D.months,
        series,
        format: mode === 'index' ? (v) => v.toFixed(1) : (v) => money(v, digits),
        tick: mode === 'index' ? (v) => String(v) : (v) => 'R$' + (v >= 100 ? v.toFixed(0) : v.toFixed(digits === 3 ? 1 : 0)),
      });
    }
    $('ref-note').textContent = item.refKind === 'index'
      ? `${item.refLabel} is an index, so it shows in the indexed view only and the material share is not worked out.`
      : '';
    renderMonthly(item, digits);
    renderSuppliers(item, digits);
  }

  function renderMonthly(item, digits) {
    const names = Object.keys(item.prices);
    const refHead = item.refKind ? item.refLabel : null;
    const fmtRef = (v) => (item.refKind === 'cost' ? money(v, digits) : v == null ? '–' : v.toFixed(2));
    const head = el('tr', null, el('th', null, 'Month'), names.map((n) => el('th', { class: 'num' }, n)), refHead ? el('th', { class: 'num' }, refHead) : null);
    const rows = D.months.map((month, i) => el('tr', null,
      el('td', null, monthLabel(month)),
      names.map((n) => el('td', { class: 'num' }, item.prices[n][i] == null ? '' : money(item.prices[n][i], digits))),
      refHead ? el('td', { class: 'num' }, fmtRef(item.material[i])) : null));
    $('monthly').replaceChildren(el('thead', null, head), el('tbody', null, rows.reverse()));
  }

  function renderSuppliers(item, digits) {
    const cols = ['Supplier', 'Last quote', 'vs best', '6-mo change', 'Reference 6-mo', 'Gap', 'Material share', 'Lead time', 'Payment', 'Quoted'];
    const head = el('tr', null, cols.map((c, i) => el('th', { class: i ? 'num' : null }, c)));
    const days = (v) => (v == null ? '–' : v + ' d');
    const rows = item.table.map((r) => el('tr', { class: r.stale ? 'stale' : null },
      el('td', null, el('span', { class: 'key', style: `border-top-color:${colorOf(r.supplier)};margin-right:8px;vertical-align:middle` }), r.supplier,
        r.current ? el('span', { class: 'badge' }, 'current') : null, r.stale ? el('span', { class: 'badge' }, 'stale') : null),
      el('td', { class: 'num' }, money(r.price, digits)),
      el('td', { class: 'num' }, r.vs_best_pct ? signed(r.vs_best_pct) : r.stale ? '–' : 'best'),
      el('td', { class: 'num' }, signed(r.change_pct)),
      el('td', { class: 'num' }, signed(r.material_change_pct)),
      el('td', { class: 'num' }, signed(r.gap_pp, ' pp')),
      el('td', { class: 'num' }, r.material_share_pct == null ? '–' : r.material_share_pct.toFixed(0) + '%'),
      el('td', { class: 'num' }, days(r.lead_time_days)),
      el('td', { class: 'num' }, days(r.payment_days)),
      el('td', { class: 'num' }, monthLabel(r.quoted, true))));
    $('suppliers').replaceChildren(el('thead', null, head), el('tbody', null, rows.length ? rows : el('tr', null, el('td', { colspan: cols.length, class: 'note' }, 'No quotes yet.'))));
  }

  function renderMarkets() {
    const card = (name, value, t, color) => el('div', { class: 'market' },
      el('div', { class: 'name' }, name),
      el('div', { class: 'value' }, value),
      el('div', { class: 'meta' }, `3 mo ${signed(t.change_3m)} · 6 mo ${signed(t.change_6m)} · 12 mo ${signed(t.change_12m)}`),
      el('div', { class: 'meta' }, 'Trend: ' + (t.direction || 'n/a')),
      t.history.filter((v) => v != null).length > 1 ? sparkline(t.history, color) : null);
    const cards = D.market.map((t) => card(COMMODITY[t.key] || t.key, t.last == null ? '–' : money(t.last), t, 'var(--s1)'));
    const extra = D.extra.map((t) => card(t.name, t.last == null ? '–' : t.last.toLocaleString('en-US', { maximumFractionDigits: 2 }) + (t.unit && t.unit !== 'index' ? ' ' + t.unit : ''), t, 'var(--ink-2)'));
    $('markets').replaceChildren(...cards, ...extra);
    $('market-note').textContent = `Metals in BRL per kg, World Bank monthly averages converted at the Banco Central rate, up to ${monthLabel(D.marketAsOf)}.` +
      (extra.length ? ' Grey lines: the other price references your items use.' : '');
    $('sources').replaceChildren(...SOURCES.map((s) => el('li', null, el('a', { href: s.url }, s.name), ` (${s.license})`)));
  }

  function select(id) {
    selected = id;
    renderItem();
  }

  function renderAll() {
    recompute();
    renderHeader();
    renderFlags();
    renderTabs();
    renderItem();
    renderMarkets();
  }

  document.querySelectorAll('.seg button').forEach((b) => {
    b.addEventListener('click', () => {
      mode = b.dataset.mode;
      document.querySelectorAll('.seg button').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
      renderItem();
    });
  });

  const setup = window.Setup({ state, store, KEY, commit, replaceWorkspace, sampleWorkspace, renderAll, el, money, monthLabel, select });
  renderAll();
  setup.render();
})();
