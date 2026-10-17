import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { pdfjs, type PDFDocumentProxy } from '../pdf/pdfjs';
import type { PageInfo, Rect } from '../core/types';

export interface ViewerHandle {
  scrollToPage(page: number): void;
  /** Scroll so that a display rect on a page is visible (centred if it is off screen). */
  revealRect(page: number, rect: Rect): void;
  getViewportSize(): { width: number; height: number };
  getElement(): HTMLDivElement | null;
}

interface Props {
  doc: PDFDocumentProxy;
  pages: PageInfo[];
  scale: number;
  hideFormWidgets: boolean;
  renderOverlay?: (page: number) => ReactNode;
  onCurrentPage?: (page: number) => void;
  onViewportResize?: (size: { width: number; height: number }) => void;
  placeholders?: (string | undefined)[];
  /** aria label for the scroll area */
  label: string;
}

const PAGE_GAP = 20;
const PAD = 24;
const MAX_CANVAS_PIXELS = 16_000_000;

export const Viewer = forwardRef<ViewerHandle, Props>(function Viewer(
  { doc, pages, scale, hideFormWidgets, renderOverlay, onCurrentPage, onViewportResize, placeholders, label },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [near, setNear] = useState<Set<number>>(() => new Set([0, 1]));
  const prevScale = useRef(scale);

  // keep the centre of the view fixed while zooming
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const old = prevScale.current;
    prevScale.current = scale;
    if (!el || old === scale) return;
    if (el.scrollTop === 0 && el.scrollLeft === 0) return; // initial fit: stay at the top
    const k = scale / old;
    const cy = el.scrollTop + el.clientHeight / 2;
    const cx = el.scrollLeft + el.clientWidth / 2;
    el.scrollTop = (cy - PAD) * k + PAD - el.clientHeight / 2;
    el.scrollLeft = (cx - PAD) * k + PAD - el.clientWidth / 2;
  }, [scale]);

  // which pages are near the viewport (rendered) — others keep only a placeholder
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => {
        setNear((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const i = Number((e.target as HTMLElement).dataset.page);
            if (e.isIntersecting) next.add(i);
            else next.delete(i);
          }
          return next;
        });
      },
      { root, rootMargin: '1200px 0px' },
    );
    pageRefs.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, [pages.length]);

  // current page = the one covering the upper third of the viewport
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !onCurrentPage) return;
    const probe = el.getBoundingClientRect().top + el.clientHeight / 3;
    let cur = 0;
    pageRefs.current.forEach((p, i) => {
      if (p && p.getBoundingClientRect().top <= probe) cur = i;
    });
    onCurrentPage(cur);
  }, [onCurrentPage]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !onViewportResize) return;
    const ro = new ResizeObserver(() => onViewportResize({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [onViewportResize]);

  /** page position inside the scroll area (offsetTop would be relative to the nearest positioned ancestor) */
  const posOf = (p: HTMLElement) => {
    const el = scrollRef.current!;
    const a = p.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    return { top: a.top - b.top + el.scrollTop, left: a.left - b.left + el.scrollLeft };
  };

  useImperativeHandle(
    ref,
    () => ({
      scrollToPage(page) {
        const el = scrollRef.current;
        const p = pageRefs.current[page];
        if (el && p) el.scrollTo({ top: posOf(p).top - PAD / 2, behavior: 'smooth' });
      },
      revealRect(page, rect) {
        const el = scrollRef.current;
        const p = pageRefs.current[page];
        if (!el || !p) return;
        const pos = posOf(p);
        const top = pos.top + rect.y * scale;
        const bottom = top + rect.h * scale;
        const left = pos.left + rect.x * scale;
        const right = left + rect.w * scale;
        const visible =
          top >= el.scrollTop + 8 && bottom <= el.scrollTop + el.clientHeight - 8 && left >= el.scrollLeft && right <= el.scrollLeft + el.clientWidth;
        if (visible) return;
        el.scrollTo({
          top: Math.max(0, (top + bottom) / 2 - el.clientHeight / 2),
          left: right > el.scrollLeft + el.clientWidth || left < el.scrollLeft ? Math.max(0, (left + right) / 2 - el.clientWidth / 2) : el.scrollLeft,
          behavior: 'smooth',
        });
      },
      getViewportSize() {
        const el = scrollRef.current;
        return { width: el?.clientWidth ?? 800, height: el?.clientHeight ?? 600 };
      },
      getElement() {
        return scrollRef.current;
      },
    }),
    [scale],
  );

  return (
    <div className="viewer" ref={scrollRef} onScroll={onScroll} role="region" aria-label={label} tabIndex={-1}>
      <div className="viewer-pages" style={{ padding: PAD, gap: PAGE_GAP }}>
        {pages.map((p, i) => (
          <div
            key={i}
            className="page"
            data-page={i}
            ref={(el) => {
              pageRefs.current[i] = el;
            }}
            style={{ width: p.width * scale, height: p.height * scale }}
          >
            {placeholders?.[i] && <img className="page-placeholder" src={placeholders[i]} alt="" draggable={false} />}
            <PageCanvas doc={doc} index={i} info={p} scale={scale} active={near.has(i)} hideFormWidgets={hideFormWidgets} />
            {renderOverlay?.(i)}
          </div>
        ))}
      </div>
    </div>
  );
});

function PageCanvas({
  doc,
  index,
  info,
  scale,
  active,
  hideFormWidgets,
}: {
  doc: PDFDocumentProxy;
  index: number;
  info: PageInfo;
  scale: number;
  active: boolean;
  hideFormWidgets: boolean;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = holder.current;
    if (!host) return;
    if (!active) {
      // free memory for pages far from the viewport
      host.replaceChildren();
      return;
    }
    let cancelled = false;
    let task: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | null = null;
    const timer = window.setTimeout(async () => {
      try {
        const page = await doc.getPage(index + 1);
        if (cancelled) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        let renderScale = scale * dpr;
        const px = info.width * info.height * renderScale * renderScale;
        if (px > MAX_CANVAS_PIXELS) renderScale *= Math.sqrt(MAX_CANVAS_PIXELS / px);
        const vp = page.getViewport({ scale: renderScale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(vp.width));
        canvas.height = Math.max(1, Math.round(vp.height));
        canvas.className = 'page-canvas';
        task = page.render({
          canvas,
          viewport: vp,
          annotationMode: hideFormWidgets ? pdfjs.AnnotationMode.ENABLE_FORMS : pdfjs.AnnotationMode.ENABLE,
        });
        await task.promise;
        if (cancelled) return;
        host.replaceChildren(canvas); // swap only when the new bitmap is ready (no flicker)
        setError(null);
      } catch (e) {
        const name = (e as { name?: string })?.name;
        if (cancelled || name === 'RenderingCancelledException') return;
        setError((e as Error)?.message ?? 'Render failed');
      }
    }, host.childElementCount ? 140 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      task?.cancel();
    };
  }, [doc, index, info, scale, active, hideFormWidgets]);

  return (
    <div className="page-canvas-holder" ref={holder} aria-hidden="true">
      {error && <div className="page-error">{error}</div>}
    </div>
  );
}

/** Small page images for the sidebar, rendered one at a time in the background. */
export function useThumbnails(doc: PDFDocumentProxy | null, pages: PageInfo[], width = 132, hideFormWidgets = false) {
  const [thumbs, setThumbs] = useState<(string | undefined)[]>([]);
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    const urls: string[] = [];
    setThumbs([]);
    (async () => {
      for (let i = 0; i < pages.length && !cancelled; i++) {
        try {
          const page = await doc.getPage(i + 1);
          const s = (width * 2) / pages[i].width;
          const vp = page.getViewport({ scale: s });
          const c = document.createElement('canvas');
          c.width = Math.round(vp.width);
          c.height = Math.round(vp.height);
          await page.render({
            canvas: c,
            viewport: vp,
            annotationMode: hideFormWidgets ? pdfjs.AnnotationMode.ENABLE_FORMS : pdfjs.AnnotationMode.ENABLE,
          }).promise;
          const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
          if (!blob || cancelled) continue;
          const url = URL.createObjectURL(blob);
          urls.push(url);
          setThumbs((t) => {
            const n = t.slice();
            n[i] = url;
            return n;
          });
          await new Promise((r) => setTimeout(r, 0));
        } catch {
          /* thumbnail failures are not fatal */
        }
      }
    })();
    return () => {
      cancelled = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [doc, pages, width, hideFormWidgets]);
  return thumbs;
}
