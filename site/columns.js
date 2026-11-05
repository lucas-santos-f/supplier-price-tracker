// Reads spreadsheets whatever their column names: finds the header row, guesses which column holds what, and
// turns dates and amounts into one standard shape. Runs in the browser (window.Columns) and under Node (require).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Columns = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- tables

  function detectDelimiter(text) {
    const lines = text.split(/\r?\n/).slice(0, 20).filter((l) => l.trim());
    const score = (ch) => lines.reduce((s, l) => s + (l.split(ch).length - 1), 0);
    const best = [',', ';', '\t', '|'].map((ch) => [ch, score(ch)]).sort((a, b) => b[1] - a[1])[0];
    return best[1] ? best[0] : ',';
  }

  // Array of rows, each an array of cell strings. Empty rows are kept so that index + 1 is the row number.
  function parseCSVTable(text) {
    text = String(text).replace(/^﻿/, '');
    const delim = detectDelimiter(text);
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') quoted = false;
        else field += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === delim) { row.push(field.trim()); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field.trim()); rows.push(row); row = []; field = '';
      } else field += ch;
    }
    if (field !== '' || row.length) { row.push(field.trim()); rows.push(row); }
    return rows.map((r) => (r.every((v) => v === '') ? [] : r));
  }

  // First worksheet of an .xlsx file. `inflate(bytes) -> Promise<Uint8Array>` undoes raw deflate.
  async function readXLSXTable(buffer, inflate) {
    const bytes = new Uint8Array(buffer);
    if (bytes[0] === 0xd0 && bytes[1] === 0xcf) throw new Error('This is an old .xls file. Save it as .xlsx or .csv and load it again.');
    const files = unzipIndex(bytes);
    const text = async (name) => {
      const f = files[name];
      if (!f) return null;
      const data = bytes.subarray(f.start, f.start + f.size);
      const out = f.method === 0 ? data : f.method === 8 ? await inflate(data) : null;
      if (!out) throw new Error('unsupported compression in ' + name);
      return new TextDecoder('utf-8').decode(out);
    };
    const workbook = await text('xl/workbook.xml');
    if (!workbook) throw new Error('Not an .xlsx file.');
    const rels = (await text('xl/_rels/workbook.xml.rels')) || '';
    const first = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook);
    let sheetPath = 'xl/worksheets/sheet1.xml';
    if (first) {
      const rel = new RegExp('<Relationship\\b[^>]*Id="' + first[1] + '"[^>]*Target="([^"]+)"').exec(rels) ||
        new RegExp('<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="' + first[1] + '"').exec(rels);
      if (rel) sheetPath = rel[1].startsWith('/') ? rel[1].slice(1) : 'xl/' + rel[1].replace(/^\.\//, '');
    }
    const shared = [];
    const sst = await text('xl/sharedStrings.xml');
    if (sst) {
      for (const si of sst.match(/<si\b[\s\S]*?<\/si>/g) || []) {
        shared.push((si.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) || []).map((t) => xmlText(t.replace(/<[^>]+>/g, ''))).join(''));
      }
    }
    const sheet = await text(sheetPath);
    if (!sheet) throw new Error('Worksheet not found.');
    const rows = [];
    for (const rowXml of sheet.match(/<row\b[\s\S]*?<\/row>|<row\b[^>]*\/>/g) || []) {
      const rNum = /\br="(\d+)"/.exec(rowXml);
      const index = rNum ? Number(rNum[1]) - 1 : rows.length;
      const row = [];
      for (const c of rowXml.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []) {
        const ref = /\br="([A-Z]+)\d+"/.exec(c);
        const col = ref ? colIndex(ref[1]) : row.length;
        const type = (/\bt="([^"]+)"/.exec(c) || [])[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(c);
        let value = '';
        if (type === 's' && v) value = shared[Number(v[1])] || '';
        else if (type === 'inlineStr') value = (c.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) || []).map((t) => xmlText(t.replace(/<[^>]+>/g, ''))).join('');
        else if (v) value = xmlText(v[1]);
        row[col] = String(value).trim();
      }
      rows[index] = Array.from(row, (x) => (x == null ? '' : x));
    }
    return Array.from(rows, (r) => (!r || r.every((v) => v === '') ? [] : r));
  }

  function colIndex(letters) {
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  function xmlText(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&');
  }

  function unzipIndex(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not an .xlsx file.');
    const count = view.getUint16(eocd + 10, true);
    let p = view.getUint32(eocd + 16, true);
    const files = {};
    for (let n = 0; n < count; n++) {
      if (view.getUint32(p, true) !== 0x02014b50) break;
      const method = view.getUint16(p + 10, true);
      const size = view.getUint32(p + 20, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const local = view.getUint32(p + 42, true);
      const name = new TextDecoder('utf-8').decode(bytes.subarray(p + 46, p + 46 + nameLen));
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      files[name] = { method, size, start };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return files;
  }

  // ---------------------------------------------------------------- values

  const MONTHS = {
    jan: 1, january: 1, janeiro: 1, enero: 1, feb: 2, february: 2, fev: 2, fevereiro: 2, febrero: 2, mar: 3, march: 3,
    marco: 3, marzo: 3, apr: 4, april: 4, abr: 4, abril: 4, may: 5, mai: 5, maio: 5, mayo: 5, jun: 6, june: 6, junho: 6,
    junio: 6, jul: 7, july: 7, julho: 7, julio: 7, aug: 8, august: 8, ago: 8, agosto: 8, sep: 9, sept: 9, september: 9,
    set: 9, setembro: 9, septiembre: 9, oct: 10, october: 10, out: 10, outubro: 10, octubre: 10, nov: 11, november: 11,
    novembro: 11, noviembre: 11, dec: 12, december: 12, dez: 12, dezembro: 12, dic: 12, diciembre: 12,
  };

  function fold(s) {
    return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  function isoDate(y, m, d) {
    if (y < 100) y += 2000;
    if (m < 1 || m > 12 || d < 1) return null;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    if (d > last) return null;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  // order: 'DMY' (31/10/2026) or 'MDY' (10/31/2026) for the ambiguous a/b/yyyy form
  function parseDateValue(value, order) {
    const s = String(value == null ? '' : value).trim();
    if (!s) return null;
    let m;
    if (/^\d{5}(\.\d+)?$/.test(s)) {
      const n = Math.floor(Number(s));
      if (n < 20000 || n > 80000) return null;
      return new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10);
    }
    if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(s))) return isoDate(+m[1], +m[2], +m[3]);
    if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return isoDate(+m[1], +m[2], +m[3]);
    if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:\s.*)?$/.exec(s))) {
      const a = +m[1];
      const b = +m[2];
      const y = +m[3];
      if (a > 12) return isoDate(y, b, a);
      if (b > 12) return isoDate(y, a, b);
      return order === 'MDY' ? isoDate(y, a, b) : isoDate(y, b, a);
    }
    // month only (2026-10, 10/2026, Oct 2026, out/26) -> first day of the month
    if ((m = /^(\d{4})[-/.](\d{1,2})$/.exec(s))) return isoDate(+m[1], +m[2], 1);
    if ((m = /^(\d{1,2})[-/.](\d{4})$/.exec(s))) return isoDate(+m[2], +m[1], 1);
    const f = fold(s).replace(/,/g, ' ').replace(/\bde\b/g, ' ').replace(/\s+/g, ' ').trim();
    if ((m = /^(\d{1,2})[-/. ]([a-z]{3,9})\.?[-/. ](\d{2}|\d{4})$/.exec(f)) && MONTHS[m[2]]) return isoDate(+m[3], MONTHS[m[2]], +m[1]);
    if ((m = /^([a-z]{3,9})\.? (\d{1,2}) (\d{4})$/.exec(f)) && MONTHS[m[1]]) return isoDate(+m[3], MONTHS[m[1]], +m[2]);
    if ((m = /^([a-z]{3,9})\.?[-/. ](\d{2}|\d{4})$/.exec(f)) && MONTHS[m[1]]) return isoDate(+m[2], MONTHS[m[1]], 1);
    return null;
  }

  // Looks at a column of a/b/yyyy dates: a day over 12 in the first place means day first, in the second month first.
  function detectDateOrder(values) {
    let dmy = 0;
    let mdy = 0;
    for (const v of values) {
      const m = /^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/.exec(String(v).trim());
      if (!m) continue;
      if (+m[1] > 12) dmy++;
      if (+m[2] > 12) mdy++;
    }
    return dmy > mdy ? 'DMY' : mdy > dmy ? 'MDY' : null;
  }

  // "1,234.56", "1.234,56", "R$ -850,00", "(850.00)", "850.00-", "120,00 D", "1 234,56" -> number; NaN if not a number
  function parseAmountValue(value) {
    if (typeof value === 'number') return value;
    let s = String(value == null ? '' : value).trim();
    if (!s) return NaN;
    let negative = /^\(.*\)$/.test(s) || /^-/.test(s) || /-$/.test(s) || /\s?D$/i.test(s) || /^-?\s*[A-Z$€£R]*\s*-/.test(s);
    if (/\s?C$/i.test(s)) negative = false;
    s = s.replace(/\s?[CD]$/i, '').replace(/[^\d.,]/g, '');
    if (!/\d/.test(s)) return NaN;
    const lastDot = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else if (lastDot > lastComma && lastComma !== -1) s = s.replace(/,/g, '');
    else if (lastComma === -1 && (s.match(/\./g) || []).length > 1) s = s.replace(/\./g, '');
    const n = Number(s);
    if (!Number.isFinite(n)) return NaN;
    return negative ? -n : n;
  }

  // D, DR, Debit, Débito, Saída, - -> -1 ; C, CR, Credit, Crédito, Entrada, + -> 1
  function parseSign(value) {
    const s = fold(value).trim();
    if (/^(d|dr|deb|debit|debito|debitos|saida|s|out|withdrawal|-)$/.test(s)) return -1;
    if (/^(c|cr|cred|credit|credito|creditos|entrada|e|in|deposit|\+)$/.test(s)) return 1;
    return 0;
  }

  // ---------------------------------------------------------------- fields

  const KINDS = {
    invoices: {
      label: 'Invoices',
      fields: [
        { key: 'number', label: 'Invoice number', type: 'text', id: true, required: true,
          aliases: ['invoice', 'invoiceno', 'invoicenumber', 'invoiceid', 'number', 'nf', 'nfe', 'nnf', 'nonf', 'numeronf', 'notafiscal', 'numeronota', 'numero', 'fatura', 'nfatura', 'numerofatura', 'documento', 'docnumber', 'billno', 'billnumber', 'titulo', 'duplicata'] },
        { key: 'customer', label: 'Customer', type: 'text',
          aliases: ['customer', 'customername', 'client', 'clientname', 'cliente', 'razaosocial', 'sacado', 'billto', 'company', 'account', 'accountname', 'name', 'nome'] },
        { key: 'issued', label: 'Issue date', type: 'date',
          aliases: ['issuedate', 'issued', 'invoicedate', 'date', 'documentdate', 'emissao', 'dataemissao', 'dataemissaonf', 'data'] },
        { key: 'due', label: 'Due date', type: 'date', required: true,
          aliases: ['duedate', 'due', 'dueon', 'paymentdue', 'vencimento', 'datavencimento', 'dtvencimento', 'venc'] },
        { key: 'amount', label: 'Amount', type: 'amount', required: true,
          aliases: ['amount', 'total', 'value', 'invoiceamount', 'amountdue', 'totalamount', 'grossamount', 'openamount', 'valor', 'valortotal', 'valordocumento', 'valornf', 'valoremaberto'] },
      ],
    },
    statement: {
      label: 'Bank statement',
      fields: [
        { key: 'date', label: 'Date', type: 'date', required: true,
          aliases: ['date', 'postingdate', 'posteddate', 'transactiondate', 'valuedate', 'bookingdate', 'txndate', 'data', 'datalancamento', 'datamovimento', 'datamov', 'dtlancamento', 'dtmovimento', 'fecha'] },
        { key: 'description', label: 'Description', type: 'text', required: true,
          aliases: ['description', 'details', 'memo', 'narrative', 'transactiondescription', 'transactiondetails', 'payee', 'historico', 'descricao', 'lancamento', 'complemento', 'concepto'] },
        { key: 'reference', label: 'Reference', type: 'text', id: true,
          aliases: ['reference', 'ref', 'referencia', 'document', 'documento', 'doc', 'docno', 'nrdocumento', 'numerodocumento', 'identificador', 'transactionid', 'id', 'checknumber', 'checkno', 'cheque'] },
        { key: 'amount', label: 'Amount (+ in, - out)', type: 'amount',
          aliases: ['amount', 'value', 'valor', 'transactionamount', 'montante', 'importe', 'quantia'] },
        { key: 'credit', label: 'Credit (money in)', type: 'amount',
          aliases: ['credit', 'credits', 'credito', 'creditos', 'deposit', 'deposits', 'moneyin', 'paidin', 'entrada', 'entradas', 'creditamount'] },
        { key: 'debit', label: 'Debit (money out)', type: 'amount',
          aliases: ['debit', 'debits', 'debito', 'debitos', 'withdrawal', 'withdrawals', 'moneyout', 'paidout', 'saida', 'saidas', 'debitamount'] },
        { key: 'sign', label: 'Debit/credit flag', type: 'sign',
          aliases: ['dc', 'cd', 'drcr', 'crdr', 'debitcredit', 'creditdebit', 'type', 'tipo', 'natureza', 'sinal', 'indicator', 'creditordebit'] },
      ],
    },
  };
  // never guessed as a field: running balances and totals
  const IGNORE = /^(balance|balances|runningbalance|saldo|saldos|saldoatual|saldodisponivel|availablebalance|ledgerbalance)$/;
  const TOTAL_LINE = /^(sub)?tota(l|is)\b/;
  // lines a bank adds that are not transactions
  const BALANCE_LINE = /^(saldo\b|opening balance|closing balance|balance (brought|carried) forward|beginning balance|ending balance|s a l d o)/i;

  function normalizeHeader(h) {
    return fold(h).replace(/\((r\$|us\$|\$|usd|brl|eur|gbp)\)|\br\$|\bus\$/g, '').replace(/[^a-z0-9]/g, '');
  }

  function editDistance(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return d[a.length][b.length];
  }

  // 3 exact name, 2 close name (contains it or one letter off), 0 otherwise
  function headerScore(header, field) {
    const h = normalizeHeader(header);
    if (!h || IGNORE.test(h)) return 0;
    let best = 0;
    for (const [i, a] of field.aliases.entries()) {
      // earlier aliases are the more usual names, so they win a tie
      if (h === a) return 3 + 0.1 * (1 - i / field.aliases.length);
      if (a.length >= 4 && h.includes(a)) best = Math.max(best, 2 + a.length / 100);
      else if (h.length >= 4 && a.includes(h)) best = Math.max(best, 2);
      else if (a.length >= 5 && Math.abs(a.length - h.length) <= 1 && editDistance(a, h) <= 1) best = Math.max(best, 2);
    }
    return best;
  }

  // share of the sample values that read as the field's type
  function valueFit(values, field, order) {
    const filled = values.filter((v) => v !== '' && v != null);
    if (!filled.length) return 0;
    const share = (fn) => filled.filter(fn).length / filled.length;
    if (field.type === 'date') return share((v) => parseDateValue(v, order) != null);
    if (field.type === 'amount') return share((v) => Number.isFinite(parseAmountValue(v)) && !parseDateValue(v));
    if (field.type === 'sign') return share((v) => parseSign(v) !== 0);
    // document numbers are often plain digits, but never money or dates
    if (field.id) return share((v) => !parseDateValue(v, order) && !/\d[.,]\d{2}$/.test(v));
    return 1 - share((v) => parseDateValue(v, order) != null || /^[-+()$R\s\d.,]+$/.test(v));
  }

  function columnValues(table, headerRow, col, limit) {
    const out = [];
    for (let r = headerRow + 1; r < table.length && out.length < (limit || 40); r++) {
      if (table[r] && table[r].length) out.push(table[r][col] == null ? '' : table[r][col]);
    }
    return out;
  }

  // The header is the row among the first 20 whose cells look most like known column names.
  function findHeaderRow(table, kind) {
    let best = { row: 0, score: -1 };
    for (let r = 0; r < Math.min(table.length, 20); r++) {
      const cells = table[r] || [];
      if (cells.filter((c) => c !== '').length < 2) continue;
      const score = KINDS[kind].fields.reduce((s, f) => s + Math.max(0, ...cells.map((c) => headerScore(c, f))), 0);
      if (score > best.score) best = { row: r, score };
    }
    return best.row;
  }

  // field -> column index (or null). Close names count only when the values in the column fit the field's type.
  function guessMapping(table, headerRow, kind, order) {
    const headers = table[headerRow] || [];
    const pairs = [];
    for (const field of KINDS[kind].fields) {
      headers.forEach((h, col) => {
        const hs = headerScore(h, field);
        if (!hs) return;
        const fit = valueFit(columnValues(table, headerRow, col), field, order);
        // a close name, or a flag column, only counts when most values in it fit
        if ((hs < 3 || field.type === 'sign') && fit < 0.5) return;
        pairs.push({ field: field.key, col, score: hs + fit });
      });
    }
    pairs.sort((a, b) => b.score - a.score);
    const mapping = Object.fromEntries(KINDS[kind].fields.map((f) => [f.key, null]));
    const used = new Set();
    for (const p of pairs) {
      if (mapping[p.field] != null || used.has(p.col)) continue;
      mapping[p.field] = p.col;
      used.add(p.col);
    }
    // separate credit/debit columns win over a lone amount column that is really a running balance
    if (kind === 'statement' && mapping.credit != null && mapping.debit != null && mapping.amount != null) mapping.amount = null;
    return mapping;
  }

  function moneyMode(mapping) {
    if (mapping.credit != null || mapping.debit != null) return 'split';
    if (mapping.amount != null && mapping.sign != null) return 'flag';
    if (mapping.amount != null) return 'signed';
    return null;
  }

  // What is still missing before the file can be used.
  function missing(kind, mapping) {
    const out = KINDS[kind].fields.filter((f) => f.required && mapping[f.key] == null).map((f) => f.label);
    if (kind === 'statement' && !moneyMode(mapping)) out.push('Amount, or Credit and Debit');
    return out;
  }

  function setup(table, kind, options) {
    const opts = options || {};
    const headerRow = opts.headerRow != null ? opts.headerRow : findHeaderRow(table, kind);
    const dateFields = KINDS[kind].fields.filter((f) => f.type === 'date').map((f) => f.key);
    let mapping = opts.mapping || guessMapping(table, headerRow, kind, opts.dateOrder);
    const detected = detectDateOrder(dateFields.flatMap((k) => (mapping[k] == null ? [] : columnValues(table, headerRow, mapping[k], 400))));
    if (!opts.mapping && !opts.dateOrder && detected) mapping = guessMapping(table, headerRow, kind, detected);
    return { headerRow, mapping, dateOrder: opts.dateOrder || detected || 'DMY', detectedOrder: detected };
  }

  // ---------------------------------------------------------------- reading rows

  function apply(table, kind, s) {
    const fields = KINDS[kind].fields;
    const headers = table[s.headerRow] || [];
    const map = s.mapping;
    const rows = [];
    const problems = [];
    const skipped = [];
    const cell = (r, key) => (map[key] == null ? '' : String((table[r] || [])[map[key]] == null ? '' : table[r][map[key]]).trim());
    const mode = moneyMode(map);
    for (let r = s.headerRow + 1; r < table.length; r++) {
      const cells = table[r] || [];
      if (!cells.length || cells.every((v) => v === '')) continue;
      const line = r + 1;
      const first = fold(cells.find((c) => c !== '') || '');
      if (TOTAL_LINE.test(first)) { skipped.push({ line, reason: 'total line', text: cells.filter((c) => c !== '').join(' ') }); continue; }
      const issues = [];
      const out = { line };
      for (const f of fields) {
        if (map[f.key] == null || f.type === 'sign') continue;
        const raw = cell(r, f.key);
        if (f.type === 'date') {
          out[f.key] = parseDateValue(raw, s.dateOrder);
          if (!out[f.key] && (f.required || raw)) issues.push(raw ? `${f.label.toLowerCase()} "${raw}" is not a date` : `no ${f.label.toLowerCase()}`);
        } else if (f.type === 'amount') {
          out[f.key] = raw === '' ? null : parseAmountValue(raw);
          if (raw !== '' && !Number.isFinite(out[f.key])) issues.push(`${f.label.toLowerCase()} "${raw}" is not a number`);
        } else {
          out[f.key] = raw;
          if (f.required && !raw) issues.push(`no ${f.label.toLowerCase()}`);
        }
      }
      if (kind === 'statement') {
        const text = [out.description, out.reference].filter(Boolean).join(' ');
        if (BALANCE_LINE.test(out.description || '')) { skipped.push({ line, reason: 'balance line', text }); continue; }
        let amount = null;
        if (mode === 'split') {
          const cr = Number.isFinite(out.credit) ? Math.abs(out.credit) : 0;
          const db = Number.isFinite(out.debit) ? Math.abs(out.debit) : 0;
          if (out.credit == null && out.debit == null) issues.push('no credit or debit amount');
          else amount = cr - db;
        } else if (mode === 'flag') {
          const sign = parseSign(cell(r, 'sign'));
          if (!sign) issues.push(`debit/credit flag "${cell(r, 'sign')}" not recognised`);
          else if (Number.isFinite(out.amount)) amount = Math.abs(out.amount) * sign;
          else issues.push('no amount');
        } else if (mode === 'signed') {
          if (Number.isFinite(out.amount)) amount = out.amount;
          else if (out.amount == null) issues.push('no amount');
        }
        if (issues.length) { problems.push({ line, reasons: issues, raw: cells.filter((c) => c !== '').join(' | ') }); continue; }
        rows.push({ line, date: out.date, description: text, amount: Math.round(amount * 100) / 100 });
      } else {
        if (out.amount == null && map.amount != null) issues.push('no amount');
        if (issues.length) { problems.push({ line, reasons: issues, raw: cells.filter((c) => c !== '').join(' | ') }); continue; }
        rows.push({ line, number: out.number, customer: out.customer || '', issued: out.issued || out.due, due: out.due, amount: out.amount });
      }
    }
    const usedCols = new Set(Object.values(map).filter((c) => c != null));
    const unused = headers.map((h, i) => ({ h, i })).filter((x) => x.h && !usedCols.has(x.i)).map((x) => x.h);
    return { rows, problems, skipped, unused, mode, missing: missing(kind, map) };
  }

  // ---------------------------------------------------------------- templates

  // A template remembers the header names, not the positions, so it still works when columns move.
  function makeTemplate(name, table, kind, s) {
    const headers = table[s.headerRow] || [];
    const byHeader = {};
    for (const [field, col] of Object.entries(s.mapping)) if (col != null) byHeader[field] = normalizeHeader(headers[col]);
    return { name: String(name).trim() || 'Template', kind, byHeader, dateOrder: s.dateOrder, saved: new Date().toISOString().slice(0, 10) };
  }

  // Finds a saved template whose columns are all in this file; returns the setup to use, or null.
  function matchTemplate(templates, table, kind) {
    for (const t of templates || []) {
      if (t.kind !== kind) continue;
      for (let r = 0; r < Math.min(table.length, 20); r++) {
        const norm = (table[r] || []).map(normalizeHeader);
        const mapping = Object.fromEntries(KINDS[kind].fields.map((f) => [f.key, null]));
        let ok = Object.keys(t.byHeader).length > 0;
        for (const [field, h] of Object.entries(t.byHeader)) {
          const col = norm.indexOf(h);
          if (col < 0) { ok = false; break; }
          mapping[field] = col;
        }
        if (ok) return { template: t, setup: { headerRow: r, mapping, dateOrder: t.dateOrder, detectedOrder: null } };
      }
    }
    return null;
  }

  return {
    KINDS, parseCSVTable, readXLSXTable, parseDateValue, detectDateOrder, parseAmountValue, parseSign, normalizeHeader,
    headerScore, findHeaderRow, guessMapping, moneyMode, missing, setup, apply, makeTemplate, matchTemplate, columnValues,
  };
});
