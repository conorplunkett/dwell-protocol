import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {T} from '../theme';
import {Logo, fadeIn} from '../components/Logo';

export const Cta: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const wordIn = spring({frame: frame - 30, fps, config: {damping: 14, stiffness: 130}});
  const btnIn = spring({frame: frame - 78, fps, config: {damping: 13, stiffness: 140}});
  // gentle breathing pulse on the button once it has landed
  const pulse = 1 + Math.sin(Math.max(0, frame - 100) / 11) * 0.02;

  return (
    <AbsoluteFill
      style={{
        background: T.bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div style={{textAlign: 'center'}}>
        <div style={{display: 'flex', justifyContent: 'center'}}>
          <Logo size={190} animateFrom={4} />
        </div>

        <div
          style={{
            marginTop: 36,
            fontFamily: T.sans,
            fontWeight: 800,
            fontSize: 110,
            letterSpacing: '-0.02em',
            color: T.ink,
            opacity: wordIn,
            transform: `translateY(${(1 - wordIn) * 40}px)`,
          }}
        >
          DWELL
        </div>

        <div
          style={{
            marginTop: 8,
            fontFamily: T.sans,
            fontWeight: 400,
            fontSize: 38,
            color: T.gray,
            opacity: fadeIn(frame, 52),
          }}
        >
          Get paid for your attention.
        </div>

        <div
          style={{
            marginTop: 56,
            display: 'inline-block',
            fontFamily: T.sans,
            fontWeight: 700,
            fontSize: 36,
            color: T.accentInk,
            background: T.accent,
            padding: '24px 64px',
            borderRadius: 10,
            boxShadow: '0 16px 50px rgba(255,0,0,0.3)',
            opacity: btnIn,
            transform: `scale(${(0.8 + btnIn * 0.2) * pulse})`,
          }}
        >
          Start earning
        </div>

        <div
          style={{
            marginTop: 34,
            fontFamily: T.mono,
            fontWeight: 600,
            fontSize: 30,
            letterSpacing: '0.04em',
            color: T.ink2,
            opacity: fadeIn(frame, 100),
          }}
        >
          dwellprotocol.com
        </div>

        <div
          style={{
            marginTop: 16,
            fontFamily: T.sans,
            fontSize: 22,
            color: T.gray2,
            opacity: fadeIn(frame, 116),
          }}
        >
          Free — Chrome extension · Terminal · macOS
        </div>
      </div>
    </AbsoluteFill>
  );
};
