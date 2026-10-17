import sansUrl from '../assets/fonts/DejaVuSans.ttf?url';
import sansCondUrl from '../assets/fonts/DejaVuSansCondensed.ttf?url';
import serifUrl from '../assets/fonts/DejaVuSerif.ttf?url';
import { createMeasurer, type FontFiles, type Measurer } from '../core/fonts';

export const FONT_URLS = {
  'DejaVuSans.ttf': sansUrl,
  'DejaVuSansCondensed.ttf': sansCondUrl,
  'DejaVuSerif.ttf': serifUrl,
} as const;

let filesPromise: Promise<FontFiles> | null = null;
let measurerPromise: Promise<Measurer> | null = null;

/** Fonts are served by the app itself (same origin); nothing is fetched from third parties. */
export function loadFontFiles(): Promise<FontFiles> {
  if (!filesPromise) {
    filesPromise = (async () => {
      const entries = await Promise.all(
        Object.entries(FONT_URLS).map(async ([name, url]) => {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`Font ${name} could not be loaded (${res.status})`);
          return [name, new Uint8Array(await res.arrayBuffer())] as const;
        }),
      );
      return Object.fromEntries(entries) as FontFiles;
    })();
    filesPromise.catch(() => (filesPromise = null));
  }
  return filesPromise;
}

export function loadMeasurer(): Promise<Measurer> {
  if (!measurerPromise) {
    measurerPromise = loadFontFiles().then(createMeasurer);
    measurerPromise.catch(() => (measurerPromise = null));
  }
  return measurerPromise;
}
