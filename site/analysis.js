// Same rules as pricetracker/analysis.py, run in the page so that the user's own items, quotes and price
// sources can be analysed without a server. Loads in the browser (window.Analysis) and in Node (require).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Analysis = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const COMMODITIES = ['copper', 'aluminum', 'zinc', 'nickel', 'iron_ore'];
  const COMMODITY_NAME = { copper: 'Copper', aluminum: 'Aluminum', zinc: 'Zinc', nickel: 'Nickel', iron_ore: 'Iron ore' };
  const WINDOW = 6;
  const OUTPACE_PP = 5;
  const ABOVE_BEST_PCT = 5;
  const STALE_MONTHS = 3;
  const TREND_BAND = 2;
  const MONTHS_SHOWN = 24;
  const CARRY = 2; // a reference value may stand in for up to two later months not published yet
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const SGS_NAMES = { 189: 'IGP-M', 433: 'IPCA', 188: 'INPC', 190: 'IGP-DI', 3698: 'USD/BRL', 21619: 'EUR/BRL', 225: 'IPA-DI' };
  // inflation series published as % change per month; they are compounded into an index before use
  const SGS_PCT = new Set([189, 433, 188, 190, 225]);
  const UNITS = {
    index: 'index or price level (only the change is used)',
    pct: 'monthly % change (compounded into an index)',
    'BRL/unit': 'BRL per unit of the item',
    'BRL/kg': 'BRL per kg',
    'USD/kg': 'USD per kg',
    'USD/t': 'USD per tonne',
  };

  function addMonths(month, n) {
    const [y, m] = month.split('-').map(Number);
    const total = y * 12 + m - 1 + n;
    return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`;
  }

  function monthsBetween(start, end) {
    const [y1, m1] = start.split('-').map(Number);
    const [y2, m2] = end.split('-').map(Number);
    return (y2 - y1) * 12 + m2 - m1;
  }

  const monthName = (month) => `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
  const pct = (now, old) => (now == null || !old ? null : (now / old - 1) * 100);
  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const signed = (v) => (v >= 0 ? '+' : '') + v.toFixed(1);

  function parseBasket(text) {
    const basket = {};
    for (const part of String(text || '').split(/[;,]/).map((s) => s.trim()).filter(Boolean)) {
      const m = /^([a-z_ ]+)\s*[:=]\s*([\d.]+)$/i.exec(part);
      if (!m) throw new Error(`"${part}" should look like copper:0.62`);
      const key = m[1].trim().toLowerCase().replace(/\s+/g, '_');
      if (!COMMODITIES.includes(key)) throw new Error(`${m[1].trim()} is not in the World Bank file (use ${COMMODITIES.join(', ')})`);
      basket[key] = Number(m[2]);
    }
    return basket;
  }

  // {month: % change} -> {month: index}, 100 before the first month
  function compound(values) {
    const out = {};
    let level = 100;
    for (const m of Object.keys(values || {}).sort()) {
      level *= 1 + values[m] / 100;
      out[m] = level;
    }
    return out;
  }

  const isPctSeries = (src) => (src.pct != null ? !!src.pct : SGS_PCT.has(Number(src.series)));

  const basketText = (basket) => Object.entries(basket || {}).map(([k, v]) => `${k}:${v}`).join('; ');

  function materialCost(item, market, month) {
    const row = market[month];
    if (!row || row.usd_brl == null) return null;
    const entries = Object.entries((item.source && item.source.basket) || {});
    if (!entries.length) return null;
    let usdPerTonne = 0;
    for (const [key, tonnes] of entries) {
      if (row[key] == null) return null;
      usdPerTonne += tonnes * row[key];
    }
    return (item.kgPerUnit * usdPerTonne) / 1000 * row.usd_brl;
  }

  // What each item is compared with: the metal inside it (cost in BRL per unit) or any monthly series
  // the user picked (an index, or a price that is turned into BRL per unit).
  function reference(item, market, series, apis) {
    const src = item.source || { type: 'none' };
    if (src.type === 'basket') {
      const names = Object.keys(src.basket || {}).map((k) => COMMODITY_NAME[k] || k).join(' + ');
      return { kind: 'cost', label: 'Material cost', detail: `World Bank: ${names || 'no metal set'}`, value: (m) => materialCost(item, market, m) };
    }
    if (src.type === 'bcb') {
      const raw = series['bcb:' + src.series] || {};
      const values = isPctSeries(src) ? compound(raw) : raw;
      const name = SGS_NAMES[src.series] || 'SGS ' + src.series;
      return { kind: 'index', label: name, detail: `Banco Central SGS ${src.series} (${name})`, value: (m) => (values[m] == null ? null : values[m]) };
    }
    if (src.type === 'api') {
      const api = (apis || []).find((a) => a.id === src.api);
      if (!api) return { kind: null, label: 'No reference', detail: 'API source not found', value: () => null };
      const values = api.unit === 'pct' ? compound(series['api:' + api.id]) : series['api:' + api.id] || {};
      const toBrl = (m) => {
        const v = values[m];
        if (v == null) return null;
        const fx = market[m] && market[m].usd_brl;
        const kg = item.kgPerUnit || 1;
        switch (api.unit) {
          case 'BRL/unit': return v;
          case 'BRL/kg': return v * kg;
          case 'USD/kg': return fx == null ? null : v * fx * kg;
          case 'USD/t': return fx == null ? null : (v / 1000) * fx * kg;
          default: return v;
        }
      };
      return { kind: api.unit && api.unit !== 'index' && api.unit !== 'pct' ? 'cost' : 'index', label: api.name, detail: `API: ${api.name}`, value: toBrl };
    }
    return { kind: null, label: 'No reference', detail: 'No price source', value: () => null };
  }

  // Latest value at or up to CARRY months before `month`.
  function refAt(ref, month) {
    for (let k = 0; k <= CARRY; k++) {
      const v = ref.value(addMonths(month, -k));
      if (v != null) return v;
    }
    return null;
  }

  function lastQuote(quotes, itemId, supplier, month) {
    let found = null;
    for (const q of quotes) {
      if (q.item === itemId && q.supplier === supplier && q.month <= month && (!found || q.month > found.month)) found = q;
    }
    return found;
  }

  function compareSuppliers(item, quotes, ref, asOf) {
    const now = refAt(ref, asOf);
    const materialChange = pct(now, refAt(ref, addMonths(asOf, -WINDOW)));
    const rows = [];
    const suppliers = [...new Set(quotes.filter((q) => q.item === item.id).map((q) => q.supplier))].sort();
    for (const supplier of suppliers) {
      const quote = lastQuote(quotes, item.id, supplier, asOf);
      if (!quote) continue;
      const before = lastQuote(quotes, item.id, supplier, addMonths(asOf, -WINDOW));
      const change = pct(quote.price, before ? before.price : null);
      rows.push({
        supplier,
        price: quote.price,
        quoted: quote.month,
        lead_time_days: quote.leadTime,
        payment_days: quote.payment,
        moq: quote.moq,
        change_pct: change,
        material_change_pct: materialChange,
        gap_pp: change == null || materialChange == null ? null : change - materialChange,
        material_share_pct: ref.kind === 'cost' && now ? (now / quote.price) * 100 : null,
        current: supplier === item.currentSupplier,
        stale: monthsBetween(quote.month, asOf) >= STALE_MONTHS,
      });
    }
    const valid = rows.filter((r) => !r.stale).map((r) => r.price);
    const best = valid.length ? Math.min(...valid) : null;
    for (const r of rows) r.vs_best_pct = pct(r.price, best);
    rows.sort((a, b) => (a.stale - b.stale) || (a.price - b.price));
    return rows;
  }

  function findFlags(items, quotes, refs, asOf) {
    const flags = [];
    const fmt = (v) => Math.round(v).toLocaleString('en-US');
    for (const item of items) {
      const ref = refs[item.id];
      const rows = compareSuppliers(item, quotes, ref, asOf);
      const valid = rows.filter((r) => !r.stale);
      const best = valid[0] || null;
      const what = ref.kind === 'cost' ? 'the material in this item' : `its price reference (${ref.label})`;
      for (const r of rows) {
        if (r.stale) {
          flags.push(flag(item, r, 'stale', 'low', `Last quote from ${r.supplier} is from ${monthName(r.quoted)}; ask for a new one.`));
        } else if (r.gap_pp != null && r.gap_pp > OUTPACE_PP) {
          flags.push(flag(item, r, 'outpaced', r.gap_pp > 2 * OUTPACE_PP ? 'high' : 'medium',
            `${r.supplier} moved ${signed(r.change_pct)}% in ${WINDOW} months while ${what} moved ${signed(r.material_change_pct)}%. Ask for the cost breakdown.`));
        }
      }
      const current = valid.find((r) => r.current);
      if (current && best && current !== best && current.vs_best_pct > ABOVE_BEST_PCT) {
        const saving = (current.price - best.price) * (item.annualVolume || 0);
        const f = flag(item, current, 'above_best', 'high',
          `Current supplier ${current.supplier} is ${current.vs_best_pct.toFixed(1)}% above ${best.supplier}, about R$ ${fmt(saving)} a year at the planned volume. ` +
          `${best.supplier}: ${best.lead_time_days} days lead time, ${best.payment_days}-day payment; ${current.supplier}: ${current.lead_time_days} days, ${current.payment_days}-day payment.`);
        f.saving_brl = Math.round(saving * 100) / 100;
        flags.push(f);
      }
    }
    const order = { high: 0, medium: 1, low: 2 };
    flags.sort((a, b) => (order[a.severity] - order[b.severity]) || ((b.saving_brl || 0) - (a.saving_brl || 0)));
    return flags;
  }

  function flag(item, row, kind, severity, message) {
    return { item: item.id, supplier: row.supplier, kind, severity, message };
  }

  function igpmFactor(market, start, end) {
    let factor = 1;
    for (let m = addMonths(start, 1); m <= end; m = addMonths(m, 1)) {
      const rate = market[m] && market[m].igpm_pct;
      if (rate == null) return null;
      factor *= 1 + rate / 100;
    }
    return factor;
  }

  function trend(values) {
    const last6 = values.slice(-6);
    if (values.length < 6 || last6.some((v) => v == null)) return null;
    const change = pct(mean(values.slice(-3)), mean(values.slice(-6, -3)));
    return change > TREND_BAND ? 'rising' : change < -TREND_BAND ? 'falling' : 'flat';
  }

  function seriesTrend(history, extra) {
    const last = history[history.length - 1];
    const at = (k) => history[history.length - 1 - k];
    return Object.assign({ last, change_3m: pct(last, at(3)), change_6m: pct(last, at(6)), change_12m: pct(last, at(12)), direction: trend(history), history }, extra);
  }

  function marketValue(market, key, month, inBrl) {
    const row = market[month] || {};
    const v = row[key];
    if (v == null) return null;
    if (!inBrl) return v;
    return row.usd_brl == null ? null : (v * row.usd_brl) / 1000;
  }

  function latestMonth(market, keys) {
    const months = Object.keys(market).filter((m) => keys.every((k) => market[m][k] != null)).sort();
    return months.length ? months[months.length - 1] : null;
  }

  // Monthly averages from dated values ({date: 'YYYY-MM-DD' or 'YYYY-MM', value}).
  function monthly(points) {
    const sums = {};
    for (const p of points) {
      if (p.value == null || !Number.isFinite(p.value) || !p.date) continue;
      const m = p.date.slice(0, 7);
      (sums[m] = sums[m] || []).push(p.value);
    }
    return Object.fromEntries(Object.keys(sums).sort().map((m) => [m, mean(sums[m])]));
  }

  // Everything the page shows, from the workspace (items, quotes, API list), the market table and
  // any fetched series ({'bcb:433': {month: value}, 'api:<id>': {...}}).
  function build(ws, market, series) {
    const quotes = ws.quotes.filter((q) => q.month && q.supplier && q.item && Number.isFinite(q.price));
    const marketMonth = latestMonth(market, ['usd_brl', 'copper']);
    const lastQuoteMonth = quotes.reduce((m, q) => (q.month > m ? q.month : m), '');
    const asOf = lastQuoteMonth || marketMonth;
    const months = Array.from({ length: MONTHS_SHOWN }, (_, i) => addMonths(asOf, i - MONTHS_SHOWN + 1));
    const refs = Object.fromEntries(ws.items.map((item) => [item.id, reference(item, market, series || {}, ws.apis)]));

    const items = ws.items.map((item) => {
      const ref = refs[item.id];
      const prices = {};
      for (const q of quotes) {
        if (q.item !== item.id) continue;
        const i = months.indexOf(q.month);
        if (i < 0) continue;
        (prices[q.supplier] = prices[q.supplier] || Array(months.length).fill(null))[i] = q.price;
      }
      for (const name of [...new Set(quotes.filter((q) => q.item === item.id).map((q) => q.supplier))]) {
        if (!prices[name]) prices[name] = Array(months.length).fill(null);
      }
      return {
        id: item.id,
        description: item.description,
        unit: item.unit,
        annualVolume: item.annualVolume,
        currentSupplier: item.currentSupplier,
        source: item.source,
        refKind: ref.kind,
        refLabel: ref.label,
        refDetail: ref.detail,
        material: months.map((m) => ref.value(m)),
        prices: Object.fromEntries(Object.keys(prices).sort().map((k) => [k, prices[k]])),
        table: compareSuppliers(item, quotes, ref, asOf),
      };
    });

    const mAsOf = marketMonth && marketMonth < asOf ? marketMonth : asOf;
    const history = (key, inBrl) => Array.from({ length: MONTHS_SHOWN }, (_, i) => marketValue(market, key, addMonths(mAsOf, i - MONTHS_SHOWN + 1), inBrl));
    const extra = [];
    const seen = new Set();
    for (const item of ws.items) {
      const src = item.source || {};
      const key = src.type === 'bcb' ? 'bcb:' + src.series : src.type === 'api' ? 'api:' + src.api : null;
      if (!key || seen.has(key) || !(series || {})[key]) continue;
      seen.add(key);
      const api = src.type === 'api' && (ws.apis || []).find((a) => a.id === src.api);
      const pctSeries = src.type === 'bcb' ? isPctSeries(src) : !!api && api.unit === 'pct';
      const values = pctSeries ? compound(series[key]) : series[key];
      const hist = months.map((m) => (values[m] == null ? null : values[m]));
      if (hist.every((v) => v == null)) continue;
      const name = api ? api.name : `${SGS_NAMES[src.series] || 'SGS ' + src.series} (Banco Central)`;
      extra.push(seriesTrend(hist, { key, name: pctSeries ? name + ', index' : name, unit: pctSeries || !api ? 'index' : api.unit }));
    }
    return {
      asOf,
      marketAsOf: mAsOf,
      months,
      items,
      flags: findFlags(ws.items, quotes, refs, asOf),
      igpmIndex: months.map((m) => { const f = igpmFactor(market, months[0], m); return f == null ? null : f * 100; }),
      market: COMMODITIES.map((key) => seriesTrend(history(key, true), { key, currency: 'BRL/kg' })),
      fx: seriesTrend(history('usd_brl', false), { key: 'usd_brl', currency: 'BRL' }),
      extra,
    };
  }

  return {
    COMMODITIES, COMMODITY_NAME, SGS_NAMES, SGS_PCT, UNITS, compound, isPctSeries, WINDOW, STALE_MONTHS, addMonths, monthsBetween, monthName, pct,
    parseBasket, basketText, materialCost, reference, compareSuppliers, findFlags, igpmFactor, trend, latestMonth, monthly, build,
  };
});
