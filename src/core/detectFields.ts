import { createField } from './fieldFactory';
import { choiceRows, clusterColumns, iou, labelForBox, labelRightOf, type Detected, type TextItem } from './detect';
import type { Field, FieldType, Rect } from './types';

/** Localised names used when the page has no readable text for labels. */
export interface Naming {
  page(n: number): string; // "Page 3"
  list(page: number, n: number): string; // "Page 3, list 2"
  checkbox(n: number): string;
  textBox(n: number): string;
  longText(n: number): string;
  choice(n: number): string;
  option(n: number): string;
}

export interface BuildOptions {
  choiceGroups: boolean;
  existing: Field[];
  naming: Naming;
  /** running counters across pages so generic names stay unique */
  counters?: Record<string, number>;
}

const TYPE: Record<Detected['kind'], FieldType> = { checkbox: 'checkbox', radio: 'radio', box: 'text', multibox: 'multiline', line: 'text' };

/** Heading text just above a list (within 30 pt), roughly aligned with it. */
function headingAbove(first: Rect, items: TextItem[], exclude: Set<TextItem>): string {
  const cands = items
    .filter((t) => !exclude.has(t) && t.rect.y + t.rect.h <= first.y + 0.5 && first.y - (t.rect.y + t.rect.h) < 30)
    .filter((t) => t.rect.x > first.x - 25 && t.rect.x < first.x + 260)
    .sort((a, b) => b.rect.y - a.rect.y);
  if (!cands.length) return '';
  const y = cands[0].rect.y;
  return cands
    .filter((t) => Math.abs(t.rect.y - y) < 3)
    .sort((a, b) => a.rect.x - b.rect.x)
    .map((t) => t.str)
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/[:\s]+$/, '')
    .trim()
    .slice(0, 80);
}

export function buildFieldsFromDetections(page: number, detected: Detected[], text: TextItem[], opts: BuildOptions): Field[] {
  const counters = opts.counters ?? {};
  const next = (k: string) => (counters[k] = (counters[k] ?? 0) + 1);
  const N = opts.naming;
  const onPage = opts.existing.filter((f) => f.page === page);
  const fresh = detected.filter((d) => !onPage.some((f) => iou(f.rect, d.rect) > 0.4));
  if (!fresh.length) return [];

  const usedText = new Set<TextItem>();
  const toggles = fresh.filter((d) => d.kind === 'checkbox' || d.kind === 'radio');
  const others = fresh.filter((d) => !(d.kind === 'checkbox' || d.kind === 'radio'));

  // labels for each toggle
  const toggleRects = toggles.map((t) => t.rect);
  const toggleLabels = toggles.map((t) => labelRightOf(t.rect, text, toggleRects));
  for (const tl of toggleLabels) if (tl) for (const it of text) if (tl.includes(it.str.trim()) && it.str.trim()) usedText.add(it);

  // choice rows (Sí / No, H / M …) become one-choice groups
  const rows = opts.choiceGroups ? choiceRows(toggles) : [];
  const inRow = new Map<number, number>();
  rows.forEach((r, ri) => r.forEach((i) => inRow.set(i, ri)));

  // lists = columns of toggles not in a choice row
  const listIdx = toggles.map((_, i) => i).filter((i) => !inRow.has(i));
  const listItems = listIdx.map((i) => toggles[i]);
  const listGroupOf = clusterColumns(listItems, 40);
  const groups = new Map<number, { name: string; rects: Rect[] }>();
  const nameCount = new Map<string, number>();
  const uniq = (name: string) => {
    const n = (nameCount.get(name) ?? 0) + 1;
    nameCount.set(name, n);
    return n === 1 ? name : `${name} (${n})`;
  };
  let listNo = 0;
  const groupIds = [...new Set(listGroupOf)].sort((a, b) => {
    const ra = listItems[listGroupOf.indexOf(a)].rect, rb = listItems[listGroupOf.indexOf(b)].rect;
    return ra.y - rb.y || ra.x - rb.x;
  });
  for (const g of groupIds) {
    const rects = listItems.filter((_, k) => listGroupOf[k] === g).map((d) => d.rect).sort((a, b) => a.y - b.y);
    const heading = headingAbove(rects[0], text, usedText);
    const base = heading ? `${heading}, ${N.page(page + 1).toLowerCase()}` : N.list(page + 1, ++listNo);
    groups.set(g, { name: uniq(base), rects });
  }

  /** the list directly above a rect and overlapping it horizontally (notes box under a checklist, Sí/No row under it) */
  const groupAbove = (r: Rect) => {
    let best: { g: { name: string; rects: Rect[] }; gap: number } | null = null;
    for (const g of groups.values()) {
      const bottom = Math.max(...g.rects.map((x) => x.y + x.h));
      const minX = Math.min(...g.rects.map((x) => x.x)) - 20;
      const maxX = Math.max(...g.rects.map((x) => x.x + x.w)) + 40;
      const gap = r.y - bottom;
      if (gap < -1 || gap > 100) continue; // allow a footnote between a list and its Sí/No row
      if (r.x + r.w < minX || r.x > maxX) continue;
      if (!best || gap < best.gap) best = { g, gap };
    }
    return best?.g ?? null;
  };

  const pageGroup = N.page(page + 1);
  const fields: Field[] = [];
  const mk = (d: Detected, type: FieldType, extra: Partial<Field>) => {
    const f = createField(type, page, { ...d.rect }, { source: 'detected', reviewed: false, confidence: d.confidence, ...extra });
    if (type === 'checkbox' || type === 'radio') f.style.checkStyle = 'check';
    fields.push(f);
    return f;
  };

  // list items
  listIdx.forEach((ti, k) => {
    const d = toggles[ti];
    const label = toggleLabels[ti];
    mk(d, TYPE[d.kind] === 'radio' ? 'radio' : 'checkbox', {
      name: label.length > 1 ? label : N.checkbox(next('checkbox')),
      group: groups.get(listGroupOf[k])!.name,
      ...(d.kind === 'radio' ? { radioGroup: `radio_p${page}_${listGroupOf[k]}`, radioValue: label || N.option(k + 1) } : {}),
    });
  });

  // text boxes and lines (a notes box right under a list joins that list)
  for (const d of others.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)) {
    const type = TYPE[d.kind];
    const label = labelForBox(d.rect, text, usedText);
    const g = groupAbove(d.rect);
    if (g) g.rects.push(d.rect);
    mk(d, type, {
      name: label.length > 1 ? label : type === 'multiline' ? N.longText(next('long')) : N.textBox(next('text')),
      group: g?.name ?? pageGroup,
    });
  }

  // choice rows (Sí / No under a list belong to that list)
  rows.forEach((row) => {
    const first = toggles[row[0]].rect;
    const q = labelForBox(first, text, usedText);
    const question = q.length > 1 ? q : N.choice(next('choice'));
    const gid = `choice_p${page}_${Math.round(first.y)}_${Math.round(first.x)}`;
    const group = groupAbove(first)?.name ?? pageGroup;
    row.forEach((ti, oi) => {
      const value = toggleLabels[ti].split(/\s*\/\s*/)[0].trim() || N.option(oi + 1);
      mk(toggles[ti], 'radio', { name: `${question}: ${value}`, group, radioGroup: gid, radioValue: value });
    });
  });

  return fields;
}
