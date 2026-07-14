import React from 'react';

/** macOS-style arrow pointer with the white outline. */
export const Cursor: React.FC<{
  x: number;
  y: number;
  scale?: number;
  /** 0..1 press amount — scales the cursor down slightly on click */
  press?: number;
}> = ({x, y, scale = 1, press = 0}) => (
  <div
    style={{
      position: 'absolute',
      left: x,
      top: y,
      transform: `scale(${scale * (1 - press * 0.18)})`,
      transformOrigin: 'top left',
      filter: 'drop-shadow(0 3px 8px rgba(0,0,0,0.35))',
      zIndex: 50,
    }}
  >
    <svg width={44} height={60} viewBox="0 0 28 38">
      <path
        d="M4 2 L4 30 L11 23.5 L15.5 34 L20.5 32 L16 21.5 L25 21 Z"
        fill="#0f0f0f"
        stroke="#ffffff"
        strokeWidth={2.2}
        strokeLinejoin="round"
      />
    </svg>
  </div>
);

/** Expanding click ripple ring. progress 0..1 */
export const ClickRipple: React.FC<{
  x: number;
  y: number;
  progress: number;
}> = ({x, y, progress}) => {
  if (progress <= 0 || progress >= 1) return null;
  const r = 14 + progress * 46;
  return (
    <div
      style={{
        position: 'absolute',
        left: x - r,
        top: y - r,
        width: r * 2,
        height: r * 2,
        borderRadius: 999,
        border: `${3 * (1 - progress)}px solid rgba(255,0,0,${0.7 * (1 - progress)})`,
        zIndex: 49,
      }}
    />
  );
};
