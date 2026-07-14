import React from 'react';
import {T} from '../theme';

/**
 * The green-on-black seven-segment tally counter from the lander
 * (JDM11-6H style). Ghost "8"s glow faintly behind the lit digits.
 */
export const Lcd: React.FC<{text: string; scale?: number}> = ({
  text,
  scale = 1,
}) => {
  const s = scale;
  const digit: React.CSSProperties = {
    fontFamily: T.mono,
    fontWeight: 600,
    fontSize: 76 * s,
    lineHeight: 1,
    letterSpacing: '0.12em',
    whiteSpace: 'pre',
  };
  return (
    <div
      style={{
        display: 'inline-block',
        padding: 10 * s,
        borderRadius: 14 * s,
        background: `linear-gradient(180deg, ${T.lcdBezelA}, ${T.lcdBezelB})`,
        boxShadow: '0 14px 40px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.12)',
      }}
    >
      <div
        style={{
          position: 'relative',
          padding: `${18 * s}px ${28 * s}px`,
          borderRadius: 8 * s,
          background: T.lcdScreen,
          boxShadow: 'inset 0 2px 12px rgba(0,0,0,0.9)',
        }}
      >
        <div style={{...digit, color: T.lcdOff}}>
          {text.replace(/[0-9]/g, '8')}
        </div>
        <div
          style={{
            ...digit,
            position: 'absolute',
            top: 18 * s,
            left: 28 * s,
            color: T.lcdOn,
            textShadow: `0 0 ${18 * s}px ${T.lcdGlow}`,
          }}
        >
          {text}
        </div>
      </div>
    </div>
  );
};
