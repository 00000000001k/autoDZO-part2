// ==UserScript==
// @name         DZO.com.ua — автозаповнення тендера (етап 2 + переможець)
// @namespace    dzo-tender-autofill
// @version      0.3.0
// @description  Етап 2: перевірка суми/ПДВ і заповнення предметів закупівлі з договору. Етап 3: заповнення вікна переможця (ФОП із власної бази + сума/ПДВ з договору); базу ФОПів можна редагувати на будь-якій сторінці сайту через вкладку «ФОПи» справа.
// @match        https://www.dzo.com.ua/*
// @noframes
// @run-at       document-idle
// @grant        unsafeWindow
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @require      https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js
// ==/UserScript==

/* ===================== ЕТАП 2: сторінка редагування тендера (предмети закупівлі) ===================== */
/*
  Що робить:
    1) читає договір (PDF/DOCX), знаходить суму, ПДВ, позиції специфікації, дату заходу;
    2) перевіряє суму/ПДВ на сторінці (ПДВ виправляє за договором);
    3) кнопка "Заповнити предмети" — відкриває специфікацію (лише якщо закрита), додає потрібну кількість
       блоків "предмет закупівлі" і заповнює кожен;
    4) кнопка "Зберегти" НЕ натискається — це робите ви;
    5) розібраний договір зберігається в localStorage ('dzo_contract_ctx') — його підхоплює панель переможця (етап 3).
*/

(function () {
  'use strict';

  // Цей блок працює лише на сторінці редагування тендера
  if (!/\/tenders\/[^/]+\/edit/.test(location.pathname)) return;

  const $ = (typeof unsafeWindow !== 'undefined' && unsafeWindow.jQuery) ? unsafeWindow.jQuery : (window.jQuery || null);

  const CONST = {
    country: 'Україна',
    regionText: 'Черкас',
    locality: 'м. Черкаси',
    street: 'вул. Пастерівська, 102',
    postalCode: '18003'
  };

  const state = { rows: [], kind: 'goods' };

  // ---------- допоміжні ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeoutMs = 8000, intervalMs = 150) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const r = fn();
      if (r) return r;
      await sleep(intervalMs);
    }
    return null;
  }

  function fire(el, type) { el.dispatchEvent(new Event(type, { bubbles: true })); }

  function setInputValue(el, value) {
    if (!el) return false;
    el.value = value;
    fire(el, 'input');
    fire(el, 'change');
    fire(el, 'blur');
    return true;
  }

  function refreshChosen(sel) {
    try { if ($ && $(sel).data && $(sel).data('chosen')) $(sel).trigger('chosen:updated'); } catch (e) { /* нічого */ }
  }

  function setSelectValue(sel, value) {
    if (!sel) return false;
    sel.value = value;
    fire(sel, 'change');
    refreshChosen(sel);
    return sel.value === value;
  }

  async function waitForOptions(sel, timeoutMs = 8000) {
    return waitFor(() => sel && sel.options && sel.options.length > 1, timeoutMs);
  }

  function findOptionByText(sel, text) {
    const needle = text.trim().toLowerCase();
    const opts = Array.from(sel.options);
    return opts.find((o) => o.textContent.trim().toLowerCase() === needle)
      || opts.find((o) => o.textContent.trim().toLowerCase().includes(needle)) || null;
  }

  function isVisible(el) { return !!(el && (el.offsetParent !== null || el.getClientRects().length)); }

  function parsePageNumber(s) {
    const t = String(s || '').replace(/[\s\u00a0]/g, '').replace(',', '.');
    const n = parseFloat(t);
    return isNaN(n) ? null : n;
  }

  // ---------- лог ----------
  // У панелі показуємо ТІЛЬКИ помилки (повідомлення, що починаються з "⚠"). Усе інше — лише в консоль.

  let logBox;
  function log(msg) {
    console.log('[dzo-tender]', msg);
    if (!logBox) return;
    if (msg.charAt(0) !== '⚠') return;
    const line = document.createElement('div');
    line.className = 'dzo-log-line dzo-log-err';
    line.textContent = '❌ ' + msg.slice(1).trim();
    logBox.appendChild(line);
    logBox.scrollTop = logBox.scrollHeight;
  }

  // ---------- читання файлу (як у плані) ----------

  function itemsToText(items) {
    let out = '';
    let lastEndX = null;
    for (const it of items) {
      if (it.str) {
        const x = it.transform[4];
        const height = Math.abs(it.transform[3]) || Math.abs(it.transform[0]) || 10;
        if (lastEndX !== null) {
          const gap = x - lastEndX;
          if (gap > height * 0.1 || gap < -height * 0.1) out += ' ';
        }
        out += it.str;
        lastEndX = x + (it.width || 0);
      }
      if (it.hasEOL) { out += '\n'; lastEndX = null; }
    }
    return out;
  }

  function itemsToLines(items) {
    const arr = [];
    for (const it of items) {
      if (!it.str || !it.str.trim()) continue;
      arr.push({
        s: it.str.replace(/\|/g, '/'),
        x: it.transform[4], y: it.transform[5], w: it.width || 0,
        h: Math.abs(it.transform[3]) || Math.abs(it.transform[0]) || 10
      });
    }
    arr.sort((a, b) => b.y - a.y);
    const lines = [];
    for (const it of arr) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.y - it.y) <= Math.max(2, it.h * 0.4)) last.items.push(it);
      else lines.push({ y: it.y, items: [it] });
    }
    return lines.map((l) => {
      l.items.sort((a, b) => a.x - b.x);
      let out = '';
      let prevEnd = null;
      let hMax = 0;
      for (const it of l.items) {
        if (prevEnd !== null) {
          const gap = it.x - prevEnd;
          if (gap > it.h * 0.8) out += ' | ';
          else if (gap > it.h * 0.1) out += ' ';
        }
        out += it.s;
        prevEnd = it.x + it.w;
        if (it.h > hMax) hMax = it.h;
      }
      return { text: out, y: l.y, h: hMax || 10 };
    });
  }

  async function extractFromFile(file) {
    const buf = await file.arrayBuffer();
    const name = file.name.toLowerCase();

    if (name.endsWith('.pdf')) {
      if (typeof pdfjsLib === 'undefined') throw new Error('pdf.js не завантажився (ймовірно, заблокував CSP сайту)');
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      const doc = await pdfjsLib.getDocument({ data: buf }).promise;
      let text = '';
      const lines = [];
      const emptyPages = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const t = itemsToText(content.items);
        if (t.replace(/\s/g, '').length < 20) emptyPages.push(i);
        text += t + '\n';
        lines.push(...itemsToLines(content.items));
      }
      return { text, tableRows: rowsFromPdfLines(lines), emptyPages };
    }

    if (name.endsWith('.docx') || name.endsWith('.docm')) {
      if (typeof mammoth === 'undefined') throw new Error('mammoth.js не завантажився (ймовірно, заблокував CSP сайту)');
      const raw = await mammoth.extractRawText({ arrayBuffer: buf });
      const tableRows = [];
      try {
        const html = await mammoth.convertToHtml({ arrayBuffer: buf });
        const dom = new DOMParser().parseFromString(html.value, 'text/html');
        dom.querySelectorAll('table').forEach((tbl, ti) => {
          tbl.querySelectorAll('tr').forEach((tr) => {
            const cells = Array.from(tr.querySelectorAll('th,td')).map((td) => collapseSpaces(td.textContent));
            if (cells.some(Boolean)) tableRows.push({ cells, tableId: ti, merged: false });
          });
        });
      } catch (e) {
        console.warn('[dzo-tender] не вдалося прочитати таблиці DOCX:', e);
      }
      return { text: raw.value, tableRows };
    }
    throw new Error('Підтримуються тільки .pdf, .docx та .docm');
  }

  // ---------- текстові утиліти ----------

  function collapseSpaces(s) { return s.replace(/\s+/g, ' ').trim(); }
  function capFirst(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function cleanName(s) {
    return collapseSpaces(s).replace(/\s+,/g, ',').replace(/,\s*,/g, ',').replace(/^[,\s]+|[,\s]+$/g, '');
  }
  function toCents(n) { return Math.round(n * 100); }
  function fmtMoney(c) { return (c / 100).toFixed(2); }
  function normalizeDk(code) {
    const d = code.replace(/-/g, '');
    return d.slice(0, 8) + '-' + d.slice(8);
  }

  function findDkCodes(text) {
    const labeled = [];
    const re = /ДК\s*[-–—]?\s*021\s*:\s*2015\s*(?::|[–—-])?\s*(\d{8}-?\d)/gi;
    let m;
    while ((m = re.exec(text)) !== null) labeled.push(normalizeDk(m[1]));
    if (labeled.length) return Array.from(new Set(labeled));
    const bare = [];
    const re2 = /\b(\d{8}-\d)\b/g;
    while ((m = re2.exec(text)) !== null) bare.push(m[1]);
    return Array.from(new Set(bare));
  }

  // Назва товару з тексту договору (запасний варіант, якщо немає таблиці)
  function parseGoodsName(text) {
    const m = text.match(/Покупець\s+вчасно\s+оплачує\s*(?:товар(?:и)?\s*:?)?\s*([\s\S]*?)\s*(?:,?\s*(?:який|яка|що)\s+відбудеться|\.)/i);
    if (!m) return '';
    let clause = m[1].replace(/\(\s*ДК[^)]*\)/gi, ' ');
    clause = collapseSpaces(clause).replace(/\s+,/g, ',').replace(/,\s+(для\s)/i, ' $1');
    return capFirst(cleanName(clause));
  }

  // Дата заходу: "який відбудеться 29 жовтня 2026 року" -> "29.10.2026"
  const MONTHS = { 'січня': 1, 'лютого': 2, 'березня': 3, 'квітня': 4, 'травня': 5, 'червня': 6, 'липня': 7, 'серпня': 8, 'вересня': 9, 'жовтня': 10, 'листопада': 11, 'грудня': 12 };
  function parseEventDate(text) {
    const flat = collapseSpaces(text);
    const m = flat.match(/відбудеться\s+(?:з\s+)?(\d{1,2})\s+([а-яіїєґ]+)\s+(\d{4})/i);
    if (m && MONTHS[m[2].toLowerCase()]) {
      return String(m[1]).padStart(2, '0') + '.' + String(MONTHS[m[2].toLowerCase()]).padStart(2, '0') + '.' + m[3];
    }
    const m2 = flat.match(/відбудеться\s+(\d{1,2})[.](\d{1,2})[.](\d{4})/i);
    if (m2) return m2[1].padStart(2, '0') + '.' + m2[2].padStart(2, '0') + '.' + m2[3];
    return '';
  }

  // ---------- сума і ПДВ ----------

  function detectVat(after) {
    if (/бе[зс]\s+пдв|пдв\s+не\s+нараховується|не\s+обкладається\s+пдв/.test(after)) return 'without';
    if (/(?<![а-яіїєґ])з\s+пдв|у\s+тому\s+числі\s+пдв|в\s+т\.?\s?ч\.?\s+пдв|включно\s+з\s+пдв|включаючи\s+пдв/.test(after)) return 'with';
    return '';
  }

  function findAmount(text) {
    const warnings = [];
    const flat = text.replace(/[\u00a0\u2007\u2009\u202f]/g, ' ').replace(/\s+/g, ' ');
    const NUM = '(?<!\\d)(\\d{1,3}(?:\\s\\d{3})+|\\d+)(?:\\s?[.,\\-–]\\s?(\\d{1,2})(?!\\d))?';
    const CUR = '\\s*(?:\\([^)]{0,150}\\)\\s*)?(?:грн|гривн|гривен|₴|UAH)[а-яіїє]*\\.?(?:\\s*(?:[.,\\-–]\\s*)?(\\d{1,2})\\s*коп)?';

    function build(intStr, decStr, kopStr) {
      const rub = intStr.replace(/\D/g, '');
      let kop = '00';
      if (decStr) kop = decStr.padEnd(2, '0');
      else if (kopStr) kop = kopStr.padStart(2, '0');
      return rub + '.' + kop;
    }

    const cands = [];
    function scoreContext(idx, len, base) {
      const before = flat.slice(Math.max(0, idx - 110), idx).toLowerCase();
      const near = flat.slice(Math.max(0, idx - 40), idx).toLowerCase();
      const after = flat.slice(idx + len, idx + len + 60).toLowerCase();
      let s = base;
      if (/(сум[аиуі]|вартіст|ціна|всього|усього|разом|загалом|складає|становить|розмір|запланован|орієнтовн|очікуван)/.test(before)) s += 3;
      if (/(загальна\s+(сума|вартість)|сума\s+(по|за)\s+(цьому|даному|цим)|ціна\s+договору|вартість\s+договору|всього\s+по\s+договору)/.test(before)) s += 2;
      if (/без\s+пдв|з\s+пдв|пдв\s+не\s+нараховується/.test(after)) s += 2;
      if (/(штраф|пен[яіеі]|неустойк|аванс|передоплат|відсот|процент|%|ліміт|бюджет)/.test(before.slice(-60))) s -= 4;
      if (/за\s+(одиницю|од\.|1\s*шт|шт)|ціна\s+за/.test(near)) s -= 3;
      if (/пдв[^а-я]{0,15}$/.test(near) && !/без\s+пдв/.test(near)) s -= 3;
      if (idx < flat.length * 0.4) s += 1;
      return { score: s, vat: detectVat(after) };
    }
    function push(amount, idx, len, base) {
      const c = scoreContext(idx, len, base);
      cands.push({ amount, score: c.score, vat: c.vat });
    }

    let re = new RegExp(NUM + CUR, 'gi');
    let m;
    while ((m = re.exec(flat)) !== null) push(build(m[1], m[2], m[3]), m.index, m[0].length, 1);

    re = new RegExp('(?:грн|UAH|₴)\\.?\\s*' + NUM + '(?!\\s*%)', 'gi');
    while ((m = re.exec(flat)) !== null) push(build(m[1], m[2]), m.index, m[0].length, 0);

    re = new RegExp('(?:разом|всього|усього|загалом)(?:\\s+по\\s+договору|\\s+до\\s+сплати)?\\s*:?\\s*' + NUM + '(?!\\d)(?!\\s*(?:%|шт|од\\b|одиниц))', 'gi');
    while ((m = re.exec(flat)) !== null) {
      const a = build(m[1], m[2]);
      if (parseFloat(a) >= 1) push(a, m.index, m[0].length, 3);
    }

    const byAmount = new Map();
    cands.forEach((c) => {
      if (parseFloat(c.amount) < 1) return;
      const cur = byAmount.get(c.amount) || { amount: c.amount, best: -99, count: 0, vat: '' };
      if (c.score > cur.best) { cur.best = c.score; if (c.vat) cur.vat = c.vat; }
      else if (!cur.vat && c.vat) cur.vat = c.vat;
      cur.count += 1;
      byAmount.set(c.amount, cur);
    });
    const all = Array.from(byAmount.values());
    const ranked = all
      .map((c) => ({ ...c, final: c.best + Math.min(c.count - 1, 3) }))
      .filter((c) => c.best > 0)
      .sort((a, b) => b.final - a.final);

    let amount = '';
    let vat = '';
    if (ranked.length) {
      amount = ranked[0].amount;
      vat = ranked[0].vat;
      const rivals = ranked.filter((c, i) => i > 0 && c.final >= ranked[0].final - 1);
      if (rivals.length) warnings.push('Кілька правдоподібних сум: ' + [ranked[0], ...rivals].map((c) => c.amount).join(', ') + '. Взято ' + amount + ' — перевірте.');
      else if (ranked[0].final < 4) warnings.push('Суму знайдено з низькою впевненістю (' + amount + ') — перевірте.');
    } else {
      warnings.push('Не знайшов суму в тексті — впишіть вручну.');
    }
    return { amount, vat, warnings, candidates: all.map((c) => ({ amount: c.amount, vat: c.vat })) };
  }

  // ---------- таблиця специфікації ----------

  const UNIT_RE = /^(шт|од|одиниць|компл|комплект|набір|пар|пара|м|м2|кг|л|упак|уп|посл|послуга|послуг)\.?$/i;
  const NUM_CELL_RE = /^\d{1,3}(?:[\s\u00a0]\d{3})+(?:[.,]\d{1,3})?$|^\d+(?:[.,]\d{1,3})?$/;
  const STOP_RE = /^(разом|всього|усього|підсумок|юридичн|реквізит|підпис|від\s+продавц|від\s+покупц|продавець|покупець|виконавець|замовник)/i;

  function parseNum(s) { return parseFloat(s.replace(/[\s\u00a0]/g, '').replace(',', '.')); }

  function pickDk(s) {
    let m = s.match(/ДК\s*[-–—]?\s*021\s*:\s*2015\s*(?::|[–—-])?\s*(\d{8}-?\d)/i);
    if (m) return normalizeDk(m[1]);
    m = s.match(/(?<!\d)(\d{8}-\d)(?!\d)/);
    return m ? m[1] : '';
  }

  function stripDk(s) {
    return s
      .replace(/\(?\s*ДК\s*[-–—]?\s*021\s*:\s*2015\s*(?::|[–—-])?\s*\d{8}-?\d\s*\)?/gi, ' ')
      .replace(/(?<!\d)\d{8}-\d(?!\d)/g, ' ')
      .replace(/\(?\s*ДК\s*[-–—]?\s*021(?:\s*:\s*2015)?\s*:?/gi, ' ');
  }

  function findTriple(nums) {
    for (let i = nums.length - 3; i >= 0; i--) {
      const q = nums[i].v, p = nums[i + 1].v, s = nums[i + 2].v;
      if (q > 0 && p > 0 && s > 0 && Math.abs(q * p - s) <= 0.02) return i;
    }
    return -1;
  }

  function tokenizeNumbers(s, grouping) {
    const re = grouping
      ? /(?<![\d.,])\d{1,3}(?:[ \u00a0]\d{3})+(?:[.,]\d{1,3})?(?!\d)|(?<![\d.,])\d+(?:[.,]\d{1,3})?(?!\d)/g
      : /(?<![\d.,])\d+(?:[.,]\d{1,3})?(?!\d)/g;
    const out = [];
    let m;
    while ((m = re.exec(s)) !== null) out.push({ str: m[0], v: parseNum(m[0]), idx: m.index, end: m.index + m[0].length });
    return out;
  }

  function tidyRowName(s) {
    let t = stripDk(s);
    t = collapseSpaces(t).replace(/^\d{1,3}[.)]?\s+(?=\D)/, '');
    t = t.replace(/\s+(шт|од|компл|комплект|набір|пар|пара|упак|уп)\.?$/i, '');
    return cleanName(t);
  }

  function parseSpecRow(cellsIn, merged) {
    const cells = cellsIn.map((c) => collapseSpaces(c)).filter(Boolean);
    const joined = cells.join(' ');
    const dk = pickDk(joined);
    if (!dk) return null;

    const segs = cells.map((c) => (NUM_CELL_RE.test(c) ? { num: true, str: c, v: parseNum(c) } : { num: false, str: c }));
    const nums = segs.filter((s) => s.num);
    const ti = findTriple(nums);
    if (ti >= 0) {
      const qSeg = nums[ti];
      const sSeg = nums[ti + 2];
      const qIdx = segs.indexOf(qSeg);
      const sIdx = segs.indexOf(sSeg);
      const beforeText = segs.slice(0, qIdx).filter((s) => !s.num).map((s) => s.str).filter((t) => !UNIT_RE.test(t));
      let name = beforeText.join(' ');
      if (merged) {
        const afterText = segs.slice(sIdx + 1).filter((s) => !s.num).map((s) => s.str)
          .filter((t) => !UNIT_RE.test(t) && !/^(пдв|без пдв|з пдв|грн\.?)$/i.test(t));
        name = name + ' ' + afterText.join(' ');
      }
      return { name: tidyRowName(name), dk, qty: qSeg.v, price: nums[ti + 1].v, sum: sSeg.v, uncertain: false };
    }

    const t = stripDk(joined);
    for (const grouping of [true, false]) {
      const toks = tokenizeNumbers(t, grouping);
      const k = findTriple(toks);
      if (k >= 0) {
        let name = t.slice(0, toks[k].idx);
        if (merged) name += ' ' + t.slice(toks[k + 2].end).replace(/(?<![\d.,])\d+(?:[.,]\d+)?(?!\d)/g, ' ');
        return { name: tidyRowName(name), dk, qty: toks[k].v, price: toks[k + 1].v, sum: toks[k + 2].v, uncertain: true };
      }
    }

    const toks = tokenizeNumbers(t, true);
    if (toks.length >= 2) {
      return { name: tidyRowName(t.slice(0, toks[1].idx)), dk, qty: null, price: null, sum: toks[toks.length - 1].v, uncertain: true };
    }
    return null;
  }

  const HEADER_RE = /найменування|кількість|виміру|загальна|ціна\s+за|сума,|021\s*:\s*2015|^грн\.?$|^п\/п/i;
  const HAS_LETTERS_RE = /[A-Za-zА-Яа-яІіЇїЄєҐґ]{2,}/;

  function ordinalRows(lines) {
    const rows = [];
    let cur = null;
    let expected = 1;
    let tableId = 0;
    let anyRowInTable = false;
    const kind = lines.map(() => 'text');

    lines.forEach((ln, k) => {
      const cells = ln.cells;
      const joined = cells.join(' ');
      const m = cells[0].match(/^(\d{1,3})[.)]?(?:\s+\S.*)?$/);
      const n = m ? parseInt(m[1], 10) : -1;
      if (n >= 1 && (n === expected || n === 1)) {
        if (n === 1 && anyRowInTable) tableId++;
        anyRowInTable = true;
        expected = n + 1;
        cur = { k, ln, tableId, above: [], below: [] };
        rows.push(cur);
        kind[k] = 'row';
      } else if (STOP_RE.test(joined)) {
        kind[k] = 'stop';
      } else if (HEADER_RE.test(joined)) {
        kind[k] = 'header';
      } else if (!HAS_LETTERS_RE.test(joined) || pickDk(joined)) {
        kind[k] = 'skip';
      }
    });

    const blocked = (a, b) => {
      for (let i = Math.min(a, b) + 1; i < Math.max(a, b); i++) {
        if (kind[i] === 'stop' || kind[i] === 'header') return true;
      }
      return false;
    };

    lines.forEach((ln, k) => {
      if (kind[k] !== 'text') return;
      let prev = null;
      let next = null;
      for (const r of rows) {
        if (r.k < k) prev = r;
        else if (r.k > k && !next) next = r;
      }
      const maxD = Math.max(ln.h, 10) * 2.4;
      const dPrev = (prev && !blocked(prev.k, k)) ? Math.abs(prev.ln.y - ln.y) : Infinity;
      const dNext = (next && !blocked(k, next.k)) ? Math.abs(next.ln.y - ln.y) : Infinity;
      if (dPrev > maxD && dNext > maxD) return;
      if (dPrev <= dNext) { if (prev.below.length < 4) prev.below.push(ln); }
      else if (next.above.length < 2) next.above.push(ln);
    });

    return rows.map((r) => {
      let own = r.ln.cells.slice();
      if (own.length > 1 && /^\d{1,3}[.)]?$/.test(own[0])) own = own.slice(1);
      const cells = [];
      r.above.forEach((a) => cells.push(...a.cells));
      cells.push(...own);
      r.below.forEach((b) => cells.push(...b.cells));
      return { cells, tableId: r.tableId, merged: r.above.length + r.below.length > 0 };
    });
  }

  function rowsFromPdfLines(lines) {
    const parsedLines = lines
      .map((l) => ({ cells: l.text.split('|').map((s) => s.trim()).filter(Boolean), y: l.y, h: l.h }))
      .filter((l) => l.cells.length);

    const viaOrdinals = ordinalRows(parsedLines);
    if (viaOrdinals.some((r) => parseSpecRow(r.cells, r.merged))) return viaOrdinals;

    const out = [];
    let tableId = 0;
    parsedLines.forEach((ln) => {
      const j = ln.cells.join(' ');
      if (!pickDk(j) && /найменування|кількість/i.test(j)) tableId++;
      if (pickDk(j)) out.push({ cells: ln.cells, tableId, merged: false });
    });
    return out;
  }

  function normKey(s) { return (s || '').toLowerCase().replace(/[^a-zа-яіїєґ0-9]+/gi, ''); }

  function buildSpecItems(tableRows) {
    const all = [];
    tableRows.forEach((r) => {
      const it = parseSpecRow(r.cells, r.merged);
      if (it) { it.tableId = r.tableId; all.push(it); }
    });
    const byNameKey = new Map();
    const byNumKey = new Map();
    const items = [];
    for (const it of all) {
      const k1 = normKey(it.name) + '|' + it.dk + '|' + (it.qty == null ? '' : it.qty);
      const k2 = it.qty == null ? '' : [it.dk, it.qty, it.price, it.sum].join('|');
      const p1 = byNameKey.get(k1);
      const p2 = k2 ? byNumKey.get(k2) : null;
      const prev = (p1 && p1.tableId !== it.tableId) ? p1 : ((p2 && p2.tableId !== it.tableId) ? p2 : null);
      if (prev) continue;
      if (!p1) byNameKey.set(k1, it);
      if (k2 && !p2) byNumKey.set(k2, it);
      items.push(it);
    }
    return items;
  }

  // ---------- розбір договору ----------

  function parseContract(text, tableRows) {
    const res = { amount: '', vat: '', kind: 'goods', date: '', rows: [], warnings: [] };

    const am = findAmount(text);
    res.amount = am.amount;
    res.vat = am.vat;
    am.warnings.forEach((w) => res.warnings.push(w));

    const isGoods = /Покупець\s+вчасно\s+оплачує/i.test(text);
    const isService = /Замовник\s+доручає|Виконавець\s+зобов[’'ʼ`]язується/i.test(text);
    if (isGoods && !isService) res.kind = 'goods';
    else if (isService && !isGoods) res.kind = 'service';
    else if (isGoods && isService) {
      const gi = text.search(/Покупець\s+вчасно\s+оплачує/i);
      const si = text.search(/Замовник\s+доручає|Виконавець\s+зобов[’'ʼ`]язується/i);
      res.kind = gi <= si ? 'goods' : 'service';
      res.warnings.push('У тексті є і товар, і послуга — обрано те, що раніше; перевірте тип.');
    } else {
      const hasSup = /Постачальник/i.test(text);
      const hasExe = /Виконавець/i.test(text);
      if (hasExe && !hasSup) res.kind = 'service';
      else res.kind = 'goods';
    }

    res.date = parseEventDate(text);
    if (!res.date) res.warnings.push('Дату заходу в договорі не знайшов — впишіть вручну.');

    const unit = res.kind === 'service' ? 'послуга' : 'штука';
    const items = buildSpecItems(tableRows || []);

    if (items.length) {
      const totCents = items.reduce((s, i) => s + toCents(i.sum || 0), 0);
      const tot = fmtMoney(totCents);
      const match = am.candidates.find((c) => c.amount === tot);
      if (match) {
        if (match.amount !== res.amount) { res.amount = match.amount; res.vat = match.vat || res.vat; }
      } else if (res.amount) {
        res.warnings.push('Сума позицій (' + tot + ') не збігається з сумою договору (' + res.amount + ') — перевірте.');
      } else {
        res.amount = tot;
      }
      if (items.some((i) => i.uncertain)) res.warnings.push('Частину рядків специфікації розібрано "на око" — перевірте кількість і назви.');
      items.forEach((it) => {
        res.rows.push({
          name: capFirst(it.name || ''),
          qty: it.qty != null ? String(it.qty) : '1',
          unit,
          dk: it.dk,
          sum: it.sum
        });
      });
    } else {
      const codes = findDkCodes(text);
      const name = res.kind === 'goods' ? parseGoodsName(text) : '';
      res.warnings.push('Таблицю специфікації не розпізнано — створено один предмет, перевірте всі поля.');
      res.rows.push({ name, qty: '1', unit, dk: codes[0] || '', sum: res.amount ? parseFloat(res.amount) : null });
    }
    return res;
  }

  // ---------- сторінка тендера: допоміжне ----------

  function getBlocks() { return Array.from(document.querySelectorAll('.tenderItemElement')); }

  function fieldIn(block, selector) { return block.querySelector(selector); }

  // шукаємо поле в блоці за частиною name (кілька варіантів)
  function findByName(block, tag, parts) {
    const els = Array.from(block.querySelectorAll(tag));
    for (const p of parts) {
      const el = els.find((e) => (e.getAttribute('name') || '').toLowerCase().includes(p.toLowerCase()));
      if (el) return el;
    }
    return null;
  }

  function pageAmountInput() {
    return document.querySelector('input[name="data[value][amount]"]');
  }
  function pageVatSelect() {
    return document.querySelector('select[name="data[value][valueAddedTaxIncluded]"]');
  }

  const DESC_SEL = 'input.inputDescription, input[name*="[description]"]';

  // Перемикач (a.accordionOpen) саме блоку "Специфікація закупівлі".
  function findSpecToggle() {
    const all = Array.from(document.querySelectorAll('a.accordionOpen'));
    if (!all.length) return null;

    // 1) за положенням: найближчий перемикач ПЕРЕД першим блоком предмета
    const first = getBlocks()[0];
    if (first) {
      for (let n = first.parentElement; n; n = n.parentElement) {
        const cand = Array.from(n.querySelectorAll('a.accordionOpen')).filter((a) =>
          !first.contains(a) && (first.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_PRECEDING));
        if (cand.length) return cand[cand.length - 1];
      }
    }

    // 2) за текстом заголовка поруч
    for (const a of all) {
      let n = a;
      for (let i = 0; i < 4 && n; i++, n = n.parentElement) {
        const head = (n.textContent || '').trim().slice(0, 200).toLowerCase();
        if (head.includes('специфікац')) return a;
      }
    }
    return null;
  }

  function isAccordionActive(a) {
    let n = a;
    for (let i = 0; i < 4 && n; i++, n = n.parentElement) {
      if (n.classList && n.classList.contains('accordionActive')) return true;
    }
    return false;
  }

  // Відкриваємо специфікацію, якщо вона закрита (відкриту повторним кліком не закриваємо).
  async function ensureSpecOpen() {
    const openBlock = () => {
      const b = getBlocks()[0];
      return b && isVisible(b.querySelector(DESC_SEL)) ? b : null;
    };

    if (openBlock()) {
      log('· Специфікація вже відкрита');
      return true;
    }

    const toggle = findSpecToggle();
    if (!toggle) {
      log('⚠ Не знайшов перемикач "Специфікація закупівлі" (a.accordionOpen) — відкрийте блок вручну і натисніть ще раз.');
      return false;
    }

    // спроба 1: клік, якщо блок ще не має accordionActive
    if (!isAccordionActive(toggle)) toggle.click();
    let ok = await waitFor(openBlock, 3500);

    // спроба 2: блок усе ще не видно, тобто він точно закритий — клікаємо ще раз (через jQuery сторінки)
    if (!ok) {
      try {
        if ($) $(toggle).trigger('click');
        else toggle.click();
      } catch (e) {
        toggle.click();
      }
      ok = await waitFor(openBlock, 4000);
    }

    if (!ok) {
      log('⚠ Специфікація закупівлі не відкрилась — відкрийте її вручну і натисніть ще раз.');
      return false;
    }
    log('✓ Специфікацію відкрито');
    return true;
  }

  async function ensureBlocks(n) {
    let blocks = getBlocks();
    if (!blocks.length) {
      log('⚠ Не знайшов жодного блоку .tenderItemElement.');
      return false;
    }
    while (blocks.length < n) {
      const add = Array.from(document.querySelectorAll('a.addMultiItem'))
        .find((a) => /додати\s+предмет\s+закупівлі/i.test(a.textContent));
      if (!add) {
        log('⚠ Не знайшов кнопку "Додати предмет закупівлі".');
        return false;
      }
      const before = blocks.length;
      add.click();
      const grew = await waitFor(() => getBlocks().length > before, 6000);
      if (!grew) {
        log('⚠ Новий предмет не з’явився після кліку — додайте вручну.');
        return false;
      }
      await sleep(500);
      blocks = getBlocks();
    }
    return true;
  }

  // ДК через довідник — у межах конкретного блока
  async function fillDkInBlock(block, code, label) {
    if (!code) { log(`⚠ ${label}: ДК не задано`); return false; }
    const existing = Array.from(block.querySelectorAll('input')).find((i) => (i.value || '').includes(code));
    if (existing) { log(`✓ ${label}: ДК ${code} вже стоїть`); return true; }

    const link = block.querySelector('a.choiceClass[data-class="ДК021"]');
    if (!link) { log(`⚠ ${label}: не знайшов "Визначити за довідником" у блоці`); return false; }

    const before = document.querySelectorAll('div.info iframe').length;
    link.click();
    const iframe = await waitFor(() => {
      const f = Array.from(document.querySelectorAll('div.info iframe'));
      return f.length > before ? f[f.length - 1] : null;
    }, 5000);
    if (!iframe) { log(`⚠ ${label}: вікно довідника не з’явилось`); return false; }

    const doc = await waitFor(() => {
      try { const d = iframe.contentDocument; return d && d.getElementById('search') ? d : null; } catch (e) { return null; }
    }, 6000);
    if (!doc) { log(`⚠ ${label}: не зміг зазирнути у вікно довідника`); return false; }

    const search = doc.getElementById('search');
    search.value = code;
    ['keydown', 'keyup', 'input', 'change'].forEach((t) => fire(search, t));

    const nodeId = 'cl_DK021_' + code.replace(/-/g, '_');
    const node = await waitFor(() => doc.getElementById(nodeId), 5000);
    if (!node) { log(`⚠ ${label}: не знайшов код ${code} у довіднику`); return false; }
    (node.querySelector('a') || node).click();
    await sleep(300);

    const btn = doc.getElementById('select')
      || Array.from(doc.querySelectorAll('button, a, input[type="button"], input[type="submit"]'))
        .find((b) => (b.textContent || b.value || '').trim() === 'Вибрати');
    if (!btn) { log(`⚠ ${label}: не знайшов кнопку "Вибрати"`); return false; }
    btn.click();
    await sleep(500);
    return true;
  }

  // чи містить значення поля дату дд.мм.рррр (у будь-якому поширеному форматі)
  function sameDate(val, ddmmyyyy) {
    const p = ddmmyyyy.split('.');
    if (p.length !== 3) return false;
    const [d, m, y] = p;
    const v = String(val || '');
    return [`${d}.${m}.${y}`, `${y}-${m}-${d}`, `${d}/${m}/${y}`, `${d}-${m}-${y}`].some((f) => v.includes(f));
  }

  // кінцевий строк: поле з "enddate" в name, інакше останнє поле-календар у блоці
  function findEndDateInput(block) {
    const byName = findByName(block, 'input', ['enddate', 'end_date', '[end']);
    if (byName) return byName;
    const dp = Array.from(block.querySelectorAll('input')).filter((i) =>
      i.classList.contains('hasDatepicker') || /date/i.test(i.getAttribute('name') || ''));
    return dp.length ? dp[dp.length - 1] : null;
  }

  const UA_MONTHS = ['січень', 'лютий', 'березень', 'квітень', 'травень', 'червень', 'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень'];

  // Обираємо дату в календарі (jQuery UI datepicker): відкриваємо, гортаємо до місяця, клікаємо по дню.
  async function setDateField(el, value) {
    if (!el) return false;
    const p = value.split('.');
    const day = parseInt(p[0], 10);
    const month = parseInt(p[1], 10) - 1;
    const year = parseInt(p[2], 10);
    if (!day || isNaN(month) || !year) return false;

    try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* нічого */ }
    el.focus();
    el.click();
    try { if ($ && $(el).datepicker) $(el).datepicker('show'); } catch (e) { /* нічого */ }

    const getBox = () => {
      const d = document.getElementById('ui-datepicker-div');
      return d && isVisible(d) && d.querySelector('.ui-datepicker-calendar') ? d : null;
    };
    const box0 = await waitFor(getBox, 3000);

    if (box0) {
      for (let i = 0; i < 48; i++) {
        const box = getBox();
        if (!box) break;
        const mEl = box.querySelector('.ui-datepicker-month');
        const yEl = box.querySelector('.ui-datepicker-year');
        const m = mEl ? UA_MONTHS.indexOf(mEl.textContent.trim().toLowerCase()) : -1;
        const y = yEl ? parseInt(yEl.textContent, 10) : NaN;
        if (m < 0 || isNaN(y)) break;
        const diff = (year - y) * 12 + (month - m);
        if (diff === 0) {
          const cell = Array.from(box.querySelectorAll('td[data-handler="selectDay"]')).find((td) =>
            td.getAttribute('data-month') === String(month)
            && td.getAttribute('data-year') === String(year)
            && td.textContent.trim() === String(day));
          if (cell) {
            (cell.querySelector('a') || cell).click();
            await sleep(300);
            if (sameDate(el.value, value)) return true;
          }
          break;
        }
        const nav = box.querySelector(diff > 0 ? '.ui-datepicker-next' : '.ui-datepicker-prev');
        if (!nav) break;
        nav.click();
        await sleep(120);
      }
    }

    // запасний варіант: через jQuery, а потім — прямий запис значення
    try {
      if ($ && $(el).datepicker) $(el).datepicker('setDate', new Date(year, month, day));
    } catch (e) { /* нічого */ }
    if (!sameDate(el.value, value)) el.value = value;
    fire(el, 'input');
    fire(el, 'change');
    fire(el, 'blur');
    return sameDate(el.value, value);
  }

  async function fillPlace(block, label) {
    const country = findByName(block, 'select', ['countryName', 'country']);
    if (country) {
      const opt = findOptionByText(country, CONST.country);
      if (opt) setSelectValue(country, opt.value);
      else log(`⚠ ${label}: у списку країн немає "${CONST.country}"`);
    } else {
      log(`⚠ ${label}: не знайшов поле "Країна"`);
    }

    const region = findByName(block, 'select', ['[region]', 'region']);
    if (region) {
      const ready = await waitForOptions(region, 8000);
      if (!ready) {
        log(`⚠ ${label}: список областей не підвантажився`);
      } else {
        const opt = findOptionByText(region, CONST.regionText);
        if (opt) setSelectValue(region, opt.value);
        else log(`⚠ ${label}: не знайшов варіант "${CONST.regionText}…" у списку областей/районів`);
      }
    } else {
      log(`⚠ ${label}: не знайшов поле "Область"`);
    }
    await sleep(300);

    const loc = findByName(block, 'input', ['[locality]', 'locality']);
    if (!setInputValue(loc, CONST.locality)) log(`⚠ ${label}: не знайшов "Населений пункт"`);
    const st = findByName(block, 'input', ['[streetAddress]', 'street']);
    if (!setInputValue(st, CONST.street)) log(`⚠ ${label}: не знайшов "Адреса"`);
    const pc = findByName(block, 'input', ['[postalCode]', 'postal']);
    if (!setInputValue(pc, CONST.postalCode)) log(`⚠ ${label}: не знайшов "Індекс"`);
  }

  async function fillBlock(block, row, date, idx) {
    const label = `Предмет ${idx + 1}`;
    block.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // опис
    const desc = block.querySelector('input.inputDescription') || findByName(block, 'input', ['[description]']);
    if (!setInputValue(desc, row.name)) log(`⚠ ${label}: не знайшов поле "Опис окремої частини"`);

    // кількість: лише число
    const qty = findByName(block, 'input', ['[quantity]', 'quantity']);
    const qtyClean = String(row.qty).replace(/[^\d.]/g, '');
    if (!setInputValue(qty, qtyClean)) log(`⚠ ${label}: не знайшов поле "Кількість"`);

    // одиниця виміру — за текстом
    const unit = findByName(block, 'select', ['[unit]', 'unit', 'measure']);
    if (unit) {
      await waitForOptions(unit, 4000);
      const opt = findOptionByText(unit, row.unit);
      if (opt) setSelectValue(unit, opt.value);
      else { log(`⚠ ${label}: немає одиниці "${row.unit}" у списку — оберіть вручну`); }
    } else {
      log(`⚠ ${label}: не знайшов поле "Одиниця виміру"`);
    }

    // ДК
    await fillDkInBlock(block, row.dk, label);

    // місце поставки
    await fillPlace(block, label);

    // кінцевий строк (початкову дату не чіпаємо)
    if (date) {
      const end = findEndDateInput(block);
      if (!end) log(`⚠ ${label}: не знайшов поле кінцевого строку — оберіть дату вручну`);
      else if (!(await setDateField(end, date))) log(`⚠ ${label}: календар не прийняв дату ${date} — оберіть вручну`);
    }
  }

  function readBack(block, row, date, idx) {
    const label = `Предмет ${idx + 1}`;
    const desc = block.querySelector('input.inputDescription') || findByName(block, 'input', ['[description]']);
    if (desc && desc.value === row.name) log(`✓ ${label}: опис "${row.name}"`);
    else log(`⚠ ${label}: опис не збігається (на сторінці "${desc ? desc.value : '—'}")`);

    const qty = findByName(block, 'input', ['[quantity]', 'quantity']);
    if (qty && parsePageNumber(qty.value) === parsePageNumber(row.qty)) log(`✓ ${label}: кількість ${qty.value}`);
    else log(`⚠ ${label}: кількість на сторінці "${qty ? qty.value : '—'}", очікувалось ${row.qty}`);

    const unit = findByName(block, 'select', ['[unit]', 'unit', 'measure']);
    const ut = unit && unit.selectedIndex >= 0 ? unit.options[unit.selectedIndex].textContent.trim() : '';
    if (ut && ut.toLowerCase().includes(row.unit.toLowerCase())) log(`✓ ${label}: одиниця "${ut}"`);
    else log(`⚠ ${label}: одиниця на сторінці "${ut || '—'}", очікувалось "${row.unit}"`);

    const hasDk = Array.from(block.querySelectorAll('input')).some((i) => (i.value || '').includes(row.dk));
    if (hasDk) log(`✓ ${label}: ДК ${row.dk}`);
    else log(`⚠ ${label}: ДК ${row.dk} на сторінці не видно`);

    if (date) {
      const end = findEndDateInput(block);
      if (end && sameDate(end.value, date)) log(`✓ ${label}: кінцевий строк ${end.value}`);
      else log(`⚠ ${label}: кінцевий строк на сторінці "${end ? end.value : '—'}", очікувалось ${date}`);
    }
  }

  // ---------- перевірки сторінки: ПДВ виправляємо за договором, решту лише перевіряємо ----------

  function verifyAndFixPage(p) {
    const contractAmount = parsePageNumber(p.amount);

    // ПДВ
    const vatEl = pageVatSelect();
    if (!vatEl) {
      log('⚠ Не знайшов селектор "з ПДВ / без ПДВ" — перевірте ПДВ вручну.');
    } else if (!p.vat) {
      log('⚠ ПДВ у договорі не визначено — оберіть "з ПДВ / без ПДВ" на сторінці вручну.');
    } else {
      const want = p.vat === 'with' ? 'true' : 'false';
      const wantText = p.vat === 'with' ? 'з ПДВ' : 'без ПДВ';
      if (vatEl.value === want) {
        log('✓ ПДВ збігається: ' + wantText);
      } else {
        setSelectValue(vatEl, want);
        if (vatEl.value === want) log('✓ ПДВ виправлено на "' + wantText + '"');
        else log('⚠ Не вдалося виставити "' + wantText + '" — виправте ПДВ вручну.');
      }
    }

    // очікувана вартість: лише перевірка
    const amountEl = pageAmountInput();
    if (!amountEl) {
      log('⚠ Не знайшов поле очікуваної вартості — перевірте суму вручну.');
    } else if (contractAmount == null) {
      log('⚠ Суму договору в панелі не вказано.');
    } else {
      const pageAmount = parsePageNumber(amountEl.value);
      if (pageAmount != null && Math.abs(pageAmount - contractAmount) < 0.005) log('✓ Очікувана вартість збігається: ' + amountEl.value);
      else log('⚠ Очікувана вартість на сторінці "' + amountEl.value + '", а сума договору ' + p.amount + ' — виправте.');
    }

    // сума всіх позицій проти суми договору
    const sumRows = p.rows.reduce((s, r) => s + toCents(r.sum || 0), 0);
    if (contractAmount != null && Math.abs(sumRows - toCents(contractAmount)) > 1) {
      log('⚠ Сума позицій ' + fmtMoney(sumRows) + ' не збігається з сумою договору ' + p.amount + ' — перевірте позиції.');
    }
  }

  // Діагностика: список полів першого блоку + сума/ПДВ/радіокнопки. Виводиться в прокручуване поле, яке можна скопіювати.
  function dumpFields() {
    const out = document.getElementById('dzo-tn-diag');
    const lines = [];
    const desc = (e) => {
      let s = `${e.tagName.toLowerCase()}${e.type ? '[' + e.type + ']' : ''} name="${e.getAttribute('name') || ''}" class="${e.className || ''}" value="${String(e.value || '').slice(0, 40)}"`;
      if (e.readOnly) s += ' READONLY';
      if (e.disabled) s += ' DISABLED';
      if (e.tagName === 'SELECT') {
        s += ' options=[' + Array.from(e.options).slice(0, 12).map((o) => o.value + ':' + o.textContent.trim()).join(' | ')
          + (e.options.length > 12 ? ' … всього ' + e.options.length : '') + ']';
      }
      return s;
    };

    const blocks = getBlocks();
    lines.push('== ПЕРШИЙ БЛОК ПРЕДМЕТА (блоків на сторінці: ' + blocks.length + ') ==');
    if (!blocks.length) lines.push('Блоків .tenderItemElement немає (специфікація закрита?)');
    else blocks[0].querySelectorAll('input, select, textarea, a.choiceClass').forEach((e) => lines.push(desc(e)));

    lines.push('', '== СТОРІНКА: сума / ПДВ / радіокнопки ==');
    [pageAmountInput(), pageVatSelect()].forEach((e) => { if (e) lines.push(desc(e)); });
    document.querySelectorAll('input[type="radio"]').forEach((r) => {
      const lab = r.closest('label') ? r.closest('label').textContent : (r.parentElement ? r.parentElement.textContent : '');
      lines.push(`radio name="${r.getAttribute('name') || ''}" value="${r.value}" checked=${r.checked} label="${collapseSpaces(lab).slice(0, 80)}"`);
    });

    const text = lines.join('\n');
    console.log('[dzo-tender] діагностика:\n' + text);
    if (out) {
      out.value = text;
      out.style.display = 'block';
      out.scrollTop = 0;
    }
  }

  // ---------- передача договору на етап 3 (панель переможця) ----------

  const CTX_KEY = 'dzo_contract_ctx';

  function saveCtx(file, text, p) {
    try {
      localStorage.setItem(CTX_KEY, JSON.stringify({
        ts: Date.now(), name: file.name, text: text,
        amount: p.amount, vat: p.vat, date: p.date
      }));
    } catch (e) { console.warn('[dzo-tender] не вдалося зберегти договір для етапу 3:', e); }
  }

  // Користувач міг виправити суму/ПДВ у панелі — оновлюємо збережене
  function updateCtxFromPanel(p) {
    try {
      const old = JSON.parse(localStorage.getItem(CTX_KEY) || 'null');
      if (old) {
        old.amount = p.amount; old.vat = p.vat; old.date = p.date;
        localStorage.setItem(CTX_KEY, JSON.stringify(old));
      }
    } catch (e) { /* нічого */ }
  }

  // ---------- панель ----------

  function readPanel() {
    const rows = Array.from(document.querySelectorAll('#dzo-tn-rows .tn-row')).map((el) => ({
      name: collapseSpaces(el.querySelector('.tn-name').value),
      qty: el.querySelector('.tn-qty').value.trim(),
      unit: el.querySelector('.tn-unit').value.trim(),
      dk: el.querySelector('.tn-dk').value.trim(),
      sum: parseFloat(el.dataset.sum || '0') || 0
    }));
    return {
      amount: document.getElementById('dzo-tn-amount').value.replace(',', '.').trim(),
      vat: document.getElementById('dzo-tn-vat').value,
      date: document.getElementById('dzo-tn-date').value.trim(),
      kind: document.getElementById('dzo-tn-kind').value,
      rows
    };
  }

  function autosize(el) {
    if (!el || el.tagName !== 'TEXTAREA') return;
    el.style.height = 'auto';
    el.style.height = (el.scrollHeight + 2) + 'px';
  }

  function renderRows(rows) {
    const box = document.getElementById('dzo-tn-rows');
    box.innerHTML = '';
    rows.forEach((r, i) => {
      const d = document.createElement('div');
      d.className = 'tn-row';
      d.dataset.sum = String(r.sum || 0);
      d.innerHTML = `
        <div class="tn-title">Предмет ${i + 1}</div>
        <textarea class="tn-name" rows="1"></textarea>
        <div class="tn-line">
          <input type="text" class="tn-qty" placeholder="к-сть">
          <input type="text" class="tn-unit" placeholder="одиниця">
          <input type="text" class="tn-dk" placeholder="ДК">
        </div>`;
      d.querySelector('.tn-name').value = r.name;
      d.querySelector('.tn-qty').value = r.qty;
      d.querySelector('.tn-unit').value = r.unit;
      d.querySelector('.tn-dk').value = r.dk;
      box.appendChild(d);
      const ta = d.querySelector('.tn-name');
      ta.addEventListener('input', () => autosize(ta));
      autosize(ta);
    });
  }

  async function handleFile(file) {
    logBox.innerHTML = '';
    log(`· Читаю файл "${file.name}"`);
    try {
      const ex = await extractFromFile(file);
      if (ex.text.replace(/\s/g, '').length < 200) log('⚠ З файлу дістало дуже мало тексту — схоже на скан без текстового шару.');
      else if (ex.emptyPages && ex.emptyPages.length) log('⚠ Сторінки ' + ex.emptyPages.join(', ') + ' — це картинка без тексту, їх не прочитано (там може бути дата заходу, назва, сума). Перевірте поля.');
      const p = parseContract(ex.text, ex.tableRows);
      document.getElementById('dzo-tn-amount').value = p.amount;
      document.getElementById('dzo-tn-vat').value = p.vat || '';
      document.getElementById('dzo-tn-kind').value = p.kind;
      document.getElementById('dzo-tn-date').value = p.date;
      renderRows(p.rows);
      saveCtx(file, ex.text, p);
      p.warnings.forEach((w) => log('⚠ ' + w));
      log(`✓ Розпізнано: сума ${p.amount || '—'}, ПДВ ${p.vat === 'with' ? 'з ПДВ' : (p.vat === 'without' ? 'без ПДВ' : '?')}, позицій ${p.rows.length}, дата ${p.date || '—'}`);
    } catch (e) {
      log('⚠ Помилка розпізнавання: ' + e.message);
    }
  }

  async function fillAll() {
    const p = readPanel();
    updateCtxFromPanel(p);
    logBox.innerHTML = '';

    // дата: приймаємо дд.мм.рррр, дд/мм/рррр, дд-мм-рррр
    if (!p.date) {
      log('⚠ Дату заходу не вказано (у договорі не знайдено) — впишіть її в панелі, інакше кінцевий строк оберіть вручну.');
    } else {
      const dm = p.date.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
      if (dm) p.date = dm[1].padStart(2, '0') + '.' + dm[2].padStart(2, '0') + '.' + dm[3];
      else {
        log('⚠ Дату "' + p.date + '" не розпізнано — введіть у форматі дд.мм.рррр.');
        p.date = '';
      }
    }
    if (!p.rows.length) { log('⚠ Немає предметів — спочатку завантажте договір.'); return; }
    if (p.rows.some((r) => !r.name || !r.dk)) log('⚠ У деяких предметів порожня назва або ДК — заповню що можу.');

    verifyAndFixPage(p);

    const opened = await ensureSpecOpen();
    if (!opened) return;
    const ok = await ensureBlocks(p.rows.length);
    if (!ok) return;

    const blocks = getBlocks();
    for (let i = 0; i < p.rows.length; i++) {
      p.rows[i].unit = p.rows[i].unit || (p.kind === 'service' ? 'послуга' : 'штука');
      await fillBlock(blocks[i], p.rows[i], p.date, i);
    }
    await sleep(500);
    log('· Звіт після заповнення:');
    const fresh = getBlocks();
    for (let i = 0; i < p.rows.length; i++) readBack(fresh[i], p.rows[i], p.date, i);
    log('· Готово. Перегляньте і натисніть "Зберегти" самі.');
  }

  function buildPanel() {
    GM_addStyle(`
      #dzo-tender-panel { position: fixed; top: 10px; right: 16px; width: 560px; max-width: calc(100vw - 32px);
        max-height: calc(100vh - 20px); display: flex; flex-direction: column; background: #fff; border: 1px solid #ccc;
        border-radius: 8px; box-shadow: 0 4px 18px rgba(0,0,0,.2); z-index: 999999; font: 13px/1.4 Arial, sans-serif; color: #222;
        overflow: hidden !important; }
      #dzo-tender-panel, #dzo-tender-panel * { box-sizing: border-box !important; }
      #dzo-tender-panel h4 { margin: 0; padding: 8px 10px; background: #f2f2f2; border-bottom: 1px solid #ddd; font-size: 13px;
        flex: 0 0 auto; position: relative; }
      #dzo-tender-panel .toggle { position: absolute; top: 6px; right: 10px; cursor: pointer; font-weight: bold; }
      #dzo-tender-panel .body { padding: 10px; flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; }
      #dzo-tender-panel label { display: block; margin-top: 8px; font-weight: bold; }
      #dzo-tender-panel input[type=text], #dzo-tender-panel input[type=file], #dzo-tender-panel textarea,
      #dzo-tender-panel select, #dzo-tender-panel button { display: block; width: 100% !important; max-width: 100% !important;
        margin: 2px 0 0 0 !important; font: inherit; padding: 4px 6px; }
      #dzo-tender-panel textarea { resize: none; overflow: hidden; min-height: 30px; }
      #dzo-tender-panel button { margin-top: 8px !important; padding: 6px; cursor: pointer; }
      #dzo-tender-panel .tn-row { margin-top: 8px; border: 1px solid #ddd; border-radius: 6px; padding: 6px; background: #fcfcfc; }
      #dzo-tender-panel .tn-title { font-weight: bold; font-size: 12px; }
      #dzo-tender-panel .tn-line { display: flex; gap: 6px; margin-top: 4px; }
      #dzo-tender-panel .tn-line input { flex: 1 1 0; min-width: 0; margin: 0 !important; }
      #dzo-tender-panel .btns { display: flex; gap: 6px; }
      #dzo-tender-panel .btns button { flex: 1 1 0; }
      #dzo-tender-panel .log { margin-top: 8px; font-size: 12px; }
      #dzo-tender-panel .log:empty { display: none; }
      #dzo-tender-panel .dzo-log-line { margin: 3px 0; overflow-wrap: anywhere; padding: 2px 6px; border-radius: 4px; }
      #dzo-tender-panel .dzo-log-err { color: #c0392b; font-weight: bold; background: #fdecea; border: 1px solid #f5c6c0; }
      #dzo-tender-panel .dzo-log-ok { color: #1b6e2b; }
      #dzo-tender-panel .dzo-log-info { color: #555; }
      #dzo-tender-panel #dzo-tn-diag { display: none; height: 220px; overflow: auto !important; resize: vertical; font: 11px/1.3 monospace; white-space: pre; }
    `);

    const panel = document.createElement('div');
    panel.id = 'dzo-tender-panel';
    panel.innerHTML = `
      <h4>Тендер: автозаповнення з договору <span class="toggle">—</span></h4>
      <div class="body">
        <label>Завантажити договір (PDF, DOCX або DOCM)</label>
        <input type="file" id="dzo-tn-file" accept=".pdf,.docx,.docm">
        <label>Сума договору, грн</label>
        <input type="text" id="dzo-tn-amount">
        <label>ПДВ у договорі</label>
        <select id="dzo-tn-vat">
          <option value="">не визначено</option>
          <option value="with">з ПДВ</option>
          <option value="without">без ПДВ</option>
        </select>
        <label>Тип</label>
        <select id="dzo-tn-kind">
          <option value="goods">Товар (одиниця «штука»)</option>
          <option value="service">Послуга (одиниця «послуга»)</option>
        </select>
        <label>Дата заходу / кінцевий строк (дд.мм.рррр)</label>
        <input type="text" id="dzo-tn-date" placeholder="не знайдено — впишіть, напр. 29.10.2026">
        <label>Предмети закупівлі (1 позиція договору = 1 предмет)</label>
        <div id="dzo-tn-rows"></div>
        <button id="dzo-tn-run">Заповнити предмети</button>
        <div class="log" id="dzo-tn-log"></div>
        <button id="dzo-tn-dump">Показати поля блоку (діагностика)</button>
        <textarea id="dzo-tn-diag" readonly></textarea>
      </div>`;
    document.body.appendChild(panel);
    logBox = panel.querySelector('#dzo-tn-log');

    const body = panel.querySelector('.body');
    const toggle = panel.querySelector('.toggle');
    toggle.addEventListener('click', () => {
      const collapsed = body.style.display === 'none';
      body.style.display = collapsed ? '' : 'none';
      toggle.textContent = collapsed ? '—' : '+';
    });

    const fileInput = panel.querySelector('#dzo-tn-file');
    fileInput.addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (f) { handleFile(f); fileInput.value = ''; }
    });

    const guard = (btn, fn, label) => btn.addEventListener('click', async () => {
      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = label;
      try { await fn(); } catch (e) { log('⚠ Несподівана помилка: ' + e.message); }
      btn.disabled = false;
      btn.textContent = old;
    });

    guard(panel.querySelector('#dzo-tn-run'), fillAll, 'Заповнюю…');
    guard(panel.querySelector('#dzo-tn-dump'), () => dumpFields(), 'Читаю…');
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') buildPanel();
  else document.addEventListener('DOMContentLoaded', buildPanel);
})();

/* ===================== ЕТАП 3: вікно переможця (ФОП з бази + дані договору з етапу 2) ===================== */
/*
  v0.1.0
  Що робить:
    1) Панель з'являється сама, коли на сторінці є поле data[suppliers][0][name] (вікно переможця).
    2) Договір береться з етапу 2 автоматично (localStorage 'dzo_contract_ctx'); вручну — лише запасний варіант.
       Шукаємо ФОП із вашої бази (за кодом ІПН/ЄДРПОУ, інакше за ПІБ), суму і ПДВ.
    3) ФОП не знайдено -> панель каже про це, пропонує додати в базу (форма попередньо заповнюється з договору).
    4) "Заповнити" -> заповнює поля і показує помилки. "Зберегти" на сторінці НЕ натискається.
  Сталі: мікропідприємництво, Україна, телефон 0000; пошта, факс, сайт — пропускаються.
  База ФОПів зберігається в Tampermonkey (GM_setValue). Є експорт/імпорт JSON для резервної копії.
*/

(function () {
  'use strict';

  if (window.top !== window.self) return; // не запускаємось у вбудованих фреймах

  const $ = (typeof unsafeWindow !== 'undefined' && unsafeWindow.jQuery) ? unsafeWindow.jQuery : (window.jQuery || null);

  const P = 'data[suppliers][0]';
  const SEL = {
    name: `input[name="${P}[name]"]`,
    id: `input[name="${P}[identifier][id]"]`,
    scale: `select[name="${P}[scale]"]`,
    region: `select[name="${P}[address][region]"]`,
    locality: `input[name="${P}[address][locality]"]`,
    street: `input[name="${P}[address][streetAddress]"]`,
    postal: `input[name="${P}[address][postalCode]"]`,
    country: `[name="${P}[address][countryName]"]`,
    contact: `input[name="${P}[contactPoint][name]"]`,
    phone: `input[name="${P}[contactPoint][telephone]"]`,
    amount: 'input[name="data[value][amount]"]',
    vat: 'select[name="data[value][valueAddedTaxIncluded]"]'
  };

  const FIXED = { phone: '0000', scale: 'micro', country: 'Україна' };
  const STORE_KEY = 'dzo_fops_v1';
  const CTX_KEY = 'dzo_contract_ctx';
  const CTX_MAX_AGE = 24 * 3600 * 1000;

  const REGIONS = ['Київська область', 'Автономна Республіка Крим', 'Вінницька область', 'Волинська область',
    'Дніпропетровська область', 'Донецька область', 'Івано-Франківська область', 'Житомирська область',
    'Закарпатська область', 'Запорізька область', 'Кіровоградська область', 'Луганська область', 'Львівська область',
    'Миколаївська область', 'Одеська область', 'Полтавська область', 'Рівненська область', 'Сумська область',
    'Тернопільська область', 'Харківська область', 'Херсонська область', 'Хмельницька область', 'Черкаська область',
    'Чернівецька область', 'Чернігівська область', 'м. Київ'];

  // ---------- допоміжні ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const fire = (el, t) => el.dispatchEvent(new Event(t, { bubbles: true }));
  const collapseSpaces = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const isVisible = (el) => !!(el && (el.offsetParent !== null || el.getClientRects().length));

  function parsePageNumber(s) {
    const n = parseFloat(String(s || '').replace(/[\s\u00a0]/g, '').replace(',', '.'));
    return isNaN(n) ? null : n;
  }

  function setInputValue(el, value) {
    if (!el) return false;
    el.value = value;
    fire(el, 'input');
    fire(el, 'keyup');
    fire(el, 'change');
    fire(el, 'blur');
    return true;
  }

  function setSelectValue(sel, value) {
    if (!sel) return false;
    sel.value = value;
    fire(sel, 'change');
    try { if ($ && $(sel).data && $(sel).data('chosen')) $(sel).trigger('chosen:updated'); } catch (e) { /* нічого */ }
    return sel.value === value;
  }

  function findOptionByText(sel, text) {
    const needle = text.trim().toLowerCase();
    const opts = Array.from(sel.options);
    return opts.find((o) => o.textContent.trim().toLowerCase() === needle)
      || opts.find((o) => o.textContent.trim().toLowerCase().includes(needle)) || null;
  }

  // ---------- база ФОПів ----------

  function loadFops() {
    try {
      const v = JSON.parse(GM_getValue(STORE_KEY, '[]'));
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }
  function saveFops(list) { GM_setValue(STORE_KEY, JSON.stringify(list)); }
  function newId() { return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  // ---------- лог (у панелі лише помилки та підсумок) ----------

  let logBox;
  function log(msg, kind) {
    console.log('[dzo-winner]', msg);
    if (!logBox) return;
    const err = msg.charAt(0) === '⚠';
    if (!err) return; // у панелі показуємо тільки помилки
    const line = document.createElement('div');
    line.className = 'dw-line ' + (err ? 'dw-err' : (kind === 'info' ? 'dw-info' : 'dw-ok'));
    line.textContent = (err ? '❌ ' + msg.slice(1).trim() : msg);
    logBox.appendChild(line);
  }

  // ---------- читання договору ----------

  function itemsToText(items) {
    let out = '';
    let lastEndX = null;
    for (const it of items) {
      if (it.str) {
        const x = it.transform[4];
        const height = Math.abs(it.transform[3]) || Math.abs(it.transform[0]) || 10;
        if (lastEndX !== null) {
          const gap = x - lastEndX;
          if (gap > height * 0.1 || gap < -height * 0.1) out += ' ';
        }
        out += it.str;
        lastEndX = x + (it.width || 0);
      }
      if (it.hasEOL) { out += '\n'; lastEndX = null; }
    }
    return out;
  }

  async function extractText(file) {
    const buf = await file.arrayBuffer();
    const name = file.name.toLowerCase();
    if (name.endsWith('.pdf')) {
      if (typeof pdfjsLib === 'undefined') throw new Error('pdf.js не завантажився (можливо, CSP сайту)');
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      const doc = await pdfjsLib.getDocument({ data: buf }).promise;
      let text = '';
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        text += itemsToText(content.items) + '\n';
      }
      return text;
    }
    if (name.endsWith('.docx') || name.endsWith('.docm')) {
      if (typeof mammoth === 'undefined') throw new Error('mammoth.js не завантажився (можливо, CSP сайту)');
      const raw = await mammoth.extractRawText({ arrayBuffer: buf });
      return raw.value;
    }
    throw new Error('Підтримуються тільки .pdf, .docx та .docm');
  }

  // ---------- сума і ПДВ (з етапу 2) ----------

  function detectVat(after) {
    if (/бе[зс]\s+пдв|пдв\s+не\s+нараховується|не\s+обкладається\s+пдв/.test(after)) return 'without';
    if (/(?<![а-яіїєґ])з\s+пдв|у\s+тому\s+числі\s+пдв|в\s+т\.?\s?ч\.?\s+пдв|включно\s+з\s+пдв|включаючи\s+пдв/.test(after)) return 'with';
    return '';
  }

  function findAmount(text) {
    const warnings = [];
    const flat = text.replace(/[\u00a0\u2007\u2009\u202f]/g, ' ').replace(/\s+/g, ' ');
    const NUM = '(?<!\\d)(\\d{1,3}(?:\\s\\d{3})+|\\d+)(?:\\s?[.,\\-–]\\s?(\\d{1,2})(?!\\d))?';
    const CUR = '\\s*(?:\\([^)]{0,150}\\)\\s*)?(?:грн|гривн|гривен|₴|UAH)[а-яіїє]*\\.?(?:\\s*(?:[.,\\-–]\\s*)?(\\d{1,2})\\s*коп)?';

    function build(intStr, decStr, kopStr) {
      const rub = intStr.replace(/\D/g, '');
      let kop = '00';
      if (decStr) kop = decStr.padEnd(2, '0');
      else if (kopStr) kop = kopStr.padStart(2, '0');
      return rub + '.' + kop;
    }

    const cands = [];
    function scoreContext(idx, len, base) {
      const before = flat.slice(Math.max(0, idx - 110), idx).toLowerCase();
      const near = flat.slice(Math.max(0, idx - 40), idx).toLowerCase();
      const after = flat.slice(idx + len, idx + len + 60).toLowerCase();
      let s = base;
      if (/(сум[аиуі]|вартіст|ціна|всього|усього|разом|загалом|складає|становить|розмір|запланован|орієнтовн|очікуван)/.test(before)) s += 3;
      if (/(загальна\s+(сума|вартість)|сума\s+(по|за)\s+(цьому|даному|цим)|ціна\s+договору|вартість\s+договору|всього\s+по\s+договору)/.test(before)) s += 2;
      if (/без\s+пдв|з\s+пдв|пдв\s+не\s+нараховується/.test(after)) s += 2;
      if (/(штраф|пен[яіеі]|неустойк|аванс|передоплат|відсот|процент|%|ліміт|бюджет)/.test(before.slice(-60))) s -= 4;
      if (/за\s+(одиницю|од\.|1\s*шт|шт)|ціна\s+за/.test(near)) s -= 3;
      if (/пдв[^а-я]{0,15}$/.test(near) && !/без\s+пдв/.test(near)) s -= 3;
      if (idx < flat.length * 0.4) s += 1;
      return { score: s, vat: detectVat(after) };
    }
    function push(amount, idx, len, base) {
      const c = scoreContext(idx, len, base);
      cands.push({ amount, score: c.score, vat: c.vat });
    }

    let re = new RegExp(NUM + CUR, 'gi');
    let m;
    while ((m = re.exec(flat)) !== null) push(build(m[1], m[2], m[3]), m.index, m[0].length, 1);

    re = new RegExp('(?:грн|UAH|₴)\\.?\\s*' + NUM + '(?!\\s*%)', 'gi');
    while ((m = re.exec(flat)) !== null) push(build(m[1], m[2]), m.index, m[0].length, 0);

    re = new RegExp('(?:разом|всього|усього|загалом)(?:\\s+по\\s+договору|\\s+до\\s+сплати)?\\s*:?\\s*' + NUM + '(?!\\d)(?!\\s*(?:%|шт|од\\b|одиниц))', 'gi');
    while ((m = re.exec(flat)) !== null) {
      const a = build(m[1], m[2]);
      if (parseFloat(a) >= 1) push(a, m.index, m[0].length, 3);
    }

    const byAmount = new Map();
    cands.forEach((c) => {
      if (parseFloat(c.amount) < 1) return;
      const cur = byAmount.get(c.amount) || { amount: c.amount, best: -99, count: 0, vat: '' };
      if (c.score > cur.best) { cur.best = c.score; if (c.vat) cur.vat = c.vat; }
      else if (!cur.vat && c.vat) cur.vat = c.vat;
      cur.count += 1;
      byAmount.set(c.amount, cur);
    });
    const ranked = Array.from(byAmount.values())
      .map((c) => ({ ...c, final: c.best + Math.min(c.count - 1, 3) }))
      .filter((c) => c.best > 0)
      .sort((a, b) => b.final - a.final);

    let amount = '';
    let vat = '';
    if (ranked.length) {
      amount = ranked[0].amount;
      vat = ranked[0].vat;
      const rivals = ranked.filter((c, i) => i > 0 && c.final >= ranked[0].final - 1);
      if (rivals.length) warnings.push('Кілька правдоподібних сум: ' + [ranked[0], ...rivals].map((c) => c.amount).join(', ') + '. Взято ' + amount + ' — перевірте.');
      else if (ranked[0].final < 4) warnings.push('Суму знайдено з низькою впевненістю (' + amount + ') — перевірте.');
    } else {
      warnings.push('Не знайшов суму в тексті — впишіть вручну.');
    }
    return { amount, vat, warnings };
  }

  // ---------- пошук ФОПа в договорі ----------

  function stems(name) {
    return collapseSpaces(name)
      .toLowerCase()
      .replace(/^(фоп|фізична особа[\s-]*підприємець|тов|пп)\s+/i, '')
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .map((w) => w.slice(0, Math.max(4, w.length - 2)));
  }

  // Повертає масив ID ФОПів з бази, що знайдені в тексті (найкращі — першими)
  function matchFops(text, fops) {
    const flat = text.replace(/[\u00a0\u2007\u2009\u202f]/g, ' ').replace(/\s+/g, ' ');
    const low = flat.toLowerCase().replace(/[’ʼ`]/g, "'");
    const byCode = [];
    const byName = [];
    fops.forEach((f) => {
      const code = String(f.code || '').replace(/\D/g, '');
      if (code && new RegExp('(?<!\\d)' + code + '(?!\\d)').test(flat)) { byCode.push(f); return; }
      const st = stems(f.name).map((s) => s.replace(/[’ʼ`]/g, "'"));
      if (st.length >= 2 && st.every((s) => low.includes(s))) byName.push(f);
    });
    return { byCode, byName };
  }

  // Підказка для нового ФОПа: назва та код із тексту договору
  function guessNewFop(text) {
    const flat = text.replace(/[\u00a0\u2007\u2009\u202f]/g, ' ').replace(/\s+/g, ' ');
    const out = { name: '', code: '' };
    const n = flat.match(/(?:ФОП|Фізична\s+особа[\s-]*підприємець)\s+([А-ЯІЇЄҐ][а-яіїєґ'’ʼ-]+(?:\s+[А-ЯІЇЄҐ][а-яіїєґ'’ʼ-]+){1,2})/);
    if (n) out.name = 'ФОП ' + n[1];
    const c = flat.match(/(?:ІПН|РНОКПП|ЄДРПОУ|ідентифікаційн[а-яії]*\s+(?:номер|код)|код)[^\d]{0,40}(\d{10}|\d{8})(?!\d)/i);
    if (c) out.code = c[1];
    return out;
  }

  // ---------- заповнення сторінки ----------

  async function fillPage(fop, amount, vat) {
    const miss = (what) => log('⚠ Не знайшов поле: ' + what);
    const get = (k) => q(SEL[k]);

    if (!setInputValue(get('name'), fop.name)) miss('Назва юридичної особи');
    if (!setInputValue(get('id'), String(fop.code).replace(/\D/g, ''))) miss('Код ЄДРПОУ / ІПН');

    const scale = get('scale');
    if (!scale) miss('Класифікація');
    else if (!setSelectValue(scale, FIXED.scale)) log('⚠ Не вдалося обрати "Суб\'єкт мікропідприємництва"');

    const country = get('country');
    if (country) {
      if (country.tagName === 'SELECT') {
        const o = findOptionByText(country, FIXED.country);
        if (o) setSelectValue(country, o.value);
      } else if (!country.value) setInputValue(country, FIXED.country);
    }

    const region = get('region');
    if (!region) miss('Регіон / область');
    else if (fop.region) {
      const o = findOptionByText(region, fop.region);
      if (o) setSelectValue(region, o.value);
      else log('⚠ У списку немає області "' + fop.region + '"');
    } else log('⚠ У ФОПа не вказана область — оберіть вручну.');

    if (!setInputValue(get('locality'), fop.locality || '')) miss('Населений пункт');
    if (!setInputValue(get('street'), fop.street || '')) miss('Адреса');
    if (!setInputValue(get('postal'), String(fop.postal || '').replace(/\D/g, ''))) miss('Поштовий індекс');
    if (!setInputValue(get('contact'), fop.contact || fop.name.replace(/^(ФОП|фоп)\s+/, ''))) miss('ПІБ особи');
    if (!setInputValue(get('phone'), FIXED.phone)) miss('Телефон');

    if (amount) {
      if (!setInputValue(get('amount'), amount)) miss('Пропозиція переможця (сума)');
    } else log('⚠ Суму не вказано — впишіть її в панелі.');

    const vatEl = get('vat');
    if (!vatEl) miss('ПДВ');
    else if (!vat) log('⚠ ПДВ не визначено — оберіть "з ПДВ / без ПДВ" вручну.');
    else {
      const o = findOptionByText(vatEl, vat === 'with' ? 'з ПДВ' : 'без ПДВ');
      if (o) setSelectValue(vatEl, o.value);
      else log('⚠ Не знайшов варіант ПДВ у списку.');
    }

    await sleep(400);
    readBack(fop, amount, vat);
  }

  function readBack(fop, amount, vat) {
    const chk = (key, expected, label, cmp) => {
      const el = q(SEL[key]);
      if (!el) return;
      const ok = cmp ? cmp(el.value) : el.value === expected;
      if (!ok) log(`⚠ ${label}: на сторінці "${el.value}", очікувалось "${expected}"`);
    };
    chk('name', fop.name, 'Назва');
    chk('id', String(fop.code).replace(/\D/g, ''), 'Код');
    chk('scale', FIXED.scale, 'Класифікація');
    chk('locality', fop.locality || '', 'Населений пункт');
    chk('street', fop.street || '', 'Адреса');
    chk('phone', FIXED.phone, 'Телефон', (v) => v.replace(/\D/g, '') === FIXED.phone);
    chk('postal', String(fop.postal || ''), 'Індекс', (v) => v.replace(/\D/g, '') === String(fop.postal || '').replace(/\D/g, ''));
    if (amount) chk('amount', amount, 'Сума', (v) => { const n = parsePageNumber(v); return n != null && Math.abs(n - parseFloat(amount)) < 0.005; });
    const reg = q(SEL.region);
    if (reg && fop.region && reg.options[reg.selectedIndex] && reg.options[reg.selectedIndex].textContent.trim() !== fop.region) {
      log(`⚠ Область: на сторінці "${reg.options[reg.selectedIndex].textContent.trim()}", очікувалось "${fop.region}"`);
    }
    const v = q(SEL.vat);
    if (v && vat) {
      const t = v.options[v.selectedIndex] ? v.options[v.selectedIndex].textContent.trim().toLowerCase() : '';
      const want = vat === 'with' ? 'з пдв' : 'без пдв';
      if (t !== want) log(`⚠ ПДВ: на сторінці "${t}", очікувалось "${want}"`);
    }
  }

  // ---------- панель ----------

  const ui = { text: '', detected: null };

  function fopOptionsHtml(fops, selectedId) {
    return '<option value="">— не обрано —</option>' + fops.map((f) =>
      `<option value="${f.id}"${f.id === selectedId ? ' selected' : ''}>${escapeHtml(f.name)} (${escapeHtml(f.code)})</option>`).join('');
  }
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function refreshFopSelects(selectedMain) {
    const fops = loadFops();
    const main = document.getElementById('dw-fop');
    const edit = document.getElementById('dw-edit-select');
    if (main) main.innerHTML = fopOptionsHtml(fops, selectedMain || main.value);
    if (edit) edit.innerHTML = '<option value="">➕ Новий ФОП</option>' + fops.map((f) =>
      `<option value="${f.id}">${escapeHtml(f.name)} (${escapeHtml(f.code)})</option>`).join('');
  }

  function fillEditForm(f) {
    const set = (id, v) => { document.getElementById(id).value = v || ''; };
    set('dw-e-name', f && f.name);
    set('dw-e-code', f && f.code);
    set('dw-e-region', f && f.region);
    set('dw-e-locality', f && f.locality);
    set('dw-e-street', f && f.street);
    set('dw-e-postal', f && f.postal);
    set('dw-e-contact', f && f.contact);
  }

  function openSettings(prefill) {
    document.getElementById('dw-settings').open = true;
    refreshFopSelects();
    document.getElementById('dw-edit-select').value = '';
    fillEditForm(prefill || null);
  }

  function saveEdit() {
    const g = (id) => collapseSpaces(document.getElementById(id).value);
    const f = {
      id: document.getElementById('dw-edit-select').value || newId(),
      name: g('dw-e-name'), code: g('dw-e-code').replace(/\D/g, ''), region: document.getElementById('dw-e-region').value,
      locality: g('dw-e-locality'), street: g('dw-e-street'), postal: g('dw-e-postal').replace(/\D/g, ''), contact: g('dw-e-contact')
    };
    const errs = [];
    if (!f.name) errs.push('назва');
    if (!/^\d{8}$|^\d{10}$/.test(f.code)) errs.push('код (8 або 10 цифр)');
    if (!f.region) errs.push('область');
    if (!f.locality) errs.push('населений пункт');
    if (!f.street) errs.push('адреса');
    if (!/^\d{5}$/.test(f.postal)) errs.push('індекс (5 цифр)');
    if (!f.contact) f.contact = f.name.replace(/^(ФОП|фоп)\s+/, '');
    const msg = document.getElementById('dw-edit-msg');
    if (errs.length) { msg.textContent = '❌ Перевірте: ' + errs.join(', '); return; }
    const list = loadFops();
    const i = list.findIndex((x) => x.id === f.id);
    if (i >= 0) list[i] = f; else list.push(f);
    saveFops(list);
    msg.textContent = '✓ Збережено';
    refreshFopSelects(f.id);
    document.getElementById('dw-edit-select').value = f.id;
    document.getElementById('dw-fop').value = f.id;
  }

  function deleteEdit() {
    const id = document.getElementById('dw-edit-select').value;
    if (!id) return;
    if (!confirm('Видалити цього ФОПа з бази?')) return;
    saveFops(loadFops().filter((x) => x.id !== id));
    refreshFopSelects();
    fillEditForm(null);
    document.getElementById('dw-edit-msg').textContent = 'Видалено';
  }

  // Спільна частина: маємо текст договору, суму і ПДВ -> шукаємо ФОПа, заповнюємо панель
  function analyze(text, amount, vat, warnings) {
    ui.text = text;
    document.getElementById('dw-amount').value = amount || '';
    document.getElementById('dw-vat').value = vat || '';
    (warnings || []).forEach((w) => log('⚠ ' + w));
    if (!amount) log('⚠ Суму не знайдено — впишіть вручну.');

    const fops = loadFops();
    const { byCode, byName } = matchFops(text, fops);
    const found = byCode.concat(byName);
    const sel = document.getElementById('dw-fop');
    sel.innerHTML = fopOptionsHtml(fops, found[0] && found[0].id);
    const addBtn = document.getElementById('dw-add-from-contract');
    if (found.length) {
      addBtn.style.display = 'none';
      log('✓ ФОП знайдено в базі: ' + found[0].name, 'show');
      if (found.length > 1) log('⚠ У договорі збіглося кілька ФОПів з бази (' + found.map((f) => f.name).join('; ') + ') — перевірте вибір.');
    } else {
      addBtn.style.display = 'block';
      log('⚠ ФОПа з цього договору немає в базі. Натисніть "Додати ФОП в базу" або оберіть вручну.');
    }
  }

  // Запасний варіант: файл вручну
  async function handleFile(file) {
    logBox.innerHTML = '';
    try {
      const text = await extractText(file);
      if (text.replace(/\s/g, '').length < 200) log('⚠ З файлу дістало дуже мало тексту — схоже на скан без текстового шару.');
      const am = findAmount(text);
      analyze(text, am.amount, am.vat, am.warnings);
    } catch (e) {
      log('⚠ Помилка розпізнавання: ' + e.message);
    }
  }

  // Основний варіант: дані, збережені скриптом етапу 2
  function loadCtx() {
    try {
      const c = JSON.parse(localStorage.getItem(CTX_KEY) || 'null');
      if (!c || !c.text) return null;
      return c;
    } catch (e) { return null; }
  }

  function applyContext() {
    if (!logBox) return;
    logBox.innerHTML = '';
    const info = document.getElementById('dw-ctx');
    const man = document.getElementById('dw-manual');
    if (man) man.open = true;
    const ctx = loadCtx();
    if (!ctx) {
      info.textContent = 'Договір з етапу 2 не знайдено — завантажте файл нижче.';
      return false;
    }
    const age = Date.now() - (ctx.ts || 0);
    if (age > CTX_MAX_AGE) {
      info.textContent = 'Договір з етапу 2 застарілий (' + (ctx.name || '') + ') — завантажте файл нижче.';
      return false;
    }
    const t = new Date(ctx.ts);
    info.textContent = '📄 Договір з етапу 2: ' + (ctx.name || '') + ' (' + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0') + ')';
    if (man) man.open = false;
    analyze(ctx.text, ctx.amount, ctx.vat, []);
    return true;
  }

  async function onFill() {
    logBox.innerHTML = '';
    const id = document.getElementById('dw-fop').value;
    const fop = loadFops().find((f) => f.id === id);
    if (!fop) { log('⚠ Оберіть ФОПа зі списку (або додайте в базу).'); return; }
    const amount = document.getElementById('dw-amount').value.replace(',', '.').trim();
    const vat = document.getElementById('dw-vat').value;
    await fillPage(fop, amount, vat);
    logBox.scrollTop = logBox.scrollHeight;
  }

  function buildPanel() {
    GM_addStyle(`
      #dzo-winner-panel { position: fixed; top: 10px; left: 16px; width: 520px; min-width: 340px; min-height: 120px;
        max-width: calc(100vw - 8px); max-height: calc(100vh - 8px); resize: both; display: flex; flex-direction: column; background: #fff; border: 1px solid #ccc;
        border-radius: 8px; box-shadow: 0 4px 18px rgba(0,0,0,.2); z-index: 2147483000; font: 13px/1.4 Arial, sans-serif; color: #222; overflow: hidden; }
      #dzo-winner-panel, #dzo-winner-panel * { box-sizing: border-box !important; }
      #dzo-winner-panel h4 { margin: 0; padding: 8px 10px; background: #f2f2f2; border-bottom: 1px solid #ddd; font-size: 13px;
        flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; cursor: move; user-select: none; }
      #dzo-winner-panel .dw-hbtns span { display: inline-block; min-width: 24px; text-align: center; font-weight: bold; cursor: pointer; padding: 0 4px; }
      #dzo-winner-panel .dw-hbtns span:hover { background: #ddd; border-radius: 4px; }
      #dzo-winner-panel .dw-body { padding: 10px; flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; }
      #dzo-winner-panel .dw-foot { padding: 8px 10px; flex: 0 0 auto; border-top: 1px solid #ddd; background: #fafafa; }
      #dzo-winner-panel.dw-collapsed .dw-body, #dzo-winner-panel.dw-collapsed .dw-foot { display: none; }
      #dzo-winner-panel.dw-collapsed { resize: horizontal; min-height: 0; }
      #dzo-winner-panel.dw-manager .dw-winner-only { display: none !important; }
      #dzo-winner-panel .dw-note { color: #666; font-size: 12px; margin-bottom: 2px; }
      #dzo-winner-panel label { display: block; margin-top: 8px; font-weight: bold; }
      #dzo-winner-panel input[type=text], #dzo-winner-panel input[type=file], #dzo-winner-panel select,
      #dzo-winner-panel textarea, #dzo-winner-panel button { display: block; width: 100% !important; max-width: 100% !important;
        margin: 2px 0 0 0 !important; font: inherit; padding: 4px 6px; }
      #dzo-winner-panel button { margin-top: 8px !important; padding: 6px; cursor: pointer; }
      #dzo-winner-panel .dw-foot button { margin-top: 0 !important; padding: 8px; font-weight: bold; }
      #dzo-winner-panel .dw-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 10px; }
      #dzo-winner-panel .dw-full { grid-column: 1 / -1; }
      #dzo-winner-panel details { margin-top: 10px; border: 1px solid #ddd; border-radius: 6px; background: #fafafa; }
      #dzo-winner-panel summary { cursor: pointer; padding: 6px 8px; font-weight: bold; user-select: none; }
      #dzo-winner-panel details > .dw-inner { padding: 0 8px 8px; }
      #dzo-winner-panel .dw-line { margin: 3px 0; padding: 2px 6px; border-radius: 4px; overflow-wrap: anywhere; font-size: 12px; }
      #dzo-winner-panel .dw-err { color: #c0392b; font-weight: bold; background: #fdecea; border: 1px solid #f5c6c0; }
      #dzo-winner-panel .dw-ok { color: #1b6e2b; }
      #dzo-winner-panel .dw-info { color: #8a5a00; font-weight: bold; background: #fff6e0; border: 1px solid #f0d9a0; }
      #dzo-winner-panel #dw-log { margin-top: 8px; max-height: 150px; overflow-y: auto; }
      #dzo-winner-panel #dw-log:empty { display: none; }
      #dzo-winner-panel .btns { display: flex; gap: 6px; }
      #dzo-winner-panel .btns button { flex: 1 1 0; }
      #dzo-winner-panel #dw-add-from-contract { display: none; }
      #dzo-winner-panel #dw-io { height: 80px; font: 11px monospace; }
    `);

    const panel = document.createElement('div');
    panel.id = 'dzo-winner-panel';
    panel.style.display = 'none';
    panel.innerHTML = `
      <h4><span id="dw-title">Переможець: автозаповнення</span><span class="dw-hbtns"><span class="dw-min" title="Згорнути / розгорнути">—</span><span class="dw-close" title="Сховати до наступного відкриття вікна">×</span></span></h4>
      <div class="dw-body">
      <div class="dw-winner-only">
        <div id="dw-ctx" class="dw-note"></div>

        <details id="dw-manual">
          <summary>Договір вручну / перечитати</summary>
          <div class="dw-inner">
            <button id="dw-reload">↻ Перечитати договір з етапу 2</button>
            <label>Або завантажити договір вручну (PDF, DOCX, DOCM)</label>
            <input type="file" id="dw-file" accept=".pdf,.docx,.docm">
          </div>
        </details>

        <label>ФОП</label>
        <select id="dw-fop"></select>
        <button id="dw-add-from-contract">➕ Додати ФОП в базу (з даними з договору)</button>

        <div class="dw-grid">
          <div>
            <label>Пропозиція переможця (сума), грн</label>
            <input type="text" id="dw-amount">
          </div>
          <div>
            <label>ПДВ</label>
            <select id="dw-vat">
              <option value="">не визначено</option>
              <option value="without">без ПДВ</option>
              <option value="with">з ПДВ</option>
            </select>
          </div>
        </div>

      </div>
        <details id="dw-settings">
          <summary>⚙ Налаштування (база ФОПів)</summary>
          <div class="dw-inner">
            <label>Редагувати</label>
            <select id="dw-edit-select"></select>
            <div class="dw-grid">
              <div class="dw-full"><label>Назва (як у вікні, напр. ФОП Іваненко Іван Іванович)</label><input type="text" id="dw-e-name"></div>
              <div><label>Код ІПН / ЄДРПОУ</label><input type="text" id="dw-e-code"></div>
              <div><label>Область</label>
                <select id="dw-e-region"><option value="">Оберіть область</option>${REGIONS.map((r) => `<option value="${r}">${r}</option>`).join('')}</select></div>
              <div><label>Населений пункт</label><input type="text" id="dw-e-locality"></div>
              <div><label>Поштовий індекс</label><input type="text" id="dw-e-postal"></div>
              <div class="dw-full"><label>Адреса</label><input type="text" id="dw-e-street"></div>
              <div class="dw-full"><label>ПІБ особи (порожньо — візьму з назви)</label><input type="text" id="dw-e-contact"></div>
            </div>
            <div class="btns">
              <button id="dw-e-save">Зберегти ФОПа</button>
              <button id="dw-e-del">Видалити</button>
            </div>
            <div id="dw-edit-msg" class="dw-line"></div>
            <label>Резервна копія бази (JSON)</label>
            <textarea id="dw-io"></textarea>
            <div class="btns">
              <button id="dw-export">Експорт</button>
              <button id="dw-import">Імпорт</button>
            </div>
          </div>
        </details>
      </div>
      <div class="dw-foot dw-winner-only">
        <button id="dw-run">Заповнити</button>
        <div id="dw-log"></div>
      </div>`;
    document.body.appendChild(panel);
    logBox = panel.querySelector('#dw-log');
    refreshFopSelects();

    // --- положення і розмір вікна (запам'ятовуються) ---
    const UI_KEY = 'dzo_winner_ui_v1';
    let saved = {};
    try { saved = JSON.parse(GM_getValue(UI_KEY, '{}')) || {}; } catch (e) { saved = {}; }
    const defW = Math.min(saved.width || 520, window.innerWidth - 16);
    panel.style.width = defW + 'px';
    if (saved.height) panel.style.height = saved.height + 'px';
    panel.style.left = (typeof saved.left === 'number' ? saved.left : Math.max(8, window.innerWidth - defW - 16)) + 'px';
    panel.style.top = (typeof saved.top === 'number' ? saved.top : 10) + 'px';

    const clampPos = () => {
      let l = parseFloat(panel.style.left) || 0;
      let t = parseFloat(panel.style.top) || 0;
      l = Math.min(Math.max(0, l), Math.max(0, window.innerWidth - 80));
      t = Math.min(Math.max(0, t), Math.max(0, window.innerHeight - 40));
      panel.style.left = l + 'px';
      panel.style.top = t + 'px';
      panel.style.maxWidth = Math.max(340, window.innerWidth - l - 8) + 'px';
      panel.style.maxHeight = Math.max(120, window.innerHeight - t - 8) + 'px';
    };
    clampPos();

    let saveTimer = null;
    const saveUi = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (panel.classList.contains('dw-collapsed') || panel.style.display === 'none') return;
        try {
          GM_setValue(UI_KEY, JSON.stringify({
            left: parseFloat(panel.style.left), top: parseFloat(panel.style.top),
            width: panel.offsetWidth, height: panel.style.height ? panel.offsetHeight : null
          }));
        } catch (e) { /* нічого */ }
      }, 300);
    };
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(saveUi).observe(panel);
    window.addEventListener('resize', clampPos);

    // згортання: запам'ятовуємо задану висоту, щоб після розгортання повернути
    let heightBeforeCollapse = '';
    const toggleCollapse = () => {
      if (!panel.classList.contains('dw-collapsed')) {
        heightBeforeCollapse = panel.style.height;
        panel.style.height = '';
        panel.classList.add('dw-collapsed');
      } else {
        panel.classList.remove('dw-collapsed');
        panel.style.height = heightBeforeCollapse;
      }
    };

    // перетягування за заголовок
    let drag = null;
    let wasDrag = false;
    const head = panel.querySelector('h4');
    head.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || (e.target.closest && e.target.closest('.dw-hbtns'))) return;
      drag = { x: e.clientX, y: e.clientY, l: parseFloat(panel.style.left) || 0, t: parseFloat(panel.style.top) || 0, moved: false };
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      drag.moved = true;
      panel.style.left = (drag.l + dx) + 'px';
      panel.style.top = (drag.t + dy) + 'px';
      clampPos();
    });
    document.addEventListener('mouseup', () => {
      if (!drag) return;
      if (drag.moved) {
        wasDrag = true;
        setTimeout(() => { wasDrag = false; }, 60);
        saveUi();
      }
      drag = null;
    });
    head.addEventListener('click', () => { if (!wasDrag) toggleCollapse(); });
    panel.querySelector('.dw-min').addEventListener('click', (e) => { e.stopPropagation(); toggleCollapse(); });
    panel.querySelector('.dw-close').addEventListener('click', (e) => { e.stopPropagation(); if (panelMode === 'manager') managerOpen = false; else dismissed = true; panel.style.display = 'none'; tick(); });

    const on = (id, ev, fn) => panel.querySelector('#' + id).addEventListener(ev, fn);

    on('dw-file', 'change', (e) => { const f = e.target.files[0]; if (f) { handleFile(f); e.target.value = ''; } });
    on('dw-run', 'click', async (e) => {
      const b = e.currentTarget; b.disabled = true;
      try { await onFill(); } catch (err) { log('⚠ Несподівана помилка: ' + err.message); }
      b.disabled = false;
    });
    on('dw-reload', 'click', applyContext);
    on('dw-add-from-contract', 'click', () => {
      const g = guessNewFop(ui.text);
      openSettings({ name: g.name, code: g.code, region: 'Черкаська область', locality: '', street: '', postal: '', contact: '' });
    });
    on('dw-edit-select', 'change', (e) => {
      const f = loadFops().find((x) => x.id === e.target.value);
      fillEditForm(f || null);
      document.getElementById('dw-edit-msg').textContent = '';
    });
    on('dw-e-save', 'click', saveEdit);
    on('dw-e-del', 'click', deleteEdit);
    on('dw-export', 'click', () => { document.getElementById('dw-io').value = JSON.stringify(loadFops(), null, 1); });
    on('dw-import', 'click', () => {
      const msg = document.getElementById('dw-edit-msg');
      try {
        const arr = JSON.parse(document.getElementById('dw-io').value);
        if (!Array.isArray(arr)) throw new Error('очікувався масив');
        const list = loadFops();
        arr.forEach((f) => {
          if (!f || !f.name || !f.code) return;
          const i = list.findIndex((x) => String(x.code) === String(f.code));
          const item = { ...f, id: i >= 0 ? list[i].id : (f.id || newId()) };
          if (i >= 0) list[i] = item; else list.push(item);
        });
        saveFops(list);
        refreshFopSelects();
        msg.textContent = '✓ Імпортовано, у базі: ' + list.length;
      } catch (e) { msg.textContent = '❌ Імпорт: ' + e.message; }
    });

    return panel;
  }

  // Вікно переможця підвантажується динамічно: показуємо панель, коли поле є, ховаємо, коли зникло.
  let panelEl = null;
  let wasPresent = false;
  let dismissed = false;     // у режимі переможця: користувач натиснув "×"
  let managerOpen = false;   // у режимі бази ФОПів: вікно відкрите
  let panelMode = 'winner';  // 'winner' | 'manager'
  let tabEl = null;

  function setMode(mode) {
    if (!panelEl || panelMode === mode) return;
    panelMode = mode;
    panelEl.classList.toggle('dw-manager', mode === 'manager');
    const t = document.getElementById('dw-title');
    if (t) t.textContent = mode === 'manager' ? 'База ФОПів' : 'Переможець: автозаповнення';
    if (mode === 'manager') openSettings(null);
  }

  function tick() {
    const present = isVisible(q(SEL.name));
    let show = false;
    if (present) {
      if (!panelEl) panelEl = buildPanel();
      setMode('winner');
      managerOpen = false;
      show = !dismissed;
    } else {
      dismissed = false;
      if (managerOpen) {
        if (!panelEl) panelEl = buildPanel();
        setMode('manager');
        show = true;
      }
    }
    if (panelEl) {
      const want = show ? 'flex' : 'none';
      if (panelEl.style.display !== want) panelEl.style.display = want;
    }
    if (tabEl) tabEl.style.display = show ? 'none' : 'block';
    if (present && !wasPresent && panelEl) applyContext();
    wasPresent = present;
  }

  // Невелика вкладка «ФОПи» біля правого краю: відкриває базу ФОПів на будь-якій сторінці сайту
  function buildTab() {
    GM_addStyle(`
      #dzo-winner-tab { position: fixed; right: 0; top: 45%; z-index: 2147482999; background: #2c3e50; color: #fff;
        font: 12px/1 Arial, sans-serif; padding: 10px 5px; border-radius: 6px 0 0 6px; cursor: pointer;
        writing-mode: vertical-rl; letter-spacing: 1px; opacity: .55; box-shadow: -2px 2px 8px rgba(0,0,0,.25); user-select: none; }
      #dzo-winner-tab:hover { opacity: 1; }
    `);
    tabEl = document.createElement('div');
    tabEl.id = 'dzo-winner-tab';
    tabEl.textContent = 'ФОПи';
    tabEl.title = 'Відкрити базу ФОПів';
    tabEl.addEventListener('click', () => {
      if (isVisible(q(SEL.name))) dismissed = false;   // вікно переможця є — просто показуємо панель
      else managerOpen = true;                         // інакше відкриваємо базу ФОПів
      tick();
      if (managerOpen && panelMode === 'manager') openSettings(null);
    });
    document.body.appendChild(tabEl);
  }

  buildTab();
  setInterval(tick, 800);
  tick();
})();
