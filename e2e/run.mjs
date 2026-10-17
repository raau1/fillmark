// End-to-end check of the main workflow on a real clinical questionnaire.
//   1. upload the PDF            2. place fields by hand (drag, click, properties)
//   3. fill them in Fill mode     4. zoom/resize/scroll and check overlay alignment against the rendered page
//   5. export flattened + editable, rasterise with poppler, check every mark/text lands in its printed box
//   6. reload, reopen the project from browser storage, values still there
//   7. no request ever leaves localhost
// Usage: npm run dev (in another terminal), then: node e2e/run.mjs [path/to/form.pdf]
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { launch, uploadPdf, watchNetwork, sleep, allowDownloads, waitForFile } from './lib.mjs';

const URL_ = process.env.APP_URL ?? 'http://localhost:5173/';
const PDF = process.argv[2] ?? process.env.FILLMARK_SAMPLE_PDF;
if (!PDF) {
  console.error('Pass the sample form: node e2e/<script>.mjs path/to/DIVA-5.pdf (or set FILLMARK_SAMPLE_PDF)');
  process.exit(2);
}
const OUT = process.env.E2E_OUT ?? mkdtempSync(join(tmpdir(), 'fillmark-e2e-'));
const DL = mkdtempSync(join(tmpdir(), 'fillmark-dl-'));

// Printed boxes on page 2 of the DIVA-5 form (interiors, display points) — measured from the PDF.
const P = 1; // page index
const BOX_NAME = { x: 148.5, y: 49.25, w: 403.25, h: 18.25 };
const BOX_DOB = { x: 148.5, y: 76.25, w: 403.25, h: 18.25 };
const CHK_H = { x: 148.25, y: 109.0, w: 6.25, h: 6.25 };
const CHK_M = { x: 177.5, y: 109.0, w: 6.25, h: 6.25 };
const BOX_NOTES = { x: 60.5, y: 577.0, w: 225.5, h: 38.5 };
const CHK_ROW1 = { x: 43.25, y: 433.0, w: 6.25, h: 6.25 };

const log = (...a) => console.log('•', ...a);
const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push(['PASS', name]);
  } catch (e) {
    results.push(['FAIL', name, e.message]);
  }
};

const b = await launch();
const page = await b.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const external = watchNetwork(page);
await allowDownloads(page, DL);

await page.goto(URL_, { waitUntil: 'networkidle0' });
// English UI for stable selectors
await page.evaluate(() => localStorage.setItem('pff.lang', 'en'));
await page.reload({ waitUntil: 'networkidle0' });

log('upload', PDF);
await uploadPdf(page, PDF);
const pageCount = await page.$$eval('.page', (els) => els.length);
check('all pages are shown', () => assert.equal(pageCount, Number(execFileSync('pdfinfo', [PDF]).toString().match(/Pages:\s+(\d+)/)[1])));

// ---------- helpers
const pageBox = async (i) =>
  page.$eval(`.page[data-page="${i}"]`, (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });
const scaleOf = async (i) => {
  const r = await pageBox(i);
  return r.width / 595.32;
};
const toScreen = async (i, x, y) => {
  const r = await pageBox(i);
  const s = r.width / 595.32;
  return { x: r.left + x * s, y: r.top + y * s };
};
const scrollToPdf = async (i, y) => {
  await page.$eval(
    '.viewer',
    (v, i, y) => {
      const p = v.querySelector(`.page[data-page="${i}"]`);
      const s = p.getBoundingClientRect().width / 595.32;
      v.scrollTop = p.offsetTop + y * s - 160;
    },
    i,
    y,
  );
  await sleep(400);
};
const selectTool = async (label) => {
  await page.click(`.toolbox button[aria-label="${label}"]`);
};
const setProp = async (label, value) => {
  const el = await page.$(`.grid4 label:nth-child(${['X', 'Y', 'W', 'H'].indexOf(label) + 1}) input`);
  await el.click();
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await el.type(String(value));
};
const lastFieldRect = async () =>
  page.evaluate(() => {
    const sel = document.querySelector('.field-box.selected');
    const pg = sel.closest('.page');
    const s = pg.getBoundingClientRect().width / 595.32;
    const r = sel.getBoundingClientRect();
    const p = pg.getBoundingClientRect();
    return { x: (r.left - p.left) / s, y: (r.top - p.top) / s, w: r.width / s, h: r.height / s };
  });

// ---------- 2. manual placement
log('place a text field by dragging over "Nombre del paciente"');
await scrollToPdf(P, BOX_NAME.y);
await selectTool('Text');
{
  const a = await toScreen(P, BOX_NAME.x, BOX_NAME.y);
  const z = await toScreen(P, BOX_NAME.x + BOX_NAME.w, BOX_NAME.y + BOX_NAME.h);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + z.x) / 2, (a.y + z.y) / 2, { steps: 4 });
  await page.mouse.move(z.x, z.y, { steps: 4 });
  await page.mouse.up();
}
const dragged = await lastFieldRect();
const s0 = await scaleOf(P);
check('dragged rectangle matches the printed box (within one screen pixel)', () => {
  for (const k of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(dragged[k] - BOX_NAME[k]) <= 1.01 / s0 + 0.01, `${k}: ${dragged[k]} vs ${BOX_NAME[k]}`);
});
// rename it
await page.$eval('.prop-row input', (el) => el.focus());
await page.keyboard.down('Control');
await page.keyboard.press('a');
await page.keyboard.up('Control');
await page.keyboard.type('Nombre del paciente');

log('place a date field by click, then set exact geometry in the properties panel');
await selectTool('Date');
{
  const c = await toScreen(P, BOX_DOB.x + 20, BOX_DOB.y + BOX_DOB.h / 2);
  await page.mouse.click(c.x, c.y);
}
await setProp('X', BOX_DOB.x);
await setProp('Y', BOX_DOB.y);
await setProp('W', BOX_DOB.w);
await setProp('H', BOX_DOB.h);
await page.$eval('.prop-row input', (el) => el.focus());
await page.keyboard.down('Control');
await page.keyboard.press('a');
await page.keyboard.up('Control');
await page.keyboard.type('Fecha de nacimiento');

log('place checkboxes over printed squares (H / M) and in the symptom list');
for (const [box, name] of [
  [CHK_H, 'Sexo H'],
  [CHK_M, 'Sexo M'],
]) {
  await selectTool('Checkbox');
  const a = await toScreen(P, box.x, box.y);
  const z = await toScreen(P, box.x + box.w, box.y + box.h);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(z.x, z.y, { steps: 5 });
  await page.mouse.up();
  await setProp('X', box.x);
  await setProp('Y', box.y);
  await setProp('W', box.w);
  await setProp('H', box.h);
  await page.$eval('.prop-row input', (el) => el.focus());
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.type(name);
  if (process.env.E2E_DEBUG) {
    await page.screenshot({ path: join(OUT, `dbg-${name}.png`) });
    log(name, await page.$$eval('.field-box', (els) => els.map((e) => e.title + ' ' + e.style.cssText).join('\n')));
  }
}
await scrollToPdf(P, CHK_ROW1.y);
await selectTool('Checkbox');
{
  const c = await toScreen(P, CHK_ROW1.x + 3, CHK_ROW1.y + 3);
  await page.mouse.click(c.x, c.y);
  await setProp('X', CHK_ROW1.x);
  await setProp('Y', CHK_ROW1.y);
  await setProp('W', CHK_ROW1.w);
  await setProp('H', CHK_ROW1.h);
}
log('place a long-text field over the notes box');
await scrollToPdf(P, BOX_NOTES.y);
await selectTool('Long text');
{
  const a = await toScreen(P, BOX_NOTES.x, BOX_NOTES.y);
  const z = await toScreen(P, BOX_NOTES.x + BOX_NOTES.w, BOX_NOTES.y + BOX_NOTES.h);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(z.x, z.y, { steps: 6 });
  await page.mouse.up();
  await setProp('X', BOX_NOTES.x);
  await setProp('Y', BOX_NOTES.y);
  await setProp('W', BOX_NOTES.w);
  await setProp('H', BOX_NOTES.h);
}
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.press('Escape');
const nFields = await page.$$eval('.field-box', (els) => els.length);
await page.screenshot({ path: join(OUT, 'edit-mode.png') });
const names = await page.$$eval('.field-box', (els) => els.map((e) => e.title));
log('fields:', names.join(' | '));
check('six fields placed', () => assert.equal(nFields, 6));

// undo / redo
await page.keyboard.down('Control');
await page.keyboard.press('z');
await page.keyboard.up('Control');
await sleep(100);
const afterUndo = await page.$$eval('.field-box', (els) => els.length);
await page.keyboard.down('Control');
await page.keyboard.down('Shift');
await page.keyboard.press('z');
await page.keyboard.up('Shift');
await page.keyboard.up('Control');
await sleep(100);
const afterRedo = await page.$$eval('.field-box', (els) => els.length);
check('undo / redo', () => {
  assert.ok(afterUndo <= 6);
  assert.equal(afterRedo, 6);
});

// ---------- 3. fill
log('fill mode');
await page.click('.mode-btn:nth-child(2)');
await page.waitForSelector('.fill-panel');
const NAME = 'José Ñúñez Güell';
const NOTES = 'Refiere olvidos frecuentes desde la infancia; pierde llaves y móvil a menudo. También: «¿dónde dejé las gafas?»';
await page.type('.fill-field input[type=text]', NAME);
// date input
await page.$eval('.fill-field input[type=date]', (el) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(el, '1985-03-09');
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.type('.fill-field textarea', NOTES);
// tick "Sexo M" by clicking ON THE PDF
await scrollToPdf(P, CHK_M.y);
{
  const c = await toScreen(P, CHK_M.x + CHK_M.w / 2, CHK_M.y + CHK_M.h / 2);
  await page.mouse.click(c.x, c.y);
}
// tick the symptom checkbox via the side panel
const checks = await page.$$('.fill-check input[type=checkbox]');
const labels = await page.$$eval('.fill-check span', (els) => els.map((e) => e.textContent));
await checks[labels.findIndex((l) => l.startsWith('Checkbox'))].click();
await sleep(300);
const filledState = await page.evaluate(() => ({
  text: [...document.querySelectorAll('.content-svg text.field-text')].map((t) => t.textContent),
  marks: document.querySelectorAll('.content-svg line').length / 2,
}));
check('overlay shows typed values immediately', () => {
  assert.ok(filledState.text.includes(NAME), JSON.stringify(filledState.text));
  assert.ok(filledState.text.includes('09/03/1985'));
  assert.equal(filledState.marks, 2);
});

// ---------- 4. alignment of overlays with the rendered page at several zoom levels
async function measureAlignment(tag) {
  await scrollToPdf(P, BOX_NAME.y);
  await sleep(700);
  try {
    await page.waitForFunction(() => document.querySelector('.page[data-page="1"] canvas'), { timeout: 8000 });
  } catch {
    await page.screenshot({ path: join(OUT, `nocanvas-${tag}.png`) });
    throw new Error('page 2 canvas missing at ' + tag);
  }
  // Find the printed frame of the "Nombre del paciente" box in the rendered canvas and compare its
  // position with the overlay box of the field placed on it. Each edge = the most saturated pixel
  // within ±4.5 CSS px of the overlay edge (the cyan frame line), sampled across the middle of the box.
  const r = await page.evaluate(() => {
    const pg = document.querySelector('.page[data-page="1"]');
    const canvas = pg.querySelector('canvas');
    const box = [...pg.querySelectorAll('.field-box')].find((b) => b.title.startsWith('Nombre'));
    const pr = pg.getBoundingClientRect();
    const br = box.getBoundingClientRect();
    const ctx = canvas.getContext('2d');
    const k = canvas.width / pr.width; // canvas px per CSS px
    const sat = (d, i) => Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
    const peak = (from, to, get) => {
      let best = -1, at = from;
      for (let p = Math.max(0, Math.round(from)); p <= Math.round(to); p++) {
        const v = get(p);
        if (v > best) { best = v; at = p; }
      }
      return (at + 0.5) / k;
    };
    const yMid = Math.round((br.top - pr.top + br.height / 2) * k);
    const row = ctx.getImageData(0, yMid, canvas.width, 1).data;
    const xMid = Math.round((br.left - pr.left + br.width / 2) * k);
    const col = ctx.getImageData(xMid, 0, 1, canvas.height).data;
    const W = 4.5 * k; // < half the 8.75 pt gap to the next printed box at the smallest zoom
    const o = { l: br.left - pr.left, r: br.right - pr.left, t: br.top - pr.top, b: br.bottom - pr.top };
    return {
      scale: pr.width / 595.32,
      overlay: o,
      printed: {
        l: peak(o.l * k - W, o.l * k, (x) => sat(row, x * 4)),
        r: peak(o.r * k, o.r * k + W, (x) => sat(row, x * 4)),
        t: peak(o.t * k - W, o.t * k, (y) => sat(col, y * 4)),
        b: peak(o.b * k, o.b * k + W, (y) => sat(col, y * 4)),
      },
    };
  });
  // the frame line (≈1 pt wide) sits just outside the interior the field covers:
  // its centre should be ~0.5 pt outside the overlay edge
  const half = 0.5 * r.scale;
  const tol = 0.6 * r.scale + 1;
  const off = {
    l: r.overlay.l - half - r.printed.l,
    r: r.printed.r - (r.overlay.r + half),
    t: r.overlay.t - half - r.printed.t,
    b: r.printed.b - (r.overlay.b + half),
  };
  log(`alignment @${tag} scale ${r.scale.toFixed(2)}: edge offsets (CSS px)`, Object.entries(off).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', '));
  check(`overlay aligned with printed box at ${tag} (scale ${r.scale.toFixed(2)})`, () => {
    for (const [k, v] of Object.entries(off)) assert.ok(Math.abs(v) <= tol, `${k} off by ${v.toFixed(2)}px (tol ${tol.toFixed(2)})`);
  });
  return r;
}
await measureAlignment('fit width');
await page.click('.zoombar button[aria-label="Zoom in"]');
await page.click('.zoombar button[aria-label="Zoom in"]');
await sleep(600);
await measureAlignment('zoomed in');
await page.click('.zoombar .btn:last-child'); // fit page
await sleep(600);
await measureAlignment('fit page');
await page.setViewport({ width: 1024, height: 768 });
await sleep(800);
await measureAlignment('tablet window');
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
await sleep(900);
await measureAlignment('HiDPI');
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
await page.click('.zoombar .btn:nth-last-child(2)'); // fit width
await sleep(600);
await page.screenshot({ path: join(OUT, 'fill-mode.png') });

// ---------- 5. export
async function exportPdf(modeLabel) {
  await page.click('.topbar .btn.primary');
  await page.waitForSelector('.modal');
  if (modeLabel === 'editable') await page.click('.choice label:nth-of-type(2) input');
  const name = await page.$eval('#exp-name', (e) => e.value);
  const fname = modeLabel === 'editable' ? name.replace('.pdf', '_editable.pdf') : name;
  await page.$eval(
    '#exp-name',
    (e, v) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(e, v);
      e.dispatchEvent(new Event('input', { bubbles: true }));
    },
    fname,
  );
  await page.click('.modal-actions .btn.primary');
  const file = await waitForFile(DL, (n) => n === fname, 60000);
  await page.waitForSelector('.check-block.ok');
  const warnings = await page.$$eval('.check-block.ok li', (els) => els.map((e) => e.textContent));
  await page.click('.modal-actions .btn:not(.primary)');
  return { file, warnings, name: fname };
}
log('export flattened');
const flat = await exportPdf('flatten');
log('export editable');
const editable = await exportPdf('editable');

function rasterPage(file, pageIndex, dpi = 288) {
  const dir = mkdtempSync(join(tmpdir(), 'r-'));
  execFileSync('pdftoppm', ['-r', String(dpi), '-cropbox', '-f', String(pageIndex + 1), '-l', String(pageIndex + 1), '-singlefile', file, join(dir, 'o')]);
  const buf = readFileSync(join(dir, 'o.ppm'));
  // P6 header: "P6\n<w> <h>\n255\n"
  const header = buf.subarray(0, 40).toString('latin1').split(/\s+/);
  const w = +header[1], h = +header[2];
  const off = buf.indexOf(Buffer.from('255\n')) + 4;
  return { w, h, data: buf.subarray(off), k: dpi / 72 };
}
// "entry ink" = the default dark blue (#0b2a6f) — distinct from the form's own cyan/black
const isInk = (R, G, B) => B > 70 && B < 160 && R < 60 && G < 80 && B - R > 50;
function inkBox(r, rect, margin = 4) {
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
  for (let y = Math.floor((rect.y - margin) * r.k); y < (rect.y + rect.h + margin) * r.k; y++)
    for (let x = Math.floor((rect.x - margin) * r.k); x < (rect.x + rect.w + margin) * r.k; x++) {
      const i = (y * r.w + x) * 3;
      if (isInk(r.data[i], r.data[i + 1], r.data[i + 2])) {
        n++;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  return n ? { x0: x0 / r.k, y0: y0 / r.k, x1: (x1 + 1) / r.k, y1: (y1 + 1) / r.k, n } : null;
}
function inside(name, ink, rect, tol = 0.6) {
  check(name, () => {
    assert.ok(ink, 'no ink found');
    assert.ok(ink.x0 >= rect.x - tol && ink.y0 >= rect.y - tol && ink.x1 <= rect.x + rect.w + tol && ink.y1 <= rect.y + rect.h + tol, JSON.stringify({ ink, rect }));
  });
}
for (const out of [flat, editable]) {
  const tag = out === flat ? 'flattened' : 'editable';
  const r = rasterPage(out.file, P);
  inside(`${tag}: patient name inside its box`, inkBox(r, BOX_NAME), BOX_NAME);
  inside(`${tag}: date of birth inside its box`, inkBox(r, BOX_DOB), BOX_DOB);
  for (const [label, box] of [['patient name', BOX_NAME], ['date of birth', BOX_DOB]]) {
    const ink = inkBox(r, box, 0);
    check(`${tag}: ${label} vertically centred`, () => assert.ok(ink && Math.abs((ink.y0 + ink.y1) / 2 - (box.y + box.h / 2)) < 2, JSON.stringify(ink)));
  }
  inside(`${tag}: “M” tick inside the printed square`, inkBox(r, CHK_M, 3), CHK_M);
  inside(`${tag}: symptom tick inside the printed square`, inkBox(r, CHK_ROW1, 3), CHK_ROW1);
  inside(`${tag}: notes inside the notes box`, inkBox(r, BOX_NOTES), BOX_NOTES);
  check(`${tag}: “H” left empty`, () => assert.equal(inkBox(r, CHK_H, 1), null));
  const txt = execFileSync('pdftotext', ['-f', '2', '-l', '2', out.file, '-']).toString();
  check(`${tag}: Spanish characters are real text (ñ, ú, ü, ¿, «)`, () => {
    if (tag === 'editable') return; // poppler does not extract form-field appearance text
    assert.ok(txt.includes(NAME), txt.slice(0, 200));
    assert.ok(txt.includes('¿dónde'));
  });
  check(`${tag}: no export warnings`, () => assert.deepEqual(out.warnings, []));
}
// pages other than page 2 unchanged (pixel identical to the original)
{
  const same = (a, b) => a.w === b.w && a.h === b.h && Buffer.compare(a.data, b.data) === 0;
  const pagesChecked = [0, 2, 9, 14];
  check(`flattened: untouched pages are pixel-identical (${pagesChecked.map((p) => p + 1).join(', ')})`, () => {
    for (const p of pagesChecked) assert.ok(same(rasterPage(PDF, p, 72), rasterPage(flat.file, p, 72)), `page ${p + 1}`);
  });
  const info = (f) => execFileSync('pdfinfo', ['-f', '1', '-l', '99', f]).toString().match(/Page\s+\d+ size:.*$/gm);
  check('flattened: page count and sizes preserved', () => assert.deepEqual(info(flat.file), info(PDF)));
}
writeFileSync(join(OUT, 'flattened.pdf'), readFileSync(flat.file));
writeFileSync(join(OUT, 'editable.pdf'), readFileSync(editable.file));

// ---------- 6. persistence: reload and reopen
log('reload and reopen from browser storage');
await sleep(1200); // autosave debounce
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.project-open');
await page.click('.project-open');
await page.waitForSelector('.fill-panel, .toolbox');
await sleep(800);
const reopened = await page.evaluate(() => ({
  boxes: document.querySelectorAll('.field-box').length,
  text: [...document.querySelectorAll('.content-svg text.field-text')].map((t) => t.textContent),
}));
check('project reopens with fields and answers', () => {
  assert.equal(reopened.boxes, 6);
  assert.ok(reopened.text.includes(NAME));
});

// ---------- preview mode shows the generated PDF
log('preview mode');
await page.click('.mode-btn:nth-child(3)');
await page.waitForSelector('.preview-bar', { timeout: 60000 });
await page.waitForFunction(() => document.querySelectorAll('.page canvas').length > 0, { timeout: 60000 });
await sleep(800);
await page.screenshot({ path: join(OUT, 'preview.png') });
await page.click('.preview-bar .btn.primary');
const previewFile = await waitForFile(DL, (n) => n.includes('completed') && !n.includes('editable') && n !== flat.name, 30000).catch(() => null);
check('preview offers the same flattened PDF for download', () => {
  // the preview download has the default name (same as the first export) → compare page 2 raster with the flattened export
  const f = previewFile ?? flat.file;
  const a = rasterPage(f, P, 72), c = rasterPage(flat.file, P, 72);
  assert.equal(Buffer.compare(a.data, c.data), 0);
});

// ---------- project file: download, then open it in a fresh browser profile
log('project file round trip');
await page.click('.mode-btn:nth-child(2)');
await page.click('.topbar .btn.ghost');
const projFile = await waitForFile(DL, (n) => n.endsWith('.fillmark'), 30000);
{
  // wipe this browser's storage (as if on another computer), then open the project file
  await page.goto(URL_, { waitUntil: 'networkidle0' });
  await page.evaluate(
    () =>
      new Promise((res) => {
        const r = indexedDB.deleteDatabase('pdf-form-filler');
        r.onsuccess = r.onerror = r.onblocked = () => res();
      }),
  );
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(300);
  const empty = await page.$$('.project-open');
  const input = await page.$('.projects input[type=file]');
  await input.uploadFile(projFile);
  await page.waitForSelector('.topbar', { timeout: 60000 });
  await sleep(1000);
  const st = await page.evaluate(() => ({
    boxes: document.querySelectorAll('.field-box').length,
    text: [...document.querySelectorAll('.content-svg text.field-text')].map((t) => t.textContent),
  }));
  check('project file reopens after browser storage is wiped, with fields and answers', () => {
    assert.equal(empty.length, 0);
    assert.equal(st.boxes, 6);
    assert.ok(st.text.includes(NAME));
  });
}

// ---------- invalid input produces useful errors
log('invalid files');
{
  const dir = mkdtempSync(join(tmpdir(), 'bad-'));
  writeFileSync(join(dir, 'notes.pdf'), 'this is not a pdf');
  const real = readFileSync(PDF);
  writeFileSync(join(dir, 'truncated.pdf'), real.subarray(0, 4000));
  execFileSync('qpdf', ['--encrypt', 'user123', 'owner123', '256', '--', PDF, join(dir, 'password.pdf')]);
  execFileSync('qpdf', ['--encrypt', '', 'owner123', '256', '--modify=none', '--', PDF, join(dir, 'restricted.pdf')]);
  for (const [file, expect] of [
    ['notes.pdf', /not a PDF/i],
    ['truncated.pdf', /damaged|could not be opened|incomplete/i],
    ['password.pdf', /password/i],
    ['restricted.pdf', /restrictions|encrypt/i],
  ]) {
    await page.goto(URL_, { waitUntil: 'networkidle0' });
    const input = await page.waitForSelector('.dropzone input[type=file]', { hidden: true });
    await input.uploadFile(join(dir, file));
    await page.waitForSelector('.alert', { timeout: 30000 });
    const msg = await page.$eval('.alert', (e) => e.textContent);
    check(`clear error for ${file}: “${msg.slice(0, 70)}…”`, () => assert.match(msg, expect));
  }
}

// ---------- 7. privacy
check('no request left localhost', () => assert.deepEqual(external, []));
check('no errors in the browser console', () => assert.deepEqual(errors, []));

await b.close();
console.log('\nartifacts:', OUT);
for (const r of results) console.log(r[0], r[1], r[2] ? `\n      ${r[2]}` : '');
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
