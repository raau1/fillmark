// UI check on rotated / cropped pages: draw fields over printed frames by dragging
// on screen, fill them, export, and verify with poppler that the output lands in the frames.
// Usage: npm run dev, then: node e2e/rotated.mjs
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { PDFDocument, degrees, rgb } from 'pdf-lib';
import { launch, uploadPdf, sleep, allowDownloads, waitForFile } from './lib.mjs';

const URL_ = process.env.APP_URL ?? 'http://localhost:5173/';
const DIR = mkdtempSync(join(tmpdir(), 'fillmark-rot-'));
const DL = mkdtempSync(join(tmpdir(), 'fillmark-dl-'));

// Display-space frames we expect to see on screen (top-left origin of the page as displayed)
const FRAME = { x: 60, y: 80, w: 220, h: 24 };
const SQUARE = { x: 60, y: 140, w: 10, h: 10 };
const SPECS = [
  { size: [595, 842], crop: null, rot: 90 },
  { size: [612, 792], crop: [30, 40, 560, 760], rot: 180 },
  { size: [500, 700], crop: null, rot: 270 },
];

// draw the frames in PDF space so that they APPEAR at FRAME / SQUARE after rotation (independent maths)
function toPdf(box, rot, u, v) {
  const [x0, y0, x1, y1] = box;
  if (rot === 90) return [x0 + v, y0 + u];
  if (rot === 180) return [x1 - u, y0 + v];
  if (rot === 270) return [x1 - v, y1 - u];
  return [x0 + u, y1 - v];
}
const doc = await PDFDocument.create();
for (const s of SPECS) {
  const p = doc.addPage(s.size);
  const box = s.crop ?? [0, 0, s.size[0], s.size[1]];
  if (s.crop) p.setCropBox(box[0], box[1], box[2] - box[0], box[3] - box[1]);
  p.setRotation(degrees(s.rot));
  for (const r of [FRAME, SQUARE]) {
    const a = toPdf(box, s.rot, r.x - 1, r.y - 1);
    const b = toPdf(box, s.rot, r.x + r.w + 1, r.y + r.h + 1);
    p.drawRectangle({ x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(a[0] - b[0]), height: Math.abs(a[1] - b[1]), borderColor: rgb(0, 0.6, 0.9), borderWidth: 1 });
  }
}
const src = join(DIR, 'rotated.pdf');
writeFileSync(src, await doc.save());

const b = await launch();
const page = await b.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await allowDownloads(page, DL);
await page.goto(URL_, { waitUntil: 'networkidle0' });
await page.evaluate(() => localStorage.setItem('pff.lang', 'en'));
await page.reload({ waitUntil: 'networkidle0' });
await uploadPdf(page, src);
const results = [];
const pageW = (i) => page.$eval(`.page[data-page="${i}"]`, (el) => el.getBoundingClientRect().width);
for (let i = 0; i < SPECS.length; i++) {
  const s = SPECS[i];
  const box = s.crop ?? [0, 0, s.size[0], s.size[1]];
  const dispW = s.rot % 180 ? box[3] - box[1] : box[2] - box[0];
  await page.$eval('.viewer', (v, i) => (v.scrollTop = v.querySelector(`.page[data-page="${i}"]`).offsetTop), i);
  await sleep(500);
  const scale = (await pageW(i)) / dispW;
  for (const [tool, r] of [
    ['Text', FRAME],
    ['Checkbox', SQUARE],
  ]) {
    await page.click(`.toolbox button[aria-label="${tool}"]`);
    const origin = await page.$eval(`.page[data-page="${i}"]`, (el) => {
      const b = el.getBoundingClientRect();
      return { x: b.left, y: b.top };
    });
    await page.mouse.move(origin.x + r.x * scale, origin.y + r.y * scale);
    await page.mouse.down();
    await page.mouse.move(origin.x + (r.x + r.w) * scale, origin.y + (r.y + r.h) * scale, { steps: 5 });
    await page.mouse.up();
  }
}
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.press('Escape');
console.log('fields per page', await page.$$eval('.page', (ps) => ps.map((p) => p.querySelectorAll('.field-box').length)));
if (process.env.E2E_OUT) await page.screenshot({ path: process.env.E2E_OUT + '/rotated-edit.png' });
await page.click('.mode-btn:nth-child(2)');
await page.waitForSelector('.fill-panel');
for (const el of await page.$$('.fill-field input[type=text]')) await el.type('Rotación ñ');
for (const el of await page.$$('.fill-check input[type=checkbox]')) await el.click();
await page.click('.topbar .btn.primary');
await page.waitForSelector('.modal');
await page.click('.modal-actions .btn.primary');
const out = await waitForFile(DL, (n) => n.endsWith('.pdf'), 60000);
if (process.env.E2E_OUT) writeFileSync(process.env.E2E_OUT + '/rotated-out.pdf', readFileSync(out));

const isInk = (R, G, B) => B > 70 && B < 160 && R < 60 && G < 80 && B - R > 50;
for (let i = 0; i < SPECS.length; i++) {
  const d = mkdtempSync(join(tmpdir(), 'r-'));
  execFileSync('pdftoppm', ['-r', '288', '-cropbox', '-f', String(i + 1), '-l', String(i + 1), '-singlefile', out, join(d, 'o')]);
  const buf = readFileSync(join(d, 'o.ppm'));
  const hdr = buf.subarray(0, 40).toString('latin1').split(/\s+/);
  const w = +hdr[1];
  const data = buf.subarray(buf.indexOf(Buffer.from('255\n')) + 4);
  for (const [name, r] of [
    ['text', FRAME],
    ['tick', SQUARE],
  ]) {
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let y = Math.floor((r.y - 4) * 4); y < (r.y + r.h + 4) * 4; y++)
      for (let x = Math.floor((r.x - 4) * 4); x < (r.x + r.w + 4) * 4; x++) {
        const k = (y * w + x) * 3;
        if (isInk(data[k], data[k + 1], data[k + 2])) {
          x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        }
      }
    const tol = 1.2; // dragging on screen is accurate to about one screen pixel
    try {
      assert.ok(x1 >= 0, 'no ink');
      assert.ok(x0 / 4 >= r.x - tol && y0 / 4 >= r.y - tol && (x1 + 1) / 4 <= r.x + r.w + tol && (y1 + 1) / 4 <= r.y + r.h + tol, JSON.stringify({ x0: x0 / 4, y0: y0 / 4, x1: x1 / 4, y1: y1 / 4 }));
      results.push(['PASS', `page ${i + 1} (/Rotate ${SPECS[i].rot}${SPECS[i].crop ? ', cropped' : ''}): ${name} inside its frame`]);
    } catch (e) {
      results.push(['FAIL', `page ${i + 1} (/Rotate ${SPECS[i].rot}): ${name}`, e.message]);
    }
  }
}
const txt = execFileSync('pdftotext', [out, '-']).toString();
results.push([txt.includes('Rotación ñ') ? 'PASS' : 'FAIL', 'rotated text is extractable Unicode']);
results.push([errors.length ? 'FAIL' : 'PASS', 'no page errors', errors.join('; ')]);
await b.close();
for (const r of results) console.log(r[0], r[1], r[2] ? `\n      ${r[2]}` : '');
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
