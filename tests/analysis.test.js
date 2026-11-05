const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const A = require('../site/analysis.js');

const text = fs.readFileSync(path.join(__dirname, '..', 'site', 'data.js'), 'utf8');
const D = JSON.parse(text.slice('window.PRICE_DATA = '.length).trim().replace(/;$/, ''));
const sample = { items: D.raw.items, quotes: D.raw.quotes, apis: [] };

const close = (a, b, label) => {
  if (a == null || b == null) return assert.equal(a, b, label);
  assert.ok(Math.abs(a - b) < 0.01, `${label}: ${a} vs ${b}`);
};

test('page analysis gives the same answer as the Python build', () => {
  const view = A.build(sample, D.raw.market, {});
  assert.equal(view.asOf, D.asOf);
  assert.deepEqual(view.months, D.months);
  for (const item of D.items) {
    const mine = view.items.find((i) => i.id === item.id);
    item.material.forEach((v, i) => close(mine.material[i], v, `${item.id} material ${i}`));
    assert.deepEqual(Object.keys(mine.prices), Object.keys(item.prices));
    assert.equal(mine.table.length, item.table.length);
    item.table.forEach((row, i) => {
      const r = mine.table[i];
      assert.equal(r.supplier, row.supplier);
      assert.equal(r.stale, row.stale);
      for (const k of ['price', 'change_pct', 'material_change_pct', 'gap_pp', 'material_share_pct', 'vs_best_pct']) close(r[k], row[k], `${item.id} ${row.supplier} ${k}`);
    });
  }
  assert.deepEqual(view.flags.map((f) => [f.item, f.supplier, f.kind, f.severity]), D.flags.map((f) => [f.item, f.supplier, f.kind, f.severity]));
  assert.deepEqual(view.flags.map((f) => f.message), D.flags.map((f) => f.message));
  view.igpmIndex.forEach((v, i) => close(v, D.igpmIndex[i], 'igpm ' + i));
  view.market.forEach((t, i) => { close(t.last, D.market[i].last, t.key); assert.equal(t.direction, D.market[i].direction); });
  close(view.fx.change_6m, D.fx.change_6m, 'fx');
});

test('an item compared with a Banco Central index instead of metal', () => {
  const item = { id: 'X-1', description: 'Assembled part', unit: 'pc', kgPerUnit: 1, annualVolume: 1000, currentSupplier: 'B', source: { type: 'bcb', series: 433, pct: false } };
  const quotes = [
    { month: '2026-04', supplier: 'A', item: 'X-1', price: 100, leadTime: 10, payment: 30, moq: 1 },
    { month: '2026-10', supplier: 'A', item: 'X-1', price: 111, leadTime: 10, payment: 30, moq: 1 },
    { month: '2026-04', supplier: 'B', item: 'X-1', price: 100, leadTime: 5, payment: 28, moq: 1 },
    { month: '2026-10', supplier: 'B', item: 'X-1', price: 103, leadTime: 5, payment: 28, moq: 1 },
  ];
  // index published up to September only: October uses the September value
  const series = { 'bcb:433': { '2026-04': 100, '2026-05': 100.5, '2026-09': 102 } };
  const view = A.build({ items: [item], quotes, apis: [] }, D.raw.market, series);
  const a = view.items[0].table.find((r) => r.supplier === 'A');
  close(a.material_change_pct, 2, 'index change');
  close(a.gap_pp, 9, 'gap');
  assert.equal(a.material_share_pct, null, 'no share for an index');
  assert.equal(view.items[0].refKind, 'index');
  const flag = view.flags.find((f) => f.supplier === 'A');
  assert.equal(flag.severity, 'medium');
  assert.match(flag.message, /its price reference \(IPCA\) moved \+2\.0%/);
});

test('an API price in USD per tonne becomes BRL per unit', () => {
  const api = { id: 'steel', name: 'Steel HRC', unit: 'USD/t' };
  const item = { id: 'S-1', description: 'Sheet', unit: 'kg', kgPerUnit: 2, annualVolume: 0, currentSupplier: '', source: { type: 'api', api: 'steel' } };
  const ref = A.reference(item, { '2026-10': { usd_brl: 5 } }, { 'api:steel': { '2026-10': 800 } }, [api]);
  assert.equal(ref.kind, 'cost');
  assert.equal(ref.value('2026-10'), 8); // 800 USD/t = 0.8 USD/kg x 5 BRL x 2 kg
});

test('basket text and monthly averages', () => {
  assert.deepEqual(A.parseBasket('copper:0.62; zinc:0.38'), { copper: 0.62, zinc: 0.38 });
  assert.throws(() => A.parseBasket('gold:1'), /not in the World Bank file/);
  assert.throws(() => A.parseBasket('copper'), /should look like/);
  assert.deepEqual(A.monthly([{ date: '2026-10-01', value: 5 }, { date: '2026-10-15', value: 6 }, { date: '2026-11-02', value: 7 }]), { '2026-10': 5.5, '2026-11': 7 });
});

test('inflation series given as % per month are compounded before comparing', () => {
  assert.deepEqual(A.compound({ '2026-01': 1, '2026-02': 2 }), { '2026-01': 101, '2026-02': 103.02 });
  const item = { id: 'P', description: '', unit: 'pc', kgPerUnit: 1, annualVolume: 0, currentSupplier: '', source: { type: 'bcb', series: 433 } };
  const monthly = {};
  for (let i = 0; i <= 12; i++) monthly[A.addMonths('2025-10', i)] = 0.5;
  const ref = A.reference(item, {}, { 'bcb:433': monthly }, []);
  close(A.pct(ref.value('2026-10'), ref.value('2026-04')), (1.005 ** 6 - 1) * 100, '6 months of 0.5 %');
  const level = A.reference({ ...item, source: { type: 'bcb', series: 433, pct: false } }, {}, { 'bcb:433': monthly }, []);
  assert.equal(level.value('2026-10'), 0.5);
});
