import type { Field, FieldStyle, FieldType, Rect } from './types';

export function uid(prefix = 'f'): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    : Math.random().toString(36).slice(2, 14);
  return `${prefix}_${rnd}`;
}

export const DEFAULT_STYLE: FieldStyle = {
  fontFamily: 'dejavu-sans',
  fontSize: 0,
  color: '#0b2a6f',
  align: 'left',
  lineHeight: 1.15,
  border: false,
  borderColor: '#1f2937',
  borderWidth: 0.75,
  background: null,
  backgroundOpacity: 1,
  overflow: 'shrink',
  checkStyle: 'check',
  dateFormat: 'DD/MM/YYYY',
};

/** Default size (display points) for a field created with a single click. */
export function defaultSize(type: FieldType): { w: number; h: number } {
  switch (type) {
    case 'checkbox':
    case 'radio':
      return { w: 10, h: 10 };
    case 'multiline':
      return { w: 220, h: 60 };
    case 'signature':
      return { w: 160, h: 40 };
    case 'date':
      return { w: 90, h: 16 };
    case 'number':
      return { w: 70, h: 16 };
    case 'label':
      return { w: 140, h: 16 };
    default:
      return { w: 160, h: 16 };
  }
}

const TYPE_LABEL: Record<FieldType, string> = {
  text: 'Text',
  multiline: 'Long text',
  checkbox: 'Checkbox',
  radio: 'Option',
  date: 'Date',
  number: 'Number',
  dropdown: 'Dropdown',
  signature: 'Signature',
  label: 'Note',
};

export function typeLabel(t: FieldType) {
  return TYPE_LABEL[t];
}

export function createField(type: FieldType, page: number, rect: Rect, extra: Partial<Field> = {}): Field {
  const id = uid();
  const style: FieldStyle = {
    ...DEFAULT_STYLE,
    checkStyle: type === 'radio' ? 'dot' : 'check',
    ...(extra.style ?? {}),
  };
  return {
    id,
    type,
    page,
    rect,
    name: extra.name ?? `${TYPE_LABEL[type]} ${id.slice(-4)}`,
    group: extra.group ?? `Page ${page + 1}`,
    required: false,
    defaultValue: type === 'label' ? 'Note' : '',
    options: type === 'dropdown' ? ['Option 1', 'Option 2'] : [],
    radioGroup: type === 'radio' ? `group_${id.slice(-4)}` : '',
    radioValue: type === 'radio' ? 'Option' : '',
    source: 'manual',
    ...extra,
    style,
  };
}
