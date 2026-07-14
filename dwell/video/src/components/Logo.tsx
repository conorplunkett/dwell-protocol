import React from 'react';
import {interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {T} from '../theme';

// The DWELL mark: eight dots on the clock face swept clockwise from a solid
// red at 12 o'clock through fading opacity. Mirrors web/assets/logo.svg.
const DOTS: Array<{cx: number; cy: number; o: number}> = [
  {cx: 100, cy: 35, o: 1},
  {cx: 145.96, cy: 54.04, o: 0.08},
  {cx: 165, cy: 100, o: 0.22},
  {cx: 145.96, cy: 145.96, o: 0.38},
  {cx: 100, cy: 165, o: 0.55},
  {cx: 54.04, cy: 145.96, o: 0.72},
  {cx: 35, cy: 100, o: 0.88},
  {cx: 54.04, cy: 54.04, o: 0.95},
];

export const Logo: React.FC<{
  size: number;
  /** frame at which the sweep-in starts; omit for a static mark */
  animateFrom?: number;
}> = ({size, animateFrom}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  return (
    <svg width={size} height={size} viewBox="0 0 200 200">
      {DOTS.map((d, i) => {
        let scale = 1;
        if (animateFrom !== undefined) {
          // Dots pop in clockwise starting from 12 o'clock.
          scale = spring({
            frame: frame - animateFrom - i * 3,
            fps,
            config: {damping: 12, stiffness: 180},
          });
        }
        return (
          <circle
            key={i}
            cx={d.cx}
            cy={d.cy}
            r={15 * scale}
            fill={T.accent}
            fillOpacity={d.o}
          />
        );
      })}
    </svg>
  );
};

/** Small lockup: mark + DWELL wordmark, used as a corner watermark. */
export const Lockup: React.FC<{height?: number; opacity?: number}> = ({
  height = 36,
  opacity = 1,
}) => (
  <div style={{display: 'flex', alignItems: 'center', gap: height * 0.35, opacity}}>
    <Logo size={height} />
    <div
      style={{
        fontFamily: T.sans,
        fontWeight: 800,
        fontSize: height * 0.72,
        letterSpacing: '-0.02em',
        color: T.ink,
      }}
    >
      DWELL
    </div>
  </div>
);

export const fadeIn = (
  frame: number,
  from: number,
  duration = 12,
): number =>
  interpolate(frame, [from, from + duration], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
