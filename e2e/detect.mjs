// End-to-end check of automatic detection on the example questionnaire:
// detect → review → fill via the side panel → export → every tick lands in its printed square.
// Usage: npm run dev, then: node e2e/detect.mjs [path/to/form.pdf]
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
const OUT = process.env.E2E_OUT ?? mkdtempSync(join(tmpdir(), 'fillmark-det-'));
const DL = mkdtempSync(join(tmpdir(), 'fillmark-dl-'));
const OCR = process.env.E2E_OCR !== '0';
const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push(['PASS', name]);
  } catch (e) {
    results.push(['FAIL', name, e.message]);
  }
};
const log = (...a) => console.log('•', ...a);

const b = await launch();
const page = await b.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const external = watchNetwork(page);
await allowDownloads(page, DL);
await page.goto(URL_, { waitUntil: 'networkidle0' });
await page.evaluate(() => {
  localStorage.setItem('pff.lang', 'en');
  return new Promise((r) => {
    const q = indexedDB.deleteDatabase('pdf-form-filler');
    q.onsuccess = q.onerror = q.onblocked = () => r();
  });
});
await page.reload({ waitUntil: 'networkidle0' });
await uploadPdf(page, PDF);

log('detect fields on all pages', OCR ? '(with OCR)' : '(no OCR)');
await page.click('.detect-btn');
await page.waitForSelector('.modal');
if (!OCR) {
  const boxes = await page.$$('.detect-options input[type=checkbox]');
  await boxes[4].click();
}
const t0 = Date.now();
await page.click('.modal-actions .btn.primary');
await page.waitForSelector('.detect-summary, .modal .detect-section p strong', { timeout: 600000 });
const secs = ((Date.now() - t0) / 1000).toFixed(1);
const summary = await page.$eval('.modal', (m) => m.innerText);
log(`detection took ${secs}s\n${summary}`);
await page.screenshot({ path: join(OUT, 'detect-summary.png') });
await page.click('.modal-actions .btn.primary');
await sleep(1500);

const fields = await page.evaluate(() =>
  [...document.querySelectorAll('.field-box')].map((b) => {
    const pg = b.closest('.page');
    const s = pg.getBoundingClientRect().width / 595.32;
    const r = b.getBoundingClientRect();
    const p = pg.getBoundingClientRect();
    return { page: +pg.dataset.page, title: b.title, cls: b.className, x: (r.left - p.left) / s, y: (r.top - p.top) / s, w: r.width / s, h: r.height / s };
  }),
);
writeFileSync(join(OUT, 'detected.json'), JSON.stringify(fields, null, 1));
const toggles = fields.filter((f) => /t-(checkbox|radio)/.test(f.cls));
const texts = fields.filter((f) => /t-(text|multiline)/.test(f.cls));
log(`${fields.length} fields: ${toggles.length} tick boxes, ${texts.length} text boxes`);
check('detects the tick boxes of the questionnaire (≥ 410 of 418)', () => assert.ok(toggles.length >= 410, String(toggles.length)));
check('detects the text boxes (≥ 52 of 53)', () => assert.ok(texts.length >= 52, String(texts.length)));
check('all detected fields are marked as suggestions', () => assert.ok(fields.every((f) => f.cls.includes('suggested'))));
check('nothing detected on the cover pages', () => assert.equal(fields.filter((f) => f.page === 0 || f.page === 14).length, 0));
check('patient information boxes found on page 2', () => assert.equal(texts.filter((f) => f.page === 1 && f.y < 200).length, 5));
if (OCR) {
  const names = fields.map((f) => f.title);
  log('sample names:', names.filter((n, i) => i % 40 === 0).join(' | '));
  check('OCR labels: "Nombre (del) paciente"', () => assert.ok(names.some((n) => /nombre (del )?paciente/i.test(n)), names.slice(0, 10).join(' | ')));
  check('OCR labels: "Comete errores por olvidos"', () => assert.ok(names.some((n) => /comete errores/i.test(n))));
  check('OCR labels: Sí / No choice', () => assert.ok(names.some((n) => /s[ií]ntoma presente: s[ií]/i.test(n)), names.filter((n) => /:/.test(n)).slice(0, 6).join(' | ')));
}
await page.screenshot({ path: join(OUT, 'detected-edit.png') });

// accept all suggestions
await page.click('.tabs .tab:nth-child(2)');
await page.waitForSelector('.review-box .btn.primary');
await page.click('.review-box .btn.primary');
await sleep(300);
const stillSuggested = await page.$$eval('.field-box.suggested', (e) => e.length);
check('no suggestions left after "Accept all"', () => assert.equal(stillSuggested, 0));

// fill: tick every 7th checkbox in the side panel, type the patient name
await page.click('.mode-btn:nth-child(2)');
await page.waitForSelector('.fill-panel');
const boxesInPanel = await page.$$('.fill-check input[type=checkbox]');
for (let i = 0; i < boxesInPanel.length; i += 7) await boxesInPanel[i].click();
const textInputs = await page.$$('.fill-field input[type=text]');
await textInputs[0].type('María Ñúñez');
await sleep(400);
await page.screenshot({ path: join(OUT, 'detected-fill.png') });
const ticked = await page.evaluate(() =>
  [...document.querySelectorAll('.field-box[aria-checked="true"]')].map((b) => {
    const pg = b.closest('.page');
    const s = pg.getBoundingClientRect().width / 595.32;
    const r = b.getBoundingClientRect();
    const p = pg.getBoundingClientRect();
    return { page: +pg.dataset.page, x: (r.left - p.left) / s, y: (r.top - p.top) / s, w: r.width / s, h: r.height / s };
  }),
);
log(`${ticked.length} boxes ticked`);

// export and verify each tick is inside its printed square
await page.click('.topbar .btn.primary');
await page.waitForSelector('.modal');
await page.click('.modal-actions .btn.primary');
const file = await waitForFile(DL, (n) => n.endsWith('.pdf'), 90000);
writeFileSync(join(OUT, 'detected-flattened.pdf'), readFileSync(file));
const rasters = new Map();
function raster(p) {
  if (rasters.has(p)) return rasters.get(p);
  const dir = mkdtempSync(join(tmpdir(), 'r-'));
  execFileSync('pdftoppm', ['-r', '288', '-cropbox', '-f', String(p + 1), '-l', String(p + 1), '-singlefile', file, join(dir, 'o')]);
  const buf = readFileSync(join(dir, 'o.ppm'));
  const hdr = buf.subarray(0, 40).toString('latin1').split(/\s+/);
  const r = { w: +hdr[1], h: +hdr[2], data: buf.subarray(buf.indexOf(Buffer.from('255\n')) + 4), k: 4 };
  rasters.set(p, r);
  return r;
}
const isInk = (R, G, B) => B > 70 && B < 160 && R < 60 && G < 80 && B - R > 50;
let bad = 0;
for (const t of ticked) {
  const r = raster(t.page);
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let y = Math.floor((t.y - 3) * r.k); y < (t.y + t.h + 3) * r.k; y++)
    for (let x = Math.floor((t.x - 3) * r.k); x < (t.x + t.w + 3) * r.k; x++) {
      const i = (y * r.w + x) * 3;
      if (isInk(r.data[i], r.data[i + 1], r.data[i + 2])) {
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
    }
  const ok = x1 >= 0 && x0 / r.k >= t.x - 0.6 && y0 / r.k >= t.y - 0.6 && (x1 + 1) / r.k <= t.x + t.w + 0.6 && (y1 + 1) / r.k <= t.y + t.h + 0.6;
  if (!ok) bad++;
}
check(`all ${ticked.length} exported ticks sit inside their printed squares`, () => assert.equal(bad, 0));
check('no request left localhost', () => assert.deepEqual(external, []));
check('no errors in the browser console', () => assert.deepEqual(errors, []));
await b.close();
console.log('\nartifacts:', OUT);
for (const r of results) console.log(r[0], r[1], r[2] ? `\n      ${r[2]}` : '');
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
