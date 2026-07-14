import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {T} from '../theme';
import {Lockup, fadeIn} from '../components/Logo';
import {SponsorPill} from '../components/SponsorPill';

const ThinkingDots: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <div style={{display: 'flex', gap: 10, alignItems: 'center'}}>
      {[0, 1, 2].map((i) => {
        const t = (frame - i * 5) % 30;
        const up = interpolate(t, [0, 8, 16], [0, -8, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
        return (
          <div
            key={i}
            style={{
              width: 12,
              height: 12,
              borderRadius: 999,
              background: T.gray2,
              transform: `translateY(${up}px)`,
            }}
          />
        );
      })}
    </div>
  );
};

export const Hook: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const cardIn = spring({frame, fps, config: {damping: 16, stiffness: 120}});
  const bubbleIn = spring({
    frame: frame - 14,
    fps,
    config: {damping: 13, stiffness: 180},
  });
  const pillIn = spring({
    frame: frame - 85,
    fps,
    config: {damping: 14, stiffness: 130},
  });

  return (
    <AbsoluteFill style={{background: T.bg}}>
      <div style={{position: 'absolute', top: 48, left: 64}}>
        <Lockup height={40} opacity={fadeIn(frame, 0)} />
      </div>

      {/* Left: setup copy */}
      <div
        style={{
          position: 'absolute',
          left: 110,
          top: 330,
          width: 700,
        }}
      >
        <div
          style={{
            fontFamily: T.sans,
            fontWeight: 800,
            fontSize: 84,
            lineHeight: 1.08,
            letterSpacing: '-0.02em',
            color: T.ink,
            opacity: fadeIn(frame, 45),
            transform: `translateY(${(1 - fadeIn(frame, 45)) * 30}px)`,
          }}
        >
          You wait on AI
          <br />
          all day.
        </div>
        <div
          style={{
            marginTop: 36,
            fontFamily: T.sans,
            fontWeight: 400,
            fontSize: 32,
            lineHeight: 1.4,
            color: T.gray,
            opacity: fadeIn(frame, 110),
            transform: `translateY(${(1 - fadeIn(frame, 110)) * 24}px)`,
          }}
        >
          DWELL shows one sponsored line
          <br />
          while it thinks — and pays <span style={{color: T.accentD, fontWeight: 700}}>you</span>.
        </div>
      </div>

      {/* Right: chat window */}
      <div
        style={{
          position: 'absolute',
          right: 110,
          top: 220,
          width: 760,
          borderRadius: 16,
          background: T.bg,
          border: `1px solid ${T.line}`,
          boxShadow: '0 20px 60px rgba(0,0,0,0.08)',
          overflow: 'hidden',
          opacity: cardIn,
          transform: `translateY(${(1 - cardIn) * 60}px)`,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '20px 28px',
            borderBottom: `1px solid ${T.line}`,
          }}
        >
          <div style={{width: 14, height: 14, borderRadius: 99, background: T.accent}} />
          <div style={{fontFamily: T.sans, fontWeight: 600, fontSize: 22, color: T.ink}}>
            Assistant
          </div>
          <div
            style={{
              marginLeft: 'auto',
              fontFamily: T.mono,
              fontSize: 15,
              color: T.gray2,
            }}
          >
            thinking…
          </div>
        </div>

        <div style={{padding: '34px 28px 40px', minHeight: 420}}>
          {/* user bubble */}
          <div style={{display: 'flex', justifyContent: 'flex-end'}}>
            <div
              style={{
                maxWidth: 520,
                padding: '18px 24px',
                borderRadius: 14,
                background: T.cardInset,
                fontFamily: T.sans,
                fontSize: 24,
                lineHeight: 1.45,
                color: T.ink2,
                opacity: bubbleIn,
                transform: `scale(${0.9 + bubbleIn * 0.1})`,
                transformOrigin: 'bottom right',
              }}
            >
              Plan my product launch — pricing, landing page, announcement
              thread.
            </div>
          </div>

          {/* assistant thinking */}
          {frame > 38 ? (
            <div style={{marginTop: 44, display: 'flex', gap: 16, alignItems: 'center'}}>
              <ThinkingDots />
              <span
                style={{
                  fontFamily: T.sans,
                  fontSize: 21,
                  color: T.gray2,
                }}
              >
                Working on it…
              </span>
            </div>
          ) : null}

          {/* the sponsor pill slides in beneath the thinking row */}
          <div
            style={{
              marginTop: 52,
              display: 'flex',
              justifyContent: 'center',
              opacity: pillIn,
              transform: `translateY(${(1 - pillIn) * 40}px)`,
            }}
          >
            <SponsorPill
              chip="L"
              line="Ledger — keep your keys yours"
              scale={1.02}
            />
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
