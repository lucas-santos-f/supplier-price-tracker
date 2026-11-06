// The "your data" panel: items, suppliers, price sources and quote import. Everything is kept in this
// browser (localStorage); API keys are stored apart from the data and never exported.
window.Setup = function (ctx) {
  'use strict';

  const A = window.Analysis;
  const C = window.Columns;
  const { state, store, KEY, commit, el, money, monthLabel } = ctx;
  const $ = (id) => document.getElementById(id);
  const TABS = [['items', 'Items'], ['suppliers', 'Suppliers'], ['sources', 'Price sources'], ['pages', 'Supplier pages'], ['quotes', 'Quotes']];
  const UNIT_OPTIONS = ['kg', 'pc', 'm', 'm2', 'L', 'set'];
  const SOURCE_TYPES = [['basket', 'Metal prices (World Bank)'], ['bcb', 'Banco Central series'], ['api', 'My API source'], ['none', 'Nothing']];
  const COMMON_SGS = [[433, 'IPCA'], [189, 'IGP-M'], [188, 'INPC'], [225, 'IPA-DI'], [3698, 'USD/BRL']];
  let tab = 'items';
  let pending = null; // spreadsheet being imported: {name, table, setup, read}
  let quoteFilter = '';

  C.KINDS.quotes = {
    label: 'Quotes',
    fields: [
      { key: 'month', label: 'Month or date', type: 'date', required: true,
        aliases: ['month', 'date', 'quotedate', 'quotemonth', 'period', 'mes', 'data', 'datacotacao', 'competencia', 'periodo', 'mesref'] },
      { key: 'supplier', label: 'Supplier', type: 'text', required: true,
        aliases: ['supplier', 'vendor', 'suppliername', 'vendorname', 'fornecedor', 'nomefornecedor', 'razaosocial'] },
      { key: 'item', label: 'Item code', type: 'text', id: true, required: true,
        aliases: ['item', 'itemcode', 'itemid', 'sku', 'partnumber', 'partno', 'code', 'codigo', 'codigoitem', 'coditem', 'material', 'produto', 'product'] },
      { key: 'description', label: 'Item description', type: 'text',
        aliases: ['description', 'itemdescription', 'productname', 'descricao', 'descricaoitem', 'nomeproduto'] },
      { key: 'price', label: 'Unit price (BRL)', type: 'amount', required: true,
        aliases: ['unitprice', 'unitpricebrl', 'price', 'priceperunit', 'unitcost', 'cost', 'preco', 'precounitario', 'valorunitario', 'vlunitario', 'custo', 'valor'] },
      { key: 'leadTime', label: 'Lead time (days)', type: 'amount',
        aliases: ['leadtime', 'leadtimedays', 'deliverydays', 'delivery', 'prazoentrega', 'prazodeentrega', 'entrega', 'prazo'] },
      { key: 'payment', label: 'Payment (days)', type: 'amount',
        aliases: ['paymentdays', 'paymentterms', 'payment', 'terms', 'prazopagamento', 'condicaopagamento', 'condpagamento', 'pagamento'] },
      { key: 'moq', label: 'Minimum order', type: 'amount',
        aliases: ['moq', 'minimumorder', 'minorder', 'minimumorderquantity', 'loteminimo', 'pedidominimo', 'qtdminima', 'quantidademinima'] },
    ],
  };

  const ws = () => state.ws;
  const uid = () => Math.random().toString(36).slice(2, 8);
  const num = (v) => (v === '' || v == null ? null : Number(v));
  // "28", "28 days", "30/60/90" -> 28, 28, 60
  const days = (v) => {
    const n = String(v == null ? '' : v).match(/\d+(?:[.,]\d+)?/g);
    return n ? Math.round(n.reduce((s, x) => s + Number(x.replace(',', '.')), 0) / n.length) : null;
  };

  function input(attrs, onChange) {
    const node = el('input', attrs);
    node.addEventListener('change', () => onChange(node));
    return node;
  }

  function select(options, value, attrs, onChange) {
    const node = el('select', attrs, options.map(([v, label]) => el('option', { value: v, selected: String(v) === String(value) }, label)));
    node.addEventListener('change', () => onChange(node.value, node));
    return node;
  }

  function button(label, onClick, attrs) {
    const node = el('button', Object.assign({ type: 'button', class: 'btn' }, attrs || {}), label);
    node.addEventListener('click', onClick);
    return node;
  }

  function download(name, data, type) {
    const url = URL.createObjectURL(new Blob([data], { type: type || 'text/csv;charset=utf-8' }));
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------------------------------------------------------------- items

  function itemsTab() {
    const supplierOpts = [['', 'Not set'], ...ws().suppliers.map((s) => [s, s])];
    const apiOpts = ws().apis.map((a) => [a.id, a.name || 'Unnamed API']);
    const rows = ws().items.map((item, index) => {
      const err = el('div', { class: 'field-error', role: 'alert' });
      const at = (fn, opts) => commit((w) => fn(w.items[index], w), opts);
      const idInput = input({ type: 'text', value: item.id, 'aria-label': 'Item ID', class: 'w-id' }, (n) => {
        const id = n.value.trim();
        if (!id) { n.value = item.id; return; }
        if (ws().items.some((x, i) => i !== index && x.id === id)) { err.textContent = `${id} is already used.`; n.value = item.id; return; }
        const old = item.id;
        at((it, w) => { it.id = id; w.quotes.forEach((q) => { if (q.item === old) q.item = id; }); });
        ctx.select(id);
      });
      const desc = input({ type: 'text', value: item.description, 'aria-label': 'Description', class: 'w-desc' }, (n) => at((it) => { it.description = n.value; }, { setup: false }));
      const unit = select(UNIT_OPTIONS.map((u) => [u, u]), item.unit, { 'aria-label': 'Unit' }, (v) => at((it) => { it.unit = v; }, { setup: false }));
      const kg = input({ type: 'number', min: 0, step: 'any', value: item.kgPerUnit, 'aria-label': 'kg per unit', class: 'w-num' }, (n) => at((it) => { it.kgPerUnit = num(n.value) || 0; }, { setup: false }));
      const vol = input({ type: 'number', min: 0, step: 'any', value: item.annualVolume, 'aria-label': 'Volume per year', class: 'w-num' }, (n) => at((it) => { it.annualVolume = num(n.value) || 0; }, { setup: false }));
      const cur = select(supplierOpts, item.currentSupplier, { 'aria-label': 'Current supplier' }, (v) => at((it) => { it.currentSupplier = v; }, { setup: false }));
      const type = select(SOURCE_TYPES, item.source.type, { 'aria-label': 'Compared with' }, (v) => {
        at((it) => {
          if (v === 'basket') it.source = { type: 'basket', basket: it.source.basket || {} };
          else if (v === 'bcb') it.source = { type: 'bcb', series: it.source.series || 433 };
          else if (v === 'api') it.source = { type: 'api', api: (ws().apis[0] || {}).id || '' };
          else it.source = { type: 'none' };
        });
        const code = ws().items[index].source.series;
        if (v === 'bcb' && !state.series['bcb:' + code]) fetchBcb(code).then(render, render);
      });
      let detail;
      if (item.source.type === 'basket') {
        detail = input({ type: 'text', value: A.basketText(item.source.basket), 'aria-label': 'Metal in one tonne of product', placeholder: 'copper:0.62; zinc:0.38', class: 'w-basket' }, (n) => {
          try {
            const basket = A.parseBasket(n.value);
            err.textContent = '';
            at((it) => { it.source.basket = basket; }, { setup: false });
          } catch (e) { err.textContent = e.message; }
        });
      } else if (item.source.type === 'bcb') {
        const code = input({ type: 'number', min: 1, step: 1, value: item.source.series, 'aria-label': 'SGS series code', class: 'w-code', list: 'sgs-list' }, (n) => {
          const v = Math.round(num(n.value));
          if (!v) return;
          at((it) => { it.source = { type: 'bcb', series: v }; });
          fetchBcb(v).then(render, render);
        });
        const s = state.series['bcb:' + item.source.series];
        const kind = select([['level', 'level or index'], ['pct', '% per month']], A.isPctSeries(item.source) ? 'pct' : 'level', { 'aria-label': 'The series is' },
          (v) => at((it) => { it.source.pct = v === 'pct'; }, { setup: false }));
        detail = el('span', { class: 'inline' }, 'SGS ', code, ' ', kind, el('span', { class: 'note' }, ' ' + (A.SGS_NAMES[item.source.series] || '') + (s ? '' : ' · not fetched yet')));
      } else if (item.source.type === 'api') {
        detail = apiOpts.length
          ? select(apiOpts, item.source.api, { 'aria-label': 'API source' }, (v) => at((it) => { it.source.api = v; }, { setup: false }))
          : el('span', { class: 'note' }, 'Add one under Price sources');
      } else {
        detail = el('span', { class: 'note' }, 'Quotes are only compared with each other');
      }
      const del = button('Delete', () => {
        const count = ws().quotes.filter((q) => q.item === item.id).length;
        if (count && !window.confirm(`Delete ${item.id} and its ${count} quotes?`)) return;
        commit((w) => { w.items.splice(index, 1); w.quotes = w.quotes.filter((q) => q.item !== item.id); });
      }, { class: 'link', 'aria-label': `Delete ${item.id}` });
      return el('tr', null, el('td', null, idInput, err), el('td', null, desc), el('td', null, unit), el('td', null, kg), el('td', null, vol),
        el('td', null, cur), el('td', null, type, el('div', { class: 'detail' }, detail)), el('td', null, del));
    });
    const add = button('Add item', () => {
      let n = ws().items.length + 1;
      while (ws().items.some((i) => i.id === 'ITEM-' + n)) n++;
      commit((w) => w.items.push({ id: 'ITEM-' + n, description: 'New item', unit: 'pc', kgPerUnit: 1, annualVolume: 0, currentSupplier: '', source: { type: 'none' } }));
    });
    return [
      el('p', { class: 'note' }, 'Metal prices: tonnes of each metal in one tonne of product, e.g. brass "copper:0.62; zinc:0.38", and the weight of one unit in kg. ' +
        'Banco Central: any monthly SGS series code, e.g. 433 for IPCA; inflation series come as % per month and are compounded into an index. Changes are saved as you leave each field.'),
      el('div', { class: 'table-wrap' }, el('table', { class: 'edit' },
        el('thead', null, el('tr', null, ['Item ID', 'Description', 'Unit', 'kg per unit', 'Volume / year', 'Current supplier', 'Compared with', ''].map((h) => el('th', null, h)))),
        el('tbody', null, rows.length ? rows : el('tr', null, el('td', { colspan: 8, class: 'note' }, 'No items yet.'))))),
      el('datalist', { id: 'sgs-list' }, COMMON_SGS.map(([c, n]) => el('option', { value: c }, n))),
      el('div', { class: 'controls' }, add),
    ];
  }

  // ---------------------------------------------------------------- suppliers

  function suppliersTab() {
    const rows = ws().suppliers.map((name, index) => {
      const quotes = ws().quotes.filter((q) => q.supplier === name);
      const items = new Set(quotes.map((q) => q.item));
      const err = el('div', { class: 'field-error', role: 'alert' });
      const nameInput = input({ type: 'text', value: name, 'aria-label': 'Supplier name', class: 'w-desc' }, (n) => {
        const v = n.value.trim();
        if (!v || v === name) { n.value = name; return; }
        if (ws().suppliers.includes(v)) { err.textContent = `${v} is already listed.`; n.value = name; return; }
        commit((w) => {
          w.suppliers[index] = v;
          w.quotes.forEach((q) => { if (q.supplier === name) q.supplier = v; });
          w.items.forEach((i) => { if (i.currentSupplier === name) i.currentSupplier = v; });
        });
      });
      const del = button('Delete', () => {
        if (quotes.length && !window.confirm(`Delete ${name} and its ${quotes.length} quotes?`)) return;
        commit((w) => {
          w.suppliers.splice(index, 1);
          w.quotes = w.quotes.filter((q) => q.supplier !== name);
          w.items.forEach((i) => { if (i.currentSupplier === name) i.currentSupplier = ''; });
        });
      }, { class: 'link', 'aria-label': `Delete ${name}` });
      return el('tr', null, el('td', null, el('span', { class: 'key', style: `border-top-color:var(--s${index < 8 ? index + 1 : 1})` }), ' ', nameInput, err),
        el('td', { class: 'num' }, String(quotes.length)), el('td', null, [...items].join(', ') || '–'), el('td', null, del));
    });
    const newName = el('input', { type: 'text', placeholder: 'Supplier name', 'aria-label': 'New supplier name', class: 'w-desc' });
    const err = el('span', { class: 'field-error', role: 'alert' });
    const add = button('Add supplier', () => {
      const v = newName.value.trim();
      if (!v) return;
      if (ws().suppliers.includes(v)) { err.textContent = `${v} is already listed.`; return; }
      commit((w) => { w.suppliers.push(v); });
    });
    return [
      el('div', { class: 'table-wrap' }, el('table', { class: 'edit' },
        el('thead', null, el('tr', null, el('th', null, 'Supplier'), el('th', { class: 'num' }, 'Quotes'), el('th', null, 'Items quoted'), el('th', null, ''))),
        el('tbody', null, rows.length ? rows : el('tr', null, el('td', { colspan: 4, class: 'note' }, 'No suppliers yet.'))))),
      el('div', { class: 'controls' }, newName, add, err),
      el('p', { class: 'note' }, 'Suppliers in an imported spreadsheet are added here on their own.'),
    ];
  }

  // ---------------------------------------------------------------- price sources

  const today = () => new Date().toISOString().slice(0, 10);
  const brDate = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);

  async function fetchBcb(code) {
    const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${Number(code)}/dados?formato=json&dataInicial=01/01/2022&dataFinal=${brDate(today())}`;
    let res;
    try { res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(60000) }); } catch (e) { throw new Error('No answer from Banco Central, which is sometimes slow or busy. Try again in a minute.'); }
    if (!res.ok) throw new Error(`Banco Central answered ${res.status}. Check the series code.`);
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) throw new Error('Banco Central sent no values for this series.');
    const values = A.monthly(rows.map((r) => ({ date: C.parseDateValue(r.data, 'DMY'), value: Number(String(r.valor).replace(',', '.')) })));
    state.series['bcb:' + code] = { fetched: today(), values };
    store.set(KEY.series, state.series);
    ctx.renderAll();
    return values;
  }

  function pathGet(obj, path) {
    if (!path) return obj;
    return String(path).split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }

  async function fetchApi(api) {
    let url = String(api.url || '').trim().replace('{start}', '2022-01-01').replace('{end}', today());
    if (!/^https:\/\//i.test(url)) throw new Error('Use an https:// address.');
    const key = state.keys[api.id];
    const headers = {};
    if (key && api.keyIn === 'header') headers[api.keyName || 'X-API-Key'] = key;
    if (key && api.keyIn !== 'header') {
      const u = new URL(url);
      u.searchParams.set(api.keyName || 'api_key', key);
      url = u.toString();
    }
    let res;
    try { res = await fetch(url, { headers, credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(60000) }); } catch (e) {
      throw new Error('The request was blocked or got no answer. Some APIs do not accept requests from a web page.');
    }
    if (!res.ok) throw new Error(`The API answered ${res.status}${res.status === 401 || res.status === 403 ? ' (check the key)' : ''}.`);
    const json = await res.json();
    const list = pathGet(json, api.path);
    if (list == null || typeof list !== 'object') throw new Error(`Nothing found at "${api.path || '(top level)'}".`);
    const points = Array.isArray(list)
      ? list.map((o) => ({ date: C.parseDateValue(pathGet(o, api.dateField), 'DMY'), value: C.parseAmountValue(pathGet(o, api.valueField)) }))
      : Object.entries(list).map(([d, v]) => ({ date: C.parseDateValue(d, 'DMY'), value: C.parseAmountValue(v && typeof v === 'object' ? pathGet(v, api.valueField) : v) }));
    const values = A.monthly(points);
    if (!Object.keys(values).length) throw new Error('No dated values found. Check the date and value fields.');
    state.series['api:' + api.id] = { fetched: today(), values };
    store.set(KEY.series, state.series);
    ctx.renderAll();
    return values;
  }

  function describe(values) {
    const months = Object.keys(values || {}).sort();
    if (!months.length) return 'no values';
    const last = months[months.length - 1];
    return `${months.length} months, last ${monthLabel(last)}: ${values[last].toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
  }

  function runFetch(btn, out, job) {
    btn.disabled = true;
    out.textContent = 'Fetching…';
    out.className = 'note';
    job().then((values) => { out.textContent = 'Updated: ' + describe(values) + '.'; })
      .catch((e) => { out.textContent = e.message; out.className = 'field-error'; })
      .finally(() => { btn.disabled = false; });
  }

  function sourcesTab() {
    const market = RAWMARKET();
    const lastFx = A.latestMonth(market, ['usd_brl']);
    const lastWb = A.latestMonth(market, ['copper']);
    const fxOut = el('span', { class: 'note', role: 'status' });
    const fxBtn = button('Update from Banco Central', () => runFetch(fxBtn, fxOut, async () => { await fetchBcb(189); return fetchBcb(3698); }));

    const used = [...new Set(ws().items.filter((i) => i.source.type === 'bcb').map((i) => i.source.series))];
    const bcbRows = used.map((code) => {
      const out = el('span', { class: 'note', role: 'status' }, state.series['bcb:' + code] ? describe(state.series['bcb:' + code].values) : 'not fetched yet');
      const btn = button('Fetch', () => runFetch(btn, out, () => fetchBcb(code)));
      return el('li', null, el('strong', null, `SGS ${code}`), ` ${A.SGS_NAMES[code] || ''} `, btn, ' ', out);
    });

    const apiCards = ws().apis.map((api, index) => {
      const at = (fn) => commit((w) => fn(w.apis[index]), { setup: false });
      const field = (label, key, attrs) => el('label', null, label, input(Object.assign({ type: 'text', value: api[key] || '' }, attrs || {}), (n) => at((a) => { a[key] = n.value.trim(); })));
      const keyInput = input({ type: 'password', value: state.keys[api.id] || '', autocomplete: 'off', placeholder: 'only if the API needs one' }, (n) => {
        if (n.value) state.keys[api.id] = n.value; else delete state.keys[api.id];
        store.set(KEY.keys, state.keys);
      });
      const out = el('span', { class: 'note', role: 'status' }, state.series['api:' + api.id] ? describe(state.series['api:' + api.id].values) : 'not fetched yet');
      const btn = button('Fetch now', () => runFetch(btn, out, () => fetchApi(ws().apis[index])));
      const del = button('Delete', () => {
        if (!window.confirm(`Delete the API source "${api.name}"? Items that use it will compare with nothing.`)) return;
        delete state.keys[api.id];
        store.set(KEY.keys, state.keys);
        delete state.series['api:' + api.id];
        store.set(KEY.series, state.series);
        commit((w) => {
          w.apis.splice(index, 1);
          w.items.forEach((i) => { if (i.source.type === 'api' && i.source.api === api.id) i.source = { type: 'none' }; });
        });
      }, { class: 'link' });
      return el('fieldset', { class: 'api' },
        el('legend', null, api.name || 'API source'),
        el('div', { class: 'api-grid' },
          field('Name', 'name'),
          field('Address (https)', 'url', { placeholder: 'https://api.example.com/v1/prices?symbol=HRC&from={start}&to={end}', class: 'wide' }),
          el('label', null, 'API key', keyInput),
          el('label', null, 'Send the key as', select([['query', 'query parameter'], ['header', 'request header']], api.keyIn || 'query', null, (v) => at((a) => { a.keyIn = v; }))),
          field('Parameter or header name', 'keyName', { placeholder: 'api_key or X-API-Key' }),
          field('Path to the list', 'path', { placeholder: 'data.prices (empty = top level)' }),
          field('Date field', 'dateField', { placeholder: 'date' }),
          field('Value field', 'valueField', { placeholder: 'value' }),
          el('label', null, 'Unit of the values', select(Object.entries(A.UNITS), api.unit || 'index', null, (v) => at((a) => { a.unit = v; })))),
        el('div', { class: 'controls' }, btn, del, out));
    });
    const addApi = button('Add API source', () => commit((w) => w.apis.push({ id: uid(), name: 'API ' + (w.apis.length + 1), url: '', keyIn: 'query', keyName: '', path: '', dateField: 'date', valueField: 'value', unit: 'index' })));

    return [
      el('h3', null, 'Built in'),
      el('ul', { class: 'plain' },
        el('li', null, el('strong', null, 'World Bank Pink Sheet: '), `copper, aluminum, zinc, nickel and iron ore, monthly averages in USD per tonne, up to ${monthLabel(lastWb)}. Updated when the page is rebuilt.`),
        el('li', null, el('strong', null, 'Banco Central do Brasil: '), `USD/BRL (SGS 3698) and IGP-M (SGS 189), up to ${monthLabel(lastFx)}. `, fxBtn, ' ', fxOut)),
      el('h3', null, 'Banco Central series used by your items'),
      bcbRows.length ? el('ul', { class: 'plain' }, bcbRows) : el('p', { class: 'note' }, 'None yet. Pick "Banco Central series" for an item under Items.'),
      el('h3', null, 'My API sources'),
      el('p', { class: 'note' }, 'Any JSON API with dated prices or an index, such as a steel or resin price service you subscribe to. ' +
        'Use only APIs whose terms allow this. The key is kept in this browser, is never exported, and is sent only to the address above. ' +
        'Some APIs refuse requests from a web page; those cannot be used here.'),
      ...apiCards,
      el('div', { class: 'controls' }, addApi),
    ];
  }

  // ---------------------------------------------------------------- supplier pages

  // Same list as pricetracker/pages.py: sites whose terms rule out reading them with a script.
  const NOT_ALLOWED = [
    [/(^|\.)api\.mercadolibre\.com$/i, 'Mercado Livre\'s API terms limit it to uses that support the marketplace; ask them before using it for price monitoring.'],
    [/(^|\.)mercadoli(vre|bre)\.com(\.[a-z]{2})?$/i, 'Mercado Livre\'s terms do not allow robots on the site, so the reader skips it. Type the price in under Quotes.'],
    [/(^|\.)amazon\.[a-z]{2,3}(\.[a-z]{2})?$/i, 'Amazon\'s conditions of use do not allow robots, so the reader skips it. Type the price in under Quotes.'],
  ];
  const termsNote = (url) => {
    let host = '';
    try { host = new URL(url).hostname; } catch (e) { return null; }
    const hit = NOT_ALLOWED.find(([re]) => re.test(host));
    return hit ? hit[1] : null;
  };
  let pageRun = null; // {name, updated, results} from page-prices.json
  let pageMsg = '';

  function pageRunFrom(data, name) {
    if (!data || data.kind !== 'page-prices' || !Array.isArray(data.results)) throw new Error('This is not a page-prices.json file from the price reader.');
    return { name, updated: data.updated, results: data.results };
  }

  // the newest price per month, supplier and item; quote terms copied from that supplier's last quote
  function quotesFromRun(results) {
    const add = [];
    const skipped = [];
    const seen = new Set();
    for (const r of results.slice().sort((a, b) => b.date.localeCompare(a.date))) {
      if (r.status !== 'ok') continue;
      const month = r.date.slice(0, 7);
      const key = `${month}|${r.supplier}|${r.item}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!ws().items.some((i) => i.id === r.item)) { skipped.push(`${r.item} is not in your items`); continue; }
      if (r.currency && r.currency !== 'BRL') { skipped.push(`${r.supplier}: price in ${r.currency}, not converted`); continue; }
      const last = ws().quotes.filter((q) => q.item === r.item && q.supplier === r.supplier).sort((a, b) => b.month.localeCompare(a.month))[0];
      add.push({ month, supplier: r.supplier, item: r.item, price: r.price, leadTime: last ? last.leadTime : null,
        payment: last ? last.payment : null, moq: last ? last.moq : null, source: 'page' });
    }
    return { add, skipped };
  }

  function pagesTab() {
    const items = ws().items.map((i) => [i.id, i.id]);
    const links = ws().links;
    const rows = links.map((link, index) => {
      const at = (fn) => commit((w) => fn(w.links[index]), { setup: false });
      const warn = termsNote(link.url);
      const kind = select([['page', 'product page'], ['api', 'API']], link.kind || 'page', { 'aria-label': 'Kind' }, (v) => commit((w) => { w.links[index].kind = v; }));
      const factor = input({ type: 'number', min: 0, step: 'any', value: link.factor || 1, 'aria-label': 'Units on the page per item unit', class: 'w-code' }, (n) => at((l) => { l.factor = num(n.value) || 1; }));
      const url = input({ type: 'url', value: link.url, 'aria-label': 'Address', class: 'w-url' }, (n) => commit((w) => { w.links[index].url = n.value.trim(); }));
      const api = link.kind === 'api' ? el('div', { class: 'detail api-fields' },
        input({ type: 'text', value: link.priceField || '', placeholder: 'price field, e.g. price', 'aria-label': 'Price field', class: 'w-code' }, (n) => at((l) => { l.priceField = n.value.trim(); })),
        input({ type: 'text', value: link.currencyField || '', placeholder: 'currency field', 'aria-label': 'Currency field', class: 'w-code' }, (n) => at((l) => { l.currencyField = n.value.trim(); })),
        input({ type: 'text', value: link.tokenEnv || '', placeholder: 'token variable', 'aria-label': 'Environment variable with the token', class: 'w-code' }, (n) => at((l) => { l.tokenEnv = n.value.trim(); }))) : null;
      const del = button('Delete', () => commit((w) => { w.links.splice(index, 1); }), { class: 'link', 'aria-label': `Delete the link for ${link.supplier}` });
      return el('tr', null, el('td', null, link.item), el('td', null, link.supplier),
        el('td', null, url, api, warn ? el('div', { class: 'field-error' }, warn) : null), el('td', null, kind), el('td', null, factor), el('td', null, del));
    });

    const f = {
      item: el('select', { 'aria-label': 'Item' }, items.map(([v, l]) => el('option', { value: v }, l))),
      supplier: el('input', { type: 'text', placeholder: 'Supplier', 'aria-label': 'Supplier', list: 'page-suppliers', class: 'w-desc' }),
      url: el('input', { type: 'url', placeholder: 'https://… product page', 'aria-label': 'Product page address', class: 'w-url' }),
    };
    const addErr = el('span', { class: 'field-error', role: 'alert' });
    const addLink = button('Add link', () => {
      const supplier = f.supplier.value.trim();
      const url = f.url.value.trim();
      if (!f.item.value || !supplier || !/^https?:\/\/[^/\s]+\.[^/\s]+/i.test(url)) { addErr.textContent = 'Item, supplier and a web address are needed.'; return; }
      commit((w) => {
        w.links.push({ item: f.item.value, supplier, url, kind: 'page' });
        if (!w.suppliers.includes(supplier)) w.suppliers.push(supplier);
      });
      pageMsg = termsNote(url) || '';
      render();
    }, { disabled: !items.length });

    const contact = input({ type: 'text', value: ws().contact || '', placeholder: 'e-mail or site, optional', 'aria-label': 'Contact sent with the reader', class: 'w-desc' }, (n) => commit((w) => { w.contact = n.value.trim(); }, { setup: false }));
    const getFile = button('Download supplier-pages.json', () => download('supplier-pages.json', JSON.stringify({
      app: 'SupplyPulse', kind: 'supplier-pages', contact: ws().contact || '', links: ws().links }, null, 1) + '\n', 'application/json'), { disabled: !links.length });

    const drop = el('label', { class: 'drop', id: 'pages-drop' },
      el('input', { type: 'file', accept: '.json,application/json' }),
      el('strong', null, 'Load page-prices.json'),
      el('span', { class: 'file' }, 'The file the price reader writes. Drop it here or click.'));
    const fileInput = drop.querySelector('input');
    const loadRun = async (file) => {
      if (!file) return;
      try { pageRun = pageRunFrom(JSON.parse(await file.text()), file.name); pageMsg = ''; } catch (e) { pageMsg = `${file.name}: ${e.message}`; }
      render();
    };
    fileInput.addEventListener('change', () => { loadRun(fileInput.files[0]); fileInput.value = ''; });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); loadRun(e.dataTransfer.files[0]); });
    const web = window.PRICE_DATA.raw.web || {};
    const sampleRun = ws().mode === 'sample' && (web.results || []).length
      ? button('Show the sample run', () => { pageRun = { name: 'Sample run (test copies of the pages)', updated: web.resultsUpdated, results: web.results }; pageMsg = ''; render(); })
      : null;

    let results = null;
    if (pageRun) {
      const plan = quotesFromRun(pageRun.results);
      const latest = pageRun.results.slice().sort((a, b) => b.date.localeCompare(a.date) || a.supplier.localeCompare(b.supplier)).slice(0, 40);
      const body = latest.map((r) => {
        const typeIn = r.status !== 'ok' && ws().items.some((i) => i.id === r.item)
          ? button('Type it in', () => { quoteFilter = r.item; tab = 'quotes'; render(); }, { class: 'link' }) : null;
        return el('tr', { class: r.status === 'ok' ? null : 'off' },
          el('td', null, r.date), el('td', null, r.item), el('td', null, r.supplier),
          el('td', null, r.status === 'ok' ? 'read' : r.status === 'no price' ? 'no price found' : r.status === 'not allowed' ? 'not read' : 'error',
            r.note ? el('div', { class: 'note' }, r.note) : null, typeIn),
          el('td', { class: 'num' }, r.status === 'ok' ? money(r.price) + (r.currency && r.currency !== 'BRL' ? ' ' + r.currency : '') : '–'),
          el('td', null, r.method || '–'));
      });
      const apply = button(`Add ${plan.add.length} ${plan.add.length === 1 ? 'price' : 'prices'} as quotes`, () => {
        commit((w) => {
          for (const q of plan.add) {
            const i = w.quotes.findIndex((x) => x.month === q.month && x.supplier === q.supplier && x.item === q.item);
            if (i >= 0) w.quotes[i] = q; else w.quotes.push(q);
            if (!w.suppliers.includes(q.supplier)) w.suppliers.push(q.supplier);
          }
        });
        pageMsg = `Added ${plan.add.length} quotes from product pages. Lead time, payment and minimum order were copied from each supplier's last quote.`;
        ctx.select(plan.add[0] && plan.add[0].item);
        render();
      }, { disabled: !plan.add.length, id: 'pages-add' });
      results = [
        el('div', { class: 'panel-head' }, el('strong', null, pageRun.name),
          el('span', { class: 'note' }, pageRun.updated ? 'Read ' + String(pageRun.updated).slice(0, 10) : '')),
        el('div', { class: 'table-wrap' }, el('table', { class: 'edit results' },
          el('thead', null, el('tr', null, ['Date', 'Item', 'Supplier', 'Result', 'Price', 'Read from'].map((h, k) => el('th', { class: k === 4 ? 'num' : null }, h)))),
          el('tbody', null, body.length ? body : el('tr', null, el('td', { colspan: 6, class: 'note' }, 'No results in this file.'))))),
        plan.skipped.length ? el('p', { class: 'note' }, 'Left out: ' + plan.skipped.join('; ') + '.') : null,
        el('div', { class: 'controls' }, apply, button('Close', () => { pageRun = null; render(); }, { class: 'link' })),
      ];
    }

    return [
      el('p', { class: 'note' }, 'Any item works here, from copper tube to wheat flour. List the product page of each supplier: the price reader takes the price from the ' +
        'data the store publishes for search engines (schema.org product data or price tags), reads robots.txt first and skips sites whose terms do not allow it. ' +
        'This page cannot read other sites itself, for your security and theirs, so the reader runs as a small script on your computer or on a schedule on GitHub.'),
      el('div', { class: 'table-wrap' }, el('table', { class: 'edit' },
        el('thead', null, el('tr', null, ['Item', 'Supplier', 'Address', 'Kind', 'Units', ''].map((h) => el('th', null, h)))),
        el('tbody', null, rows.length ? rows : el('tr', null, el('td', { colspan: 6, class: 'note' }, 'No supplier pages yet.'))))),
      el('p', { class: 'note' }, 'Units: how many of the page\'s units make one of yours, e.g. 5 when the page sells a 5 kg bag and your item is the 25 kg bag. ' +
        'API: a marketplace or supplier API whose terms allow it; the token stays in an environment variable on the computer that runs the reader, never in this page.'),
      el('div', { class: 'controls' }, f.item, f.supplier, f.url, addLink, addErr),
      el('datalist', { id: 'page-suppliers' }, ws().suppliers.map((s) => el('option', { value: s }))),
      el('h3', null, 'Run the price reader'),
      el('ol', { class: 'howto' },
        el('li', null, 'Download the list: ', getFile, el('span', { class: 'inline' }, ' Contact sent with each request: ', contact)),
        el('li', null, 'On your computer, in the project folder: ', el('code', null, 'python -m pricetracker pages supplier-pages.json'),
          '. Or commit the file to your copy of the repository on GitHub: a workflow runs the reader every Monday and keeps page-prices.json next to this page.'),
        el('li', null, 'Load the result below and add the prices as quotes. Pages without a readable price, or that may not be read, are listed so you can type the price in or import a spreadsheet.')),
      pageRun ? null : el('div', { class: 'controls' }, drop, sampleRun),
      ...(results || []),
      pageMsg ? el('p', { class: 'note', role: 'status' }, pageMsg) : null,
    ];
  }

  // a deployed copy may have page-prices.json next to it, written by the scheduled reader
  if (/^https?:$/.test(location.protocol)) {
    fetch('page-prices.json', { cache: 'no-store', credentials: 'omit' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data && data.kind === 'page-prices') { pageRun = pageRunFrom(data, 'page-prices.json next to this page'); if (tab === 'pages') render(); } })
      .catch(() => {});
  }

  // ---------------------------------------------------------------- quotes

  function readQuotes(table, setup) {
    const map = setup.mapping;
    const cell = (r, key) => (map[key] == null ? '' : String((table[r] || [])[map[key]] == null ? '' : table[r][map[key]]).trim());
    const rows = [];
    const problems = [];
    for (let r = setup.headerRow + 1; r < table.length; r++) {
      const cells = table[r] || [];
      if (!cells.length || cells.every((v) => v === '')) continue;
      if (/^(sub)?tota(l|is)\b/i.test(cells.find((c) => c !== '') || '')) continue;
      const issues = [];
      const date = C.parseDateValue(cell(r, 'month'), setup.dateOrder);
      if (!date) issues.push(cell(r, 'month') ? `month "${cell(r, 'month')}" not read` : 'no month');
      const supplier = cell(r, 'supplier');
      const item = cell(r, 'item');
      if (!supplier) issues.push('no supplier');
      if (!item) issues.push('no item code');
      const price = C.parseAmountValue(cell(r, 'price'));
      if (!(price > 0)) issues.push(cell(r, 'price') ? `price "${cell(r, 'price')}" not read` : 'no price');
      if (issues.length) { problems.push({ line: r + 1, reasons: issues, raw: cells.filter(Boolean).join(' | ') }); continue; }
      const moq = C.parseAmountValue(cell(r, 'moq'));
      rows.push({ month: date.slice(0, 7), supplier, item, description: cell(r, 'description'), price,
        leadTime: days(cell(r, 'leadTime')), payment: days(cell(r, 'payment')), moq: Number.isFinite(moq) ? moq : null });
    }
    return { rows, problems, missing: C.KINDS.quotes.fields.filter((f) => f.required && map[f.key] == null).map((f) => f.label) };
  }

  async function loadQuoteFile(file) {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let table;
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
      table = await C.readXLSXTable(buffer, async (data) => new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()));
    } else if (bytes[0] === 0xd0 && bytes[1] === 0xcf) {
      throw new Error('This is an old .xls file. Save it as .xlsx or .csv and load it again.');
    } else {
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) { text = new TextDecoder('windows-1252').decode(bytes); }
      table = C.parseCSVTable(text);
    }
    const setup = C.setup(table, 'quotes');
    pending = { name: file.name, table, setup };
    pending.read = readQuotes(table, setup);
    render();
  }

  function importPanel() {
    const p = pending;
    const headers = p.table[p.setup.headerRow] || [];
    const width = Math.max(headers.length, ...p.table.slice(p.setup.headerRow + 1, p.setup.headerRow + 30).map((r) => (r ? r.length : 0)));
    const remap = () => { p.read = readQuotes(p.table, p.setup); render(); };
    const headerSel = select(p.table.slice(0, 20).map((row, i) => [i, `Row ${i + 1}: ${(row || []).filter(Boolean).slice(0, 4).join(' | ').slice(0, 60) || '(empty)'}`]), p.setup.headerRow, { 'aria-label': 'Header row' }, (v) => {
      p.setup = C.setup(p.table, 'quotes', { headerRow: Number(v) });
      remap();
    });
    const orderSel = select([['DMY', 'Day first (31/10/2026)'], ['MDY', 'Month first (10/31/2026)']], p.setup.dateOrder, { 'aria-label': 'Date format' }, (v) => { p.setup.dateOrder = v; remap(); });
    const rows = C.KINDS.quotes.fields.map((f) => {
      const col = p.setup.mapping[f.key];
      const sel = select([['', 'Not used'], ...Array.from({ length: width }, (_, i) => [i, `${String.fromCharCode(65 + (i % 26))}: ${headers[i] || '(no name)'}`])], col == null ? '' : col, { 'aria-label': f.label }, (v) => {
        const c = v === '' ? null : Number(v);
        for (const k of Object.keys(p.setup.mapping)) if (c != null && p.setup.mapping[k] === c) p.setup.mapping[k] = null;
        p.setup.mapping[f.key] = c;
        remap();
      });
      const first = p.read.rows.slice(0, 3).map((q) => {
        const v = f.key === 'month' ? monthLabel(q.month) : f.key === 'price' ? money(q.price) : q[f.key];
        return v == null || v === '' ? '–' : String(v);
      }).join(' · ');
      const need = f.required && col == null;
      return el('tr', { class: need ? 'need' : null }, el('td', null, f.label, f.required ? el('span', { class: 'req' }, 'required') : null), el('td', null, sel),
        el('td', { class: 'vals' }, need ? 'Choose a column' : col == null ? '' : first));
    });
    const r = p.read;
    const newItems = [...new Set(r.rows.map((q) => q.item))].filter((id) => !ws().items.some((i) => i.id === id));
    const newSuppliers = [...new Set(r.rows.map((q) => q.supplier))].filter((s) => !ws().suppliers.includes(s));
    const apply = (replace) => {
      const incoming = r.rows;
      commit((w) => {
        if (replace) w.quotes = [];
        const key = (q) => `${q.month}|${q.supplier}|${q.item}`;
        const byKey = new Map(w.quotes.map((q, i) => [key(q), i]));
        for (const q of incoming) {
          const clean = { month: q.month, supplier: q.supplier, item: q.item, price: q.price, leadTime: q.leadTime, payment: q.payment, moq: q.moq };
          if (byKey.has(key(q))) w.quotes[byKey.get(key(q))] = clean;
          else { byKey.set(key(q), w.quotes.length); w.quotes.push(clean); }
          if (!w.suppliers.includes(q.supplier)) w.suppliers.push(q.supplier);
          if (!w.items.some((i) => i.id === q.item)) {
            w.items.push({ id: q.item, description: q.description || q.item, unit: 'pc', kgPerUnit: 1, annualVolume: 0, currentSupplier: '', source: { type: 'none' } });
          }
        }
      });
      const msg = `Imported ${incoming.length} quotes` + (newItems.length ? `. New items: ${newItems.join(', ')}; set what each one is compared with under Items.` : '.');
      pending = null;
      tab = newItems.length ? 'items' : 'quotes';
      render();
      $('setup-msg').textContent = msg;
      if (newItems.length) ctx.select(newItems[0]);
    };
    const ready = !r.missing.length && r.rows.length;
    return el('div', { class: 'import' },
      el('div', { class: 'panel-head' }, el('strong', null, p.name),
        el('span', { class: 'map-state' + (r.missing.length || r.problems.length ? ' bad' : '') },
          r.missing.length ? 'Missing: ' + r.missing.join(', ') : `${r.rows.length} quotes read` + (r.problems.length ? `, ${r.problems.length} ${r.problems.length === 1 ? 'row' : 'rows'} not read` : ''))),
      el('div', { class: 'map-opts' }, el('label', null, 'Header row ', headerSel), el('label', null, 'Dates ', orderSel)),
      el('div', { class: 'table-wrap' }, el('table', { class: 'map-table' },
        el('thead', null, el('tr', null, el('th', null, 'Field'), el('th', null, 'Column in your file'), el('th', null, 'First values, as read'))),
        el('tbody', null, rows))),
      newItems.length || newSuppliers.length ? el('p', { class: 'note' },
        (newItems.length ? `New items: ${newItems.join(', ')}. ` : '') + (newSuppliers.length ? `New suppliers: ${newSuppliers.join(', ')}.` : '')) : null,
      r.problems.length ? el('div', { class: 'unread' }, el('strong', null, `Rows not read (${r.problems.length})`),
        el('ul', null, r.problems.slice(0, 20).map((x) => el('li', null, `Row ${x.line}: ${x.reasons.join('; ')}. `, el('span', { class: 'raw' }, x.raw))))) : null,
      el('div', { class: 'controls' },
        button(`Add ${r.rows.length} quotes`, () => apply(false), { disabled: !ready, id: 'import-add' }),
        button('Replace all my quotes', () => {
          if (window.confirm(`Replace all ${ws().quotes.length} quotes with these ${r.rows.length}?`)) apply(true);
        }, { disabled: !ready }),
        button('Cancel', () => { pending = null; render(); }, { class: 'link' })));
  }

  function quotesTab() {
    const drop = el('label', { class: 'drop', id: 'quote-drop' },
      el('input', { type: 'file', id: 'quote-file', accept: '.xlsx,.csv,.txt,text/csv' }),
      el('strong', null, 'Import quotes from a spreadsheet (.xlsx or .csv)'),
      el('span', { class: 'file' }, 'Drop a file or click. One row per quote: month, supplier, item code and unit price; lead time, payment days and minimum order if you have them. Column names in English or Portuguese.'));
    const fileInput = drop.querySelector('input');
    const err = el('div', { class: 'field-error', role: 'alert' });
    const read = (file) => { if (file) loadQuoteFile(file).catch((e) => { err.textContent = `${file.name}: ${e.message}`; }); };
    fileInput.addEventListener('change', () => { read(fileInput.files[0]); fileInput.value = ''; });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); read(e.dataTransfer.files[0]); });
    const template = button('Download a template (CSV)', () => download('quotes-template.csv',
      'month,supplier,item,description,unit_price_brl,lead_time_days,payment_days,moq\n2026-10,Alpha Supply,CU-TUBE-0952,"Copper tube ACR 3/8 in",92.27,20,28,500\n', 'text/csv;charset=utf-8'), { class: 'link' });

    // one quote by hand
    const items = ws().items.map((i) => [i.id, i.id]);
    const suppliers = ws().suppliers.map((s) => [s, s]);
    const f = {
      month: el('input', { type: 'month', 'aria-label': 'Month', value: new Date().toISOString().slice(0, 7) }),
      supplier: el('select', { 'aria-label': 'Supplier' }, suppliers.map(([v, l]) => el('option', { value: v }, l))),
      item: el('select', { 'aria-label': 'Item' }, items.map(([v, l]) => el('option', { value: v, selected: v === quoteFilter }, l))),
      price: el('input', { type: 'number', min: 0, step: 'any', placeholder: 'Unit price', 'aria-label': 'Unit price', class: 'w-num' }),
      lead: el('input', { type: 'number', min: 0, step: 1, placeholder: 'Lead days', 'aria-label': 'Lead time in days', class: 'w-num' }),
      pay: el('input', { type: 'number', min: 0, step: 1, placeholder: 'Pay days', 'aria-label': 'Payment days', class: 'w-num' }),
      moq: el('input', { type: 'number', min: 0, step: 'any', placeholder: 'MOQ', 'aria-label': 'Minimum order', class: 'w-num' }),
    };
    const addErr = el('span', { class: 'field-error', role: 'alert' });
    const addOne = button('Add quote', () => {
      const price = num(f.price.value);
      if (!f.month.value || !f.supplier.value || !f.item.value || !(price > 0)) { addErr.textContent = 'Month, supplier, item and a price are needed.'; return; }
      const q = { month: f.month.value, supplier: f.supplier.value, item: f.item.value, price, leadTime: num(f.lead.value), payment: num(f.pay.value), moq: num(f.moq.value) };
      commit((w) => {
        const i = w.quotes.findIndex((x) => x.month === q.month && x.supplier === q.supplier && x.item === q.item);
        if (i >= 0) w.quotes[i] = q; else w.quotes.push(q);
      });
    }, { disabled: !items.length || !suppliers.length });

    const filter = select([['', 'All items'], ...items], quoteFilter, { 'aria-label': 'Show quotes for' }, (v) => { quoteFilter = v; render(); });
    const list = ws().quotes.map((q, i) => ({ q, i })).filter(({ q }) => !quoteFilter || q.item === quoteFilter)
      .sort((a, b) => (b.q.month.localeCompare(a.q.month)) || a.q.item.localeCompare(b.q.item) || a.q.supplier.localeCompare(b.q.supplier));
    const shown = list.slice(0, 60);
    const rows = shown.map(({ q, i }) => el('tr', null,
      el('td', null, monthLabel(q.month)), el('td', null, q.supplier, q.source === 'page' ? el('span', { class: 'badge' }, 'page') : null), el('td', null, q.item),
      el('td', { class: 'num' }, money(q.price, q.price < 10 ? 3 : 2)), el('td', { class: 'num' }, q.leadTime == null ? '–' : q.leadTime + ' d'),
      el('td', { class: 'num' }, q.payment == null ? '–' : q.payment + ' d'), el('td', { class: 'num' }, q.moq == null ? '–' : q.moq.toLocaleString('en-US')),
      el('td', null, button('Delete', () => commit((w) => { w.quotes.splice(i, 1); }), { class: 'link', 'aria-label': `Delete quote ${q.month} ${q.supplier} ${q.item}` }))));

    return [
      pending ? importPanel() : drop,
      err,
      pending ? null : el('div', { class: 'controls' }, template),
      el('h3', null, 'Add one quote'),
      el('div', { class: 'controls add-quote' }, f.month, f.supplier, f.item, f.price, f.lead, f.pay, f.moq, addOne, addErr),
      el('h3', null, 'Quote log'),
      el('div', { class: 'controls' }, filter, el('span', { class: 'note' }, list.length > shown.length ? `Latest ${shown.length} of ${list.length}` : `${list.length} quotes`)),
      el('div', { class: 'table-wrap' }, el('table', { class: 'edit' },
        el('thead', null, el('tr', null, ['Month', 'Supplier', 'Item', 'Price', 'Lead time', 'Payment', 'MOQ', ''].map((h, k) => el('th', { class: k >= 3 && k <= 6 ? 'num' : null }, h)))),
        el('tbody', null, rows.length ? rows : el('tr', null, el('td', { colspan: 8, class: 'note' }, 'No quotes yet.'))))),
    ];
  }

  // ---------------------------------------------------------------- frame

  function status() {
    const w = ws();
    $('ws-state').textContent = (w.mode === 'sample' ? 'Sample data' : 'Your data') +
      ` · ${w.items.length} items, ${w.suppliers.length} suppliers, ${w.quotes.length} quotes` + (state.saved ? '' : ' · not saved: this browser blocks storage');
  }

  function render() {
    status();
    $('setup-tabs').replaceChildren(...TABS.map(([key, label]) => {
      const b = el('button', { type: 'button', 'aria-pressed': String(key === tab), 'data-tab': key }, label);
      b.addEventListener('click', () => { tab = key; render(); });
      return b;
    }));
    const body = tab === 'items' ? itemsTab() : tab === 'suppliers' ? suppliersTab() : tab === 'sources' ? sourcesTab() : tab === 'pages' ? pagesTab() : quotesTab();
    $('setup-body').replaceChildren(...body.filter(Boolean));
  }

  const RAWMARKET = () => {
    const m = JSON.parse(JSON.stringify(window.PRICE_DATA.raw.market));
    for (const [key, field] of [['bcb:3698', 'usd_brl'], ['bcb:189', 'igpm_pct']]) {
      const s = state.series[key];
      if (s) for (const [month, v] of Object.entries(s.values)) (m[month] = m[month] || {})[field] = v;
    }
    return m;
  };

  $('ws-empty').addEventListener('click', () => {
    if (ws().mode === 'custom' && !window.confirm('Clear all your items, suppliers and quotes?')) return;
    ctx.replaceWorkspace({ version: 1, mode: 'custom', items: [], suppliers: [], quotes: [], apis: [], links: [] });
    tab = 'items';
    render();
  });
  $('ws-sample').addEventListener('click', () => {
    if (ws().mode === 'custom' && !window.confirm('Go back to the sample? Your items and quotes in this browser will be replaced. Export them first to keep a copy.')) return;
    ctx.replaceWorkspace(ctx.sampleWorkspace());
  });
  $('ws-export').addEventListener('click', () => {
    const w = ws();
    const out = { app: 'SupplyPulse', version: 1, exported: today(), items: w.items, suppliers: w.suppliers, quotes: w.quotes, apis: w.apis, links: w.links || [], contact: w.contact || '' };
    download('supplypulse-data.json', JSON.stringify(out, null, 1), 'application/json');
  });
  $('ws-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.items) || !Array.isArray(data.quotes)) throw new Error('This is not a SupplyPulse export.');
      ctx.replaceWorkspace({
        version: 1, mode: 'custom', items: data.items, quotes: data.quotes, apis: Array.isArray(data.apis) ? data.apis : [],
        links: Array.isArray(data.links) ? data.links : [], contact: typeof data.contact === 'string' ? data.contact : '',
        suppliers: Array.isArray(data.suppliers) ? data.suppliers : [...new Set(data.quotes.map((q) => q.supplier))],
      });
      $('setup-msg').textContent = `Loaded ${data.items.length} items and ${data.quotes.length} quotes from ${file.name}.`;
    } catch (err) {
      $('setup-msg').textContent = `${file.name}: ${err.message}`;
    }
  });

  return { render, status };
};
