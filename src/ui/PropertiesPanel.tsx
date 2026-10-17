import { useId, useState, type ReactNode } from 'react';
import { Copy, ScanSearch, Trash2, MousePointerClick, Link2 } from 'lucide-react';
import { FONT_LIST } from '../core/fonts';
import { typeLabel } from '../core/fieldFactory';
import { isTextType } from '../core/layout';
import { FIELD_TYPES, type CheckStyle, type DateFormat, type Field, type FieldType, type PageInfo, type Values } from '../core/types';
import { useT } from '../i18n';
import type { FieldPatch } from './Editor';
import { cx } from './util';

interface Props {
  fields: Field[];
  allFields: Field[];
  values: Values;
  pages: PageInfo[];
  formFieldCount: number;
  onImportDetect(): void;
  onChange(ids: string[], patch: FieldPatch, key: string): void;
  onRename(id: string, name: string): void;
  onDelete(): void;
  onDuplicate(): void;
}

const DATE_FORMATS: DateFormat[] = ['DD/MM/YYYY', 'DD-MM-YYYY', 'DD.MM.YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'];
const CHECK_STYLES: CheckStyle[] = ['check', 'cross', 'fill', 'dot'];

export function PropertiesPanel(p: Props) {
  const t = useT();
  const groupsListId = useId();
  const groups = Array.from(new Set(p.allFields.map((f) => f.group).filter(Boolean)));

  if (!p.fields.length) {
    return (
      <div className="panel-pad empty-panel">
        <MousePointerClick size={28} className="empty-icon" />
        <h2>{t('No field selected')}</h2>
        <p>{t('Pick a field type in the toolbar above the page, then click where the answer goes. Click a field to change its settings here.')}</p>
        <button className="btn primary block" onClick={p.onImportDetect}>
          <ScanSearch size={16} /> {t('Detect fields automatically')}
        </button>
        {p.formFieldCount > 0 && (
          <p className="note">{t('This PDF already contains {n} interactive fields. You can import them from “Detect fields”.', { n: p.formFieldCount })}</p>
        )}
        <dl className="shortcuts">
          <dt>Del</dt>
          <dd>{t('Delete selected')}</dd>
          <dt>↑ ↓ ← →</dt>
          <dd>{t('Nudge 1 pt (Shift: 10 pt)')}</dd>
          <dt>Ctrl+D</dt>
          <dd>{t('Duplicate below')}</dd>
          <dt>Ctrl+C / V</dt>
          <dd>{t('Copy / paste to current page')}</dd>
          <dt>Ctrl+Z</dt>
          <dd>{t('Undo')}</dd>
        </dl>
      </div>
    );
  }

  const ids = p.fields.map((f) => f.id);
  const f0 = p.fields[0];
  const single = p.fields.length === 1;
  const same = <K extends keyof Field['style']>(k: K) => (p.fields.every((f) => f.style[k] === f0.style[k]) ? f0.style[k] : undefined);
  const setStyle = (patch: Partial<Field['style']>, k: string) => p.onChange(ids, { style: patch }, `style:${ids.join(',')}:${k}`);
  const set = (patch: FieldPatch, k: string) => p.onChange(ids, patch, `prop:${ids.join(',')}:${k}`);
  const anyText = p.fields.some((f) => isTextType(f.type));
  const anyToggle = p.fields.some((f) => f.type === 'checkbox' || f.type === 'radio');
  const allToggle = p.fields.every((f) => f.type === 'checkbox' || f.type === 'radio');

  return (
    <div className="panel-scroll">
      <div className="panel-head">
        <h2>{single ? t(typeLabel(f0.type)) : t('{n} fields selected', { n: p.fields.length })}</h2>
        {single && f0.source === 'detected' && !f0.reviewed && (
          <button className="chip warn" onClick={() => set({ reviewed: true }, 'reviewed')}>
            {t('Suggested — mark as checked')}
          </button>
        )}
      </div>

      <Section title={t('Field')}>
        {single && (
          <Row label={t('Label')}>
            {(id) => <input id={id} value={f0.name} onChange={(e) => p.onRename(f0.id, e.target.value)} />}
          </Row>
        )}
        <Row label={t('Section')} hint={t('Fields with the same section are listed together in Fill mode.')}>
          {(id) => (
            <>
              <input id={id} list={groupsListId} value={p.fields.every((f) => f.group === f0.group) ? f0.group : ''} placeholder={t('(mixed)')} onChange={(e) => set({ group: e.target.value }, 'group')} />
              <datalist id={groupsListId}>
                {groups.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </>
          )}
        </Row>
        {single && (
          <Row label={t('Type')}>
            {(id) => (
              <select id={id} value={f0.type} onChange={(e) => set(convertType(f0, e.target.value as FieldType), 'type')}>
                {FIELD_TYPES.map((ty) => (
                  <option key={ty} value={ty}>
                    {t(typeLabel(ty))}
                  </option>
                ))}
              </select>
            )}
          </Row>
        )}
        {single && (
          <div className="grid4">
            {(['x', 'y', 'w', 'h'] as const).map((k) => (
              <label key={k} className="mini">
                <span>{k === 'w' ? t('W') : k === 'h' ? t('H') : k.toUpperCase()}</span>
                <NumberField
                  value={round(f0.rect[k])}
                  step={0.5}
                  min={k === 'w' || k === 'h' ? 2 : 0}
                  onCommit={(v) => set({ rect: { ...f0.rect, [k]: v } }, `rect.${k}`)}
                />
              </label>
            ))}
            <span className="unit-note">{t('Points (1/72 in), page {n}', { n: f0.page + 1 })}</span>
          </div>
        )}
      </Section>

      {anyText && (
        <Section title={t('Text')}>
          <Row label={t('Font')}>
            {(id) => (
              <select id={id} value={same('fontFamily') ?? ''} onChange={(e) => setStyle({ fontFamily: e.target.value as Field['style']['fontFamily'] }, 'font')}>
                {same('fontFamily') === undefined && <option value="">{t('(mixed)')}</option>}
                {FONT_LIST.map((fd) => (
                  <option key={fd.id} value={fd.id}>
                    {fd.label}
                  </option>
                ))}
              </select>
            )}
          </Row>
          <Row label={t('Size')}>
            {(id) => (
              <div className="inline">
                <label className="check">
                  <input type="checkbox" checked={same('fontSize') === 0} onChange={(e) => setStyle({ fontSize: e.target.checked ? 0 : 10 }, 'size-auto')} />
                  {t('Automatic')}
                </label>
                <NumberField
                  id={id}
                  min={4}
                  max={72}
                  step={0.5}
                  disabled={same('fontSize') === 0}
                  value={same('fontSize') || undefined}
                  placeholder={same('fontSize') === 0 ? t('auto') : ''}
                  onCommit={(v) => setStyle({ fontSize: v }, 'size')}
                  className="num"
                />
                <span className="muted">pt</span>
              </div>
            )}
          </Row>
          <Row label={t('Alignment')}>
            {() => (
              <Segmented
                value={same('align')}
                options={[
                  ['left', t('Left')],
                  ['center', t('Centre')],
                  ['right', t('Right')],
                ]}
                onChange={(v) => setStyle({ align: v as Field['style']['align'] }, 'align')}
              />
            )}
          </Row>
          {p.fields.some((f) => f.type === 'multiline' || f.type === 'label') && (
            <Row label={t('Line spacing')}>
              {(id) => (
                <NumberField id={id} min={0.8} max={3} step={0.05} value={same('lineHeight')} onCommit={(v) => setStyle({ lineHeight: v }, 'lh')} className="num" />
              )}
            </Row>
          )}
          <Row label={t('If the text does not fit')}>
            {() => (
              <Segmented
                value={same('overflow')}
                options={[
                  ['shrink', t('Shrink text')],
                  ['fixed', t('Keep size')],
                ]}
                onChange={(v) => setStyle({ overflow: v as Field['style']['overflow'] }, 'overflow')}
              />
            )}
          </Row>
          {p.fields.some((f) => f.type === 'date') && (
            <Row label={t('Date format')}>
              {(id) => (
                <select id={id} value={same('dateFormat') ?? ''} onChange={(e) => setStyle({ dateFormat: e.target.value as DateFormat }, 'datefmt')}>
                  {DATE_FORMATS.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              )}
            </Row>
          )}
        </Section>
      )}

      {anyToggle && (
        <Section title={t('Mark')}>
          <Row label={t('Mark style')}>
            {() => (
              <Segmented
                value={same('checkStyle')}
                options={CHECK_STYLES.map((c) => [c, { check: '✓', cross: '✕', fill: '■', dot: '●' }[c]] as [string, string])}
                onChange={(v) => setStyle({ checkStyle: v as CheckStyle }, 'mark')}
                labels={CHECK_STYLES.map((c) => t({ check: 'Tick', cross: 'Cross', fill: 'Filled square', dot: 'Dot' }[c]))}
              />
            )}
          </Row>
          {single && f0.type === 'radio' && (
            <>
              <Row label={t('Option group')} hint={t('Only one option in the same group can be chosen.')}>
                {(id) => <input id={id} value={f0.radioGroup} onChange={(e) => set({ radioGroup: e.target.value }, 'rg')} />}
              </Row>
              <Row label={t('Value of this option')}>
                {(id) => <input id={id} value={f0.radioValue} onChange={(e) => set({ radioValue: e.target.value }, 'rv')} />}
              </Row>
            </>
          )}
          {allToggle && p.fields.length > 1 && (
            <button
              className="btn block"
              onClick={() => {
                const group = `group_${Date.now().toString(36)}`;
                p.fields.forEach((f, i) =>
                  p.onChange([f.id], { type: 'radio', radioGroup: group, radioValue: f.radioValue || f.name || `${i + 1}`, style: { checkStyle: f.style.checkStyle } }, `mkradio:${group}`),
                );
              }}
            >
              <Link2 size={15} /> {t('Make these one choice (only one can be ticked)')}
            </button>
          )}
        </Section>
      )}

      <Section title={t('Appearance')}>
        <Row label={t('Colour')}>
          {(id) => <input id={id} type="color" value={same('color') ?? '#000000'} onChange={(e) => setStyle({ color: e.target.value }, 'color')} />}
        </Row>
        <Row label={t('Border')}>
          {(id) => (
            <div className="inline">
              <label className="check">
                <input id={id} type="checkbox" checked={same('border') === true} onChange={(e) => setStyle({ border: e.target.checked }, 'border')} />
                {t('Draw a border')}
              </label>
              {same('border') && (
                <>
                  <input type="color" value={same('borderColor') ?? '#000000'} onChange={(e) => setStyle({ borderColor: e.target.value }, 'bc')} aria-label={t('Border colour')} />
                  <NumberField className="num" min={0.25} max={6} step={0.25} value={same('borderWidth')} onCommit={(v) => setStyle({ borderWidth: v }, 'bw')} ariaLabel={t('Border width')} />
                </>
              )}
            </div>
          )}
        </Row>
        <Row label={t('Background')} hint={t('Leave transparent to keep the original page visible.')}>
          {(id) => (
            <div className="inline">
              <label className="check">
                <input id={id} type="checkbox" checked={same('background') != null} onChange={(e) => setStyle({ background: e.target.checked ? '#ffffff' : null }, 'bg')} />
                {t('Fill')}
              </label>
              {same('background') != null && (
                <>
                  <input type="color" value={same('background') ?? '#ffffff'} onChange={(e) => setStyle({ background: e.target.value }, 'bgc')} aria-label={t('Background colour')} />
                  <input type="range" min={0.1} max={1} step={0.05} value={same('backgroundOpacity') ?? 1} onChange={(e) => setStyle({ backgroundOpacity: Number(e.target.value) }, 'bgo')} aria-label={t('Opacity')} />
                </>
              )}
            </div>
          )}
        </Row>
      </Section>

      <Section title={t('Behaviour')}>
        <label className="check">
          <input type="checkbox" checked={p.fields.every((f) => f.required)} onChange={(e) => set({ required: e.target.checked }, 'req')} />
          {t('Required (warn before export if empty)')}
        </label>
        {single && f0.type === 'dropdown' && (
          <Row label={t('Options (one per line)')}>
            {(id) => (
              <textarea id={id} rows={4} value={f0.options.join('\n')} onChange={(e) => set({ options: e.target.value.split('\n') }, 'options')} />
            )}
          </Row>
        )}
        {single && f0.type === 'label' && (
          <Row label={t('Text printed on the page')}>
            {(id) => <textarea id={id} rows={3} value={f0.defaultValue} onChange={(e) => set({ defaultValue: e.target.value }, 'note')} />}
          </Row>
        )}
        {single && (f0.type === 'checkbox' || f0.type === 'radio') && (
          <label className="check">
            <input type="checkbox" checked={f0.defaultValue === 'true'} onChange={(e) => set({ defaultValue: e.target.checked ? 'true' : '' }, 'def')} />
            {t('Ticked by default')}
          </label>
        )}
        {single && ['text', 'multiline', 'number', 'date', 'dropdown'].includes(f0.type) && (
          <Row label={t('Default value')}>
            {(id) => <input id={id} type={f0.type === 'date' ? 'date' : 'text'} value={f0.defaultValue} onChange={(e) => set({ defaultValue: e.target.value }, 'def')} />}
          </Row>
        )}
      </Section>

      <div className="panel-actions">
        <button className="btn" onClick={p.onDuplicate}>
          <Copy size={15} /> {t('Duplicate')}
        </button>
        <button className="btn danger" onClick={p.onDelete}>
          <Trash2 size={15} /> {t('Delete')}
        </button>
      </div>
    </div>
  );
}

function convertType(f: Field, type: FieldType): FieldPatch {
  const patch: FieldPatch = { type };
  if (type === 'radio' && !f.radioGroup) {
    patch.radioGroup = `group_${f.id.slice(-4)}`;
    patch.radioValue = f.name || 'Option';
    patch.style = { checkStyle: 'dot' };
  }
  if (type === 'checkbox') patch.style = { checkStyle: 'check' };
  if (type === 'dropdown' && !f.options.length) patch.options = ['Option 1', 'Option 2'];
  return patch;
}

function round(n: number) {
  return Math.round(n * 100) / 100;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="prop-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="prop-row">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

export function Segmented({
  value,
  options,
  onChange,
  labels,
}: {
  value: string | undefined;
  options: [string, string][];
  onChange: (v: string) => void;
  labels?: string[];
}) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map(([v, l], i) => (
        <button
          key={v}
          role="radio"
          aria-checked={value === v}
          aria-label={labels?.[i]}
          title={labels?.[i]}
          className={cx('seg', value === v && 'on')}
          onClick={() => onChange(v)}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

/**
 * Number input that only commits values inside [min, max] and never rewrites
 * what the user is typing (so "18" can be typed even though "1" is below the minimum).
 */
function NumberField({
  value,
  onCommit,
  min = -Infinity,
  max = Infinity,
  step,
  id,
  className,
  disabled,
  placeholder,
  ariaLabel,
}: {
  value: number | undefined;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  id?: string;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === undefined ? '' : String(value));
  return (
    <input
      id={id}
      type="number"
      inputMode="decimal"
      className={className}
      step={step}
      min={Number.isFinite(min) ? min : undefined}
      max={Number.isFinite(max) ? max : undefined}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={ariaLabel}
      value={shown}
      onFocus={() => setDraft(value === undefined ? '' : String(value))}
      onBlur={() => setDraft(null)}
      onChange={(e) => {
        setDraft(e.target.value);
        const v = Number(e.target.value.replace(',', '.'));
        if (e.target.value.trim() !== '' && Number.isFinite(v) && v >= min && v <= max) onCommit(v);
      }}
    />
  );
}
