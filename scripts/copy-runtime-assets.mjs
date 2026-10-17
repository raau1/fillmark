// Copies the runtime data the app needs into public/ so everything is served
// by the app itself — no CDN or third-party requests at runtime:
//  - pdf.js: CMaps, standard fonts, wasm image decoders, ICC profiles → public/pdfjs
//  - OCR (tesseract.js, optional label reading): worker, wasm core, Spanish +
//    English language data → public/ocr
import { cpSync, mkdirSync, existsSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const need = (p) => {
  if (!existsSync(p)) {
    console.error(`Missing ${p}; run npm install first.`);
    process.exit(1);
  }
  return p;
};

// pdf.js
const pdfjs = need(join(nm, 'pdfjs-dist'));
const pdfDst = join(root, 'public', 'pdfjs');
mkdirSync(pdfDst, { recursive: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) cpSync(join(pdfjs, dir), join(pdfDst, dir), { recursive: true });

// OCR
const ocrDst = join(root, 'public', 'ocr');
mkdirSync(join(ocrDst, 'core'), { recursive: true });
mkdirSync(join(ocrDst, 'lang'), { recursive: true });
buildSync({
  entryPoints: [need(join(nm, 'tesseract.js', 'src', 'worker-script', 'browser', 'index.js'))],
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  define: { global: 'self' },
  outfile: join(ocrDst, 'worker.min.js'),
  logLevel: 'warning',
});
const core = need(join(nm, 'tesseract.js-core'));
for (const f of ['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js']) {
  copyFileSync(join(core, f), join(ocrDst, 'core', f));
}
// Stored uncompressed: whether a server adds "Content-Encoding: gzip" to .gz files
// varies, and the OCR library's own gunzip stalls on these files in the browser.
for (const lang of ['spa', 'eng']) {
  const gz = readFileSync(need(join(nm, '@tesseract.js-data', lang, '4.0.0_best_int', `${lang}.traineddata.gz`)));
  writeFileSync(join(ocrDst, 'lang', `${lang}.traineddata`), gunzipSync(gz));
  rmSync(join(ocrDst, 'lang', `${lang}.traineddata.gz`), { force: true });
}
console.log('Runtime assets copied to public/pdfjs and public/ocr');
