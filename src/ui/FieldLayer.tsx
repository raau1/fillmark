import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { clampRectToPage } from '../core/coords';
import { defaultSize } from '../core/fieldFactory';
import { displayText, effectiveValue, isChecked, layoutText } from '../core/layout';
import { FONTS, type Measurer } from '../core/fonts';
import type { Field, FieldType, PageInfo, Rect, Values } from '../core/types';
import { FieldContent } from './FieldContent';
import { useT } from '../i18n';

export type Tool = 'select' | FieldType;
export type EditorMode = 'edit' | 'fill';

interface Props {
  page: number;
  info: PageInfo;
  scale: number;
  fields: Field[];
  values: Values;
  measurer: Measurer;
  mode: EditorMode;
  selection: string[];
  activeId: string | null;
  tool: Tool;
  highlightFields: boolean;
  overflowIds: Set<string>;
  snapRects?: Rect[];
  onSelect(ids: string[], how: 'replace' | 'toggle' | 'add'): void;
  onCreate(type: FieldType, page: number, rect: Rect): void;
  onTransform(changes: { id: string; rect: Rect }[], key: string): void;
  onActivate(field: Field): void;
  onHighlight(field: Field): void;
  onToggle(field: Field): void;
  onTextValue(field: Field, text: string): void;
}

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
type Handle = (typeof HANDLES)[number];

type Drag =
  | { kind: 'move'; sx: number; sy: number; started: boolean; originals: Map<string, Rect>; key: string }
  | { kind: 'resize'; sx: number; sy: number; handle: Handle; id: string; orig: Rect; key: string; square: boolean }
  | { kind: 'create'; x0: number; y0: number; x1: number; y1: number; type: FieldType }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number; additive: boolean };

const INLINE_TYPES = new Set<FieldType>(['text', 'multiline', 'number']);

export function FieldLayer(p: Props) {
  const t = useT();
  const layerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const selected = new Set(p.selection);
  const s = p.scale;

  const toLocal = (clientX: number, clientY: number) => {
    const r = layerRef.current!.getBoundingClientRect();
    return { x: (clientX - r.left) / s, y: (clientY - r.top) / s };
  };

  const setD = (d: Drag | null) => {
    dragRef.current = d;
    setDrag(d);
  };

  // global pointer tracking while dragging
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (d.kind === 'move') {
        const dx = (e.clientX - d.sx) / s;
        const dy = (e.clientY - d.sy) / s;
        if (!d.started && Math.hypot(dx * s, dy * s) < 3) return;
        d.started = true;
        const changes = [...d.originals].map(([id, r]) => ({ id, rect: clampRectToPage({ ...r, x: r.x + dx, y: r.y + dy }, p.info, 1) }));
        p.onTransform(changes, d.key);
      } else if (d.kind === 'resize') {
        const dx = (e.clientX - d.sx) / s;
        const dy = (e.clientY - d.sy) / s;
        const r = resizeRect(d.orig, d.handle, dx, dy, e.shiftKey || d.square);
        p.onTransform([{ id: d.id, rect: clampRectToPage(r, p.info, 2) }], d.key);
      } else {
        const l = toLocal(e.clientX, e.clientY);
        setD({ ...d, x1: l.x, y1: l.y });
      }
    };
    const up = (e: PointerEvent) => {
      const d = dragRef.current;
      setD(null);
      if (!d) return;
      if (d.kind === 'create') {
        const l = toLocal(e.clientX, e.clientY);
        const w = Math.abs(l.x - d.x0), h = Math.abs(l.y - d.y0);
        let rect: Rect;
        if (w * s < 4 && h * s < 4) rect = clickRect(d.type, d.x0, d.y0, p.snapRects);
        else rect = { x: Math.min(d.x0, l.x), y: Math.min(d.y0, l.y), w: Math.max(w, 3), h: Math.max(h, 3) };
        p.onCreate(d.type, p.page, clampRectToPage(rect, p.info, 2));
      } else if (d.kind === 'marquee') {
        const r = norm(d);
        if (r.w * s < 3 && r.h * s < 3) {
          if (!d.additive) p.onSelect([], 'replace');
          return;
        }
        const ids = p.fields.filter((f) => intersects(f.rect, r)).map((f) => f.id);
        p.onSelect(ids, d.additive ? 'add' : 'replace');
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.kind, s, p.info, p.page]);

  const onLayerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (p.mode !== 'edit' || e.button !== 0) return;
    if (e.target !== layerRef.current) return;
    e.preventDefault();
    const l = toLocal(e.clientX, e.clientY);
    if (p.tool !== 'select') setD({ kind: 'create', x0: l.x, y0: l.y, x1: l.x, y1: l.y, type: p.tool });
    else setD({ kind: 'marquee', x0: l.x, y0: l.y, x1: l.x, y1: l.y, additive: e.shiftKey || e.metaKey || e.ctrlKey });
  };

  const onFieldDown = (e: RPointerEvent, f: Field) => {
    if (p.mode !== 'edit' || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    let ids = p.selection;
    if (additive) {
      p.onSelect([f.id], 'toggle');
      return;
    }
    if (!selected.has(f.id)) {
      ids = [f.id];
      p.onSelect(ids, 'replace');
    }
    const originals = new Map<string, Rect>();
    for (const fl of p.fields) if (ids.includes(fl.id)) originals.set(fl.id, fl.rect);
    setD({ kind: 'move', sx: e.clientX, sy: e.clientY, started: false, originals, key: `move:${Date.now()}` });
  };

  const onHandleDown = (e: RPointerEvent, f: Field, handle: Handle) => {
    e.stopPropagation();
    e.preventDefault();
    setD({
      kind: 'resize',
      sx: e.clientX,
      sy: e.clientY,
      handle,
      id: f.id,
      orig: f.rect,
      key: `resize:${Date.now()}`,
      square: false,
    });
  };

  const showBoxes = p.mode === 'edit' || p.highlightFields;
  const rubber = drag && (drag.kind === 'create' || drag.kind === 'marquee') ? norm(drag) : null;
  const creating = p.mode === 'edit' && p.tool !== 'select';

  return (
    <div
      ref={layerRef}
      className={`field-layer mode-${p.mode}${creating ? ' creating' : ''}`}
      onPointerDown={onLayerDown}
      data-testid={`layer-${p.page}`}
    >
      <svg className="content-svg" viewBox={`0 0 ${p.info.width} ${p.info.height}`} preserveAspectRatio="none" aria-hidden="true">
        {p.fields.map((f) =>
          editingId === f.id ? null : (
            <FieldContent key={f.id} field={f} values={p.values} measurer={p.measurer} showPlaceholder={p.mode === 'edit'} />
          ),
        )}
      </svg>
      {p.fields.map((f) => {
        const isSel = selected.has(f.id);
        const isActive = p.activeId === f.id;
        const overflow = p.overflowIds.has(f.id);
        const cls = [
          'field-box',
          `t-${f.type}`,
          showBoxes ? 'outlined' : '',
          isSel ? 'selected' : '',
          isActive ? 'active' : '',
          f.source === 'detected' && !f.reviewed ? 'suggested' : '',
          overflow ? 'overflow' : '',
        ]
          .filter(Boolean)
          .join(' ');
        const toggle = f.type === 'checkbox' || f.type === 'radio';
        const checked = toggle && isChecked(f, p.values);
        const label = `${f.name}${f.required ? ' *' : ''}`;
        return (
          <div
            key={f.id}
            className={cls}
            data-field-id={f.id}
            style={{ left: f.rect.x * s, top: f.rect.y * s, width: f.rect.w * s, height: f.rect.h * s }}
            title={label}
            role={p.mode === 'fill' ? (toggle ? (f.type === 'radio' ? 'radio' : 'checkbox') : 'button') : undefined}
            aria-label={p.mode === 'fill' ? label : undefined}
            aria-checked={p.mode === 'fill' && toggle ? checked : undefined}
            tabIndex={p.mode === 'fill' ? 0 : -1}
            onPointerDown={(e) => onFieldDown(e, f)}
            onClick={(e) => {
              if (p.mode !== 'fill') return;
              e.stopPropagation();
              if (toggle) p.onToggle(f);
              else if (f.type !== 'label') p.onActivate(f);
            }}
            onDoubleClick={(e) => {
              if (p.mode === 'fill' && INLINE_TYPES.has(f.type)) {
                e.stopPropagation();
                setEditingId(f.id);
              }
            }}
            onFocus={() => p.mode === 'fill' && p.onHighlight(f)}
            onKeyDown={(e) => {
              if (p.mode !== 'fill') return;
              if (toggle && (e.key === ' ' || e.key === 'Enter')) {
                e.preventDefault();
                p.onToggle(f);
              } else if (!toggle && e.key === 'Enter') {
                e.preventDefault();
                if (INLINE_TYPES.has(f.type)) setEditingId(f.id);
                else p.onActivate(f);
              }
            }}
          >
            {overflow && <span className="overflow-badge" aria-label={t('Text does not fit')}>!</span>}
            {p.mode === 'edit' && isSel && p.selection.length === 1 &&
              HANDLES.map((h) => <span key={h} className={`handle h-${h}`} onPointerDown={(e) => onHandleDown(e, f, h)} />)}
          </div>
        );
      })}
      {editingId && (() => {
        const f = p.fields.find((x) => x.id === editingId);
        if (!f) return null;
        return <InlineEditor field={f} values={p.values} measurer={p.measurer} scale={s} onChange={(v) => p.onTextValue(f, v)} onClose={() => setEditingId(null)} />;
      })()}
      {rubber && (
        <div
          className={`rubber ${drag?.kind}`}
          style={{ left: rubber.x * s, top: rubber.y * s, width: rubber.w * s, height: rubber.h * s }}
        />
      )}
    </div>
  );
}

function InlineEditor({
  field,
  values,
  measurer,
  scale,
  onChange,
  onClose,
}: {
  field: Field;
  values: Values;
  measurer: Measurer;
  scale: number;
  onChange: (v: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const v = effectiveValue(field, values);
  const text = typeof v === 'string' ? v : '';
  const lay = layoutText(field, displayText(field, values) || 'Xg', measurer);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const multi = field.type === 'multiline';
  return (
    <textarea
      ref={ref}
      className="inline-editor"
      value={text}
      aria-label={field.name}
      spellCheck
      style={{
        left: field.rect.x * scale,
        top: field.rect.y * scale,
        width: Math.max(field.rect.w * scale, 60),
        height: Math.max(field.rect.h * scale, multi ? 40 : lay.fontSize * scale * 1.5),
        fontSize: lay.fontSize * scale,
        fontFamily: FONTS[lay.family].css,
        color: field.style.color,
        textAlign: field.style.align,
        lineHeight: multi ? field.style.lineHeight : undefined,
      }}
      onChange={(e) => onChange(multi ? e.target.value : e.target.value.replace(/\n/g, ' '))}
      onBlur={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape' || (e.key === 'Enter' && !multi)) {
          e.preventDefault();
          onClose();
        }
        e.stopPropagation();
      }}
    />
  );
}

function norm(d: { x0: number; y0: number; x1: number; y1: number }): Rect {
  return { x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) };
}

function intersects(a: Rect, b: Rect) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Rectangle for a single click: snap to a printed box under the cursor if there is one. */
export function clickRect(type: FieldType, x: number, y: number, snapRects?: Rect[]): Rect {
  const small = type === 'checkbox' || type === 'radio';
  if (snapRects?.length) {
    const hits = snapRects
      .filter((r) => x >= r.x - 1.5 && x <= r.x + r.w + 1.5 && y >= r.y - 1.5 && y <= r.y + r.h + 1.5)
      .filter((r) => (small ? Math.max(r.w, r.h) <= 30 : r.w > 30))
      .sort((a, b) => a.w * a.h - b.w * b.h);
    if (hits[0]) return { ...hits[0] };
  }
  const { w, h } = defaultSize(type);
  if (small) return { x: x - w / 2, y: y - h / 2, w, h };
  return { x, y: y - h / 2, w, h };
}

function resizeRect(o: Rect, h: Handle, dx: number, dy: number, square: boolean): Rect {
  let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
  if (h.includes('w')) x0 += dx;
  if (h.includes('e')) x1 += dx;
  if (h.includes('n')) y0 += dy;
  if (h.includes('s')) y1 += dy;
  const MIN = 3;
  if (x1 - x0 < MIN) h.includes('w') ? (x0 = x1 - MIN) : (x1 = x0 + MIN);
  if (y1 - y0 < MIN) h.includes('n') ? (y0 = y1 - MIN) : (y1 = y0 + MIN);
  if (square) {
    const side = Math.max(x1 - x0, y1 - y0);
    if (h.includes('w')) x0 = x1 - side;
    else x1 = x0 + side;
    if (h.includes('n')) y0 = y1 - side;
    else y1 = y0 + side;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
