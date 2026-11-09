import { useCallback, useEffect, useRef, useState } from 'react';
import { Undo2 } from 'lucide-react';
import { encodeInk, strokePath, type Point } from '../core/signature';
import { useT } from '../i18n';
import { Modal } from './Modal';
import { cx } from './util';

const PEN = 2.2;
export const INK_COLOURS: { value: string; label: string }[] = [
  { value: '#0b2a6f', label: 'Blue' },
  { value: '#111111', label: 'Black' },
  { value: '#1f6f3a', label: 'Green' },
  { value: '#9b1c1c', label: 'Red' },
];

/**
 * Draw a signature with mouse, pen or finger. The strokes are kept as vectors
 * (see core/signature.ts), drawn in the chosen colour; nothing leaves this computer.
 */
export function SignaturePad({
  color: initialColor,
  onSave,
  onCancel,
}: {
  color: string;
  /** value: "sig:…" for a drawn signature or a data: URL for an image; color: ink colour chosen */
  onSave: (value: string, color: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLCanvasElement>(null);
  const [strokes, setStrokes] = useState<Point[][]>([]);
  const [color, setColor] = useState(/^#[0-9a-f]{6}$/i.test(initialColor) ? initialColor.toLowerCase() : INK_COLOURS[0].value);
  const current = useRef<Point[] | null>(null);
  const [, setTick] = useState(0);

  const redraw = useCallback(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    ctx.lineWidth = PEN;
    for (const s of current.current ? [...strokes, current.current] : strokes) {
      const d = strokePath(s);
      if (d) ctx.stroke(new Path2D(d));
    }
  }, [strokes, color]);

  useEffect(() => {
    redraw();
    const ro = new ResizeObserver(() => redraw());
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [redraw]);

  // pointer position in the canvas's own CSS pixels (correct even while the dialog is scaled by its opening animation)
  const pos = (e: React.PointerEvent): Point => {
    const c = ref.current!;
    const r = c.getBoundingClientRect();
    const sx = c.offsetWidth / r.width, sy = c.offsetHeight / r.height; // undo any CSS scaling
    return { x: (e.clientX - r.left) * sx - c.clientLeft, y: (e.clientY - r.top) * sy - c.clientTop };
  };

  const finish = () => {
    if (!current.current) return;
    const s = current.current;
    current.current = null;
    setStrokes((all) => [...all, s]);
  };

  const save = () => {
    const v = encodeInk(strokes, PEN);
    if (v) onSave(v, color);
  };

  const upload = async (file: File) => {
    if (!/^image\/(png|jpeg)$/.test(file.type)) return;
    const url = await new Promise<string>((res) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.readAsDataURL(file);
    });
    onSave(url, color);
  };

  const custom = !INK_COLOURS.some((c) => c.value === color);

  return (
    <Modal title={t('Signature')} onClose={onCancel}>
      <p className="muted">{t('Sign inside the box with your mouse, pen or finger.')}</p>
      <div className="sig-colours" role="radiogroup" aria-label={t('Ink colour')}>
        <span className="muted">{t('Ink colour')}</span>
        {INK_COLOURS.map((c) => (
          <button
            key={c.value}
            type="button"
            role="radio"
            aria-checked={color === c.value}
            aria-label={t(c.label)}
            title={t(c.label)}
            className={cx('swatch', color === c.value && 'on')}
            style={{ background: c.value }}
            onClick={() => setColor(c.value)}
          />
        ))}
        <label className={cx('swatch custom', custom && 'on')} title={t('Other colour…')} style={custom ? { background: color } : undefined}>
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label={t('Other colour…')} />
        </label>
      </div>
      <canvas
        ref={ref}
        className="sig-canvas"
        aria-label={t('Signature drawing area')}
        onPointerDown={(e) => {
          if (e.button !== 0 && e.pointerType === 'mouse') return;
          e.preventDefault();
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          current.current = [pos(e)];
          setTick((n) => n + 1);
          redraw();
        }}
        onPointerMove={(e) => {
          if (!current.current) return;
          const events = (e.nativeEvent as PointerEvent).getCoalescedEvents?.() ?? [];
          for (const ev of events.length ? events : [e.nativeEvent]) {
            const p = pos(ev as unknown as React.PointerEvent);
            const last = current.current[current.current.length - 1];
            if (Math.hypot(p.x - last.x, p.y - last.y) >= 0.6) current.current.push(p);
          }
          redraw();
        }}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
      />
      <div className="modal-actions">
        <label className="btn ghost">
          {t('Use an image…')}
          <input type="file" accept="image/png,image/jpeg" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </label>
        <span className="spacer" />
        <button className="btn" onClick={() => setStrokes((s) => s.slice(0, -1))} disabled={!strokes.length} title={t('Undo the last stroke')}>
          <Undo2 size={15} /> {t('Undo')}
        </button>
        <button className="btn" onClick={() => setStrokes([])} disabled={!strokes.length}>
          {t('Clear')}
        </button>
        <button className="btn primary" disabled={!strokes.length} onClick={save}>
          {t('Use signature')}
        </button>
      </div>
    </Modal>
  );
}
