import type { InkSignature } from '../core/signature';

/** The strokes of a drawn signature, as SVG paths in the signature's own units. */
export function InkPaths({ sig, color }: { sig: InkSignature; color: string }) {
  return (
    <g className="sig-ink" fill="none" stroke={color} strokeWidth={sig.lw} strokeLinecap="round" strokeLinejoin="round">
      {sig.d.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </g>
  );
}
