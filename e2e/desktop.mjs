// Checks the desktop launcher (built for Linux from the same code as Fillmark.exe):
//  - serves the embedded app with the strict CSP, rejects foreign Host headers and token-less file access
//  - a PDF passed on the command line opens straight into the editor
//  - a second launch with a .fillmark project hands the file to the running instance (no second server)
//  - the launcher exits after the last window closes
// Usage: npm run build:desktop -- --linux, then: node e2e/desktop.mjs [form.pdf]
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { launch, sleep } from './lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(root, 'release', 'fillmark-linux');
const PDF = process.argv[2] ?? process.env.FILLMARK_SAMPLE_PDF;
if (!PDF) {
  console.error('Pass the sample form: node e2e/<script>.mjs path/to/DIVA-5.pdf (or set FILLMARK_SAMPLE_PDF)');
  process.exit(2);
}
const DATA = mkdtempSync(join(tmpdir(), 'fillmark-data-'));
const OPENED = join(DATA, 'opened-urls.txt');
const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (e) {
    results.push(['FAIL', name, e.message]);
  }
};

// a stand-in "browser" that records the window URL the launcher asks for
const fakeBrowser = join(DATA, 'fake-browser.sh');
writeFileSync(fakeBrowser, `#!/bin/sh\nfor a in "$@"; do case "$a" in --app=*) echo "\${a#--app=}" >> "${OPENED}";; esac; done\n`);
chmodSync(fakeBrowser, 0o755);
const env = { ...process.env, FILLMARK_DATA_DIR: DATA, FILLMARK_BROWSER: fakeBrowser };

// 1. first launch with a PDF
const proc = spawn(BIN, [PDF], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let exited = false;
proc.on('exit', () => (exited = true));
for (let i = 0; i < 100 && !(existsSync(OPENED) && readFileSync(OPENED, 'utf8').includes('\n')); i++) await sleep(100);
const firstUrl = readFileSync(OPENED, 'utf8').trim().split('\n')[0];
const base = new URL(firstUrl).origin;
await check('launcher opens a window URL with a token and the file id', () => {
  const u = new URL(firstUrl);
  assert.match(u.origin, /^http:\/\/127\.0\.0\.1:478\d\d$/);
  assert.match(u.searchParams.get('t') ?? '', /^[0-9a-f]{48}$/);
  assert.match(u.searchParams.get('open') ?? '', /^[0-9a-f]{16}$/);
});

// 2. HTTP protections
const curl = (...a) => execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', ...a]).toString();
const id = new URL(firstUrl).searchParams.get('open');
await check('file endpoint refuses requests without the token', () => assert.equal(curl(`${base}/__file/${id}`), '403'));
await check('foreign Host header is rejected (DNS rebinding)', () => assert.equal(curl('-H', 'Host: evil.example', `${base}/`), '403'));
await check('index carries the strict Content-Security-Policy', () => {
  const h = execFileSync('curl', ['-sI', `${base}/`]).toString();
  assert.match(h, /content-security-policy: default-src 'self'.*connect-src 'self'/i);
});
await check('server listens on loopback only', () => {
  // /proc/net/tcp: local address as hex IP:port, state 0A = LISTEN
  const port = Number(new URL(firstUrl).port).toString(16).toUpperCase().padStart(4, '0');
  const rows = [readFileSync('/proc/net/tcp', 'utf8'), existsSync('/proc/net/tcp6') ? readFileSync('/proc/net/tcp6', 'utf8') : '']
    .join('\n')
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => c[1]?.endsWith(':' + port) && c[3] === '0A');
  assert.ok(rows.length > 0, 'listener not found');
  assert.ok(rows.every((c) => c[1] === `0100007F:${port}`), rows.map((c) => c[1]).join(', '));
});

// 3. the window opens the PDF directly
const b = await launch();
const page = await b.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.evaluateOnNewDocument(() => localStorage.setItem('pff.lang', 'en'));
await page.goto(firstUrl, { waitUntil: 'networkidle0' });
await page.waitForSelector('.topbar', { timeout: 60000 });
await page.waitForFunction(() => document.querySelectorAll('.page canvas').length > 0, { timeout: 60000 });
await check('PDF passed on the command line opens straight into the editor', async () => {
  const n = await page.$$eval('.page', (e) => e.length);
  assert.equal(n, 15);
  assert.equal(await page.$eval('.doc-name', (e) => e.value), 'DIVA_TDAH_online');
});
await check('the secret token is removed from the address bar', async () => assert.ok(!(await page.url()).includes('t=')));

// 4. second launch with a project file → handed to the running instance
const proj = join(DATA, 'Prueba ñ.fillmark');
const pdfB64 = readFileSync(PDF).toString('base64');
const now = Date.now();
writeFileSync(
  proj,
  JSON.stringify({
    format: 'pdf-form-filler-project',
    version: 1,
    project: {
      meta: { id: 'p_desktoptest', name: 'Proyecto de prueba', fileName: 'DIVA.pdf', pageCount: 15, createdAt: now, updatedAt: now },
      pages: [],
      fields: [{ id: 'f1', type: 'text', page: 1, rect: { x: 148.5, y: 49.25, w: 403.25, h: 18.25 }, name: 'Nombre del paciente', group: 'Page 2', style: {}, required: false, defaultValue: '', options: [], radioGroup: '', radioValue: '', source: 'manual' }],
      values: { f1: 'Lucía Núñez' },
      settings: { hideOriginalWidgets: false, exportFileName: '' },
    },
    pdf: pdfB64,
  }),
);
const second = spawn(BIN, [proj], { env, stdio: 'ignore' });
const secondCode = await new Promise((r) => second.on('exit', r));
for (let i = 0; i < 50 && readFileSync(OPENED, 'utf8').trim().split('\n').length < 2; i++) await sleep(100);
const urls = readFileSync(OPENED, 'utf8').trim().split('\n');
await check('second launch hands the project to the running instance and exits', () => {
  assert.equal(secondCode, 0);
  assert.equal(urls.length, 2);
  assert.equal(new URL(urls[1]).origin, base);
});
// project files from earlier test builds (InkWell, Casilla) still open
let expected = 2;
for (const ext of ['.inkwell', '.casilla']) {
  const legacy = join(DATA, `Antiguo${ext}`);
  writeFileSync(legacy, readFileSync(proj));
  const code = await new Promise((r) => spawn(BIN, [legacy], { env, stdio: 'ignore' }).on('exit', r));
  expected++;
  for (let i = 0; i < 50 && readFileSync(OPENED, 'utf8').trim().split('\n').length < expected; i++) await sleep(100);
  await check(`legacy ${ext} project files are accepted`, () => {
    assert.equal(code, 0);
    assert.equal(readFileSync(OPENED, 'utf8').trim().split('\n').length, expected);
  });
}
// anything else is refused
{
  const bad = join(DATA, 'notes.txt');
  writeFileSync(bad, 'x');
  const code = await new Promise((r) => spawn(BIN, [bad], { env, stdio: 'ignore' }).on('exit', r));
  await check('other file types are refused without opening a window', () => {
    assert.equal(code, 0);
    assert.equal(readFileSync(OPENED, 'utf8').trim().split('\n').length, expected);
  });
}
const p2 = await b.newPage();
await p2.goto(urls[1], { waitUntil: 'networkidle0' });
await p2.waitForSelector('.topbar', { timeout: 60000 });
await sleep(1000);
await check('double-clicked .fillmark project opens with its answers', async () => {
  assert.equal(await p2.$eval('.doc-name', (e) => e.value), 'Proyecto de prueba');
  const texts = await p2.$$eval('.content-svg text.field-text', (els) => els.map((t) => t.textContent));
  assert.ok(texts.includes('Lucía Núñez'), JSON.stringify(texts));
});

// 5. closing every window ends the launcher
await check('launcher keeps running while windows are open', () => assert.equal(exited, false));
await p2.close({ runBeforeUnload: false });
await sleep(1500);
await check('still running with one window left', () => assert.equal(exited, false));
await page.close({ runBeforeUnload: false });
for (let i = 0; i < 100 && !exited; i++) await sleep(100);
await check('launcher exits a few seconds after the last window closes', () => assert.equal(exited, true));
await check('no page errors', () => assert.deepEqual(errors, []));
await b.close();
if (!exited) proc.kill();

for (const r of results) console.log(r[0], r[1], r[2] ? `\n      ${r[2]}` : '');
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
