import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {T} from '../theme';
import {Lcd} from '../components/Lcd';
import {fadeIn} from '../components/Logo';

export const MakeMoney: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const line1 = spring({frame: frame - 4, fps, config: {damping: 14, stiffness: 150}});
  const line2 = spring({frame: frame - 14, fps, config: {damping: 14, stiffness: 150}});
  const lcdIn = spring({frame: frame - 42, fps, config: {damping: 15, stiffness: 120}});

  // dwells tick up; 1,000 dwells = $1.00 of earned ad value
  const dwells = Math.round(
    interpolate(frame, [50, 165], [0, 1247], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: (t) => 1 - Math.pow(1 - t, 3),
    }),
  );
  const dollars = (dwells / 1000).toFixed(2);

  return (
    <AbsoluteFill
      style={{
        background: T.bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div style={{textAlign: 'center'}}>
        <div
          style={{
            fontFamily: T.sans,
            fontWeight: 800,
            fontSize: 124,
            lineHeight: 1.05,
            letterSpacing: '-0.02em',
            color: T.ink,
          }}
        >
          <div
            style={{
              opacity: line1,
              transform: `translateY(${(1 - line1) * 50}px)`,
            }}
          >
            Make <span style={{color: T.accent}}>money</span>
          </div>
          <div
            style={{
              opacity: line2,
              transform: `translateY(${(1 - line2) * 50}px)`,
            }}
          >
            while you use AI.
          </div>
        </div>

        <div
          style={{
            marginTop: 70,
            opacity: lcdIn,
            transform: `translateY(${(1 - lcdIn) * 40}px) scale(${0.94 + lcdIn * 0.06})`,
          }}
        >
          <Lcd text={`$ ${dollars}`} />
          <div
            style={{
              marginTop: 26,
              fontFamily: T.mono,
              fontSize: 22,
              letterSpacing: '0.05em',
              color: T.gray,
              opacity: fadeIn(frame, 70),
            }}
          >
            {dwells.toLocaleString('en-US')} dwells · 1,000 dwells = $1.00
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
