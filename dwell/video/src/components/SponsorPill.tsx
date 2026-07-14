import React from 'react';
import {T} from '../theme';

/**
 * The DWELL sponsor bar — the dark pill shown while an assistant is thinking.
 * Styling mirrors the --ov-* block in web/theme.css.
 */
export const SponsorPill: React.FC<{
  chip: string;
  line: string;
  tag?: string;
  scale?: number;
  hovered?: boolean;
  style?: React.CSSProperties;
}> = ({chip, line, tag = 'Sponsored', scale = 1, hovered = false, style}) => {
  const s = scale;
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 14 * s,
        padding: `${12 * s}px ${22 * s}px ${12 * s}px ${12 * s}px`,
        borderRadius: 999,
        background: hovered ? T.ovBarBgHover : T.ovBarBg,
        border: `1px solid ${hovered ? 'rgba(255,255,255,0.18)' : T.ovBarBorder}`,
        boxShadow: hovered
          ? '0 12px 40px rgba(0,0,0,0.35)'
          : '0 8px 30px rgba(0,0,0,0.25)',
        ...style,
      }}
    >
      <div
        style={{
          width: 40 * s,
          height: 40 * s,
          borderRadius: 999,
          background: T.ovChipBg,
          color: T.ovChipInk,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: T.sans,
          fontWeight: 800,
          fontSize: 20 * s,
          flexShrink: 0,
        }}
      >
        {chip}
      </div>
      <div
        style={{
          fontFamily: T.sans,
          fontWeight: 600,
          fontSize: 21 * s,
          color: T.ovLine,
          whiteSpace: 'nowrap',
        }}
      >
        {line}
      </div>
      <div
        style={{
          fontFamily: T.mono,
          fontWeight: 600,
          fontSize: 13 * s,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          color: T.ovTagText,
          background: T.ovTagBg,
          padding: `${5 * s}px ${10 * s}px`,
          borderRadius: 999,
          whiteSpace: 'nowrap',
        }}
      >
        {tag}
      </div>
    </div>
  );
};
