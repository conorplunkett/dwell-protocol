import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {T} from '../theme';
import {SponsorPill} from '../components/SponsorPill';
import {Cursor, ClickRipple} from '../components/Cursor';
import {Lockup, fadeIn} from '../components/Logo';

const CLICK_FRAME = 108;
const CLICK_X = 1010;
const CLICK_Y = 700;

const Sparkline: React.FC<{progress: number}> = ({progress}) => (
  <svg width={600} height={150} viewBox="0 0 600 150">
    {/* an early, jagged launch chart */}
    <polyline
      points="0,132 45,126 90,130 135,112 180,118 225,96 270,104 315,78 360,88 405,60 450,70 495,40 540,50 600,18"
      fill="none"
      stroke={T.okFg}
      strokeWidth={5}
      strokeLinejoin="round"
      strokeLinecap="round"
      pathLength={1}
      strokeDasharray={1}
      strokeDashoffset={1 - progress}
    />
  </svg>
);

export const TokenScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const headIn = spring({frame: frame - 2, fps, config: {damping: 15, stiffness: 140}});
  const pillIn = spring({frame: frame - 25, fps, config: {damping: 14, stiffness: 130}});

  // Cursor flight in from the bottom-right corner.
  const flight = spring({frame: frame - 55, fps, config: {damping: 17, stiffness: 70}});
  const curX = interpolate(flight, [0, 1], [1700, CLICK_X - 10]);
  const curY = interpolate(flight, [0, 1], [1060, CLICK_Y - 12]);
  const hovered = frame >= 96 && frame < CLICK_FRAME + 20;

  // The click, and the card popping open out of the pill.
  const press = interpolate(
    frame,
    [CLICK_FRAME, CLICK_FRAME + 4, CLICK_FRAME + 10],
    [0, 1, 0],
    {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'},
  );
  const ripple = interpolate(frame, [CLICK_FRAME + 2, CLICK_FRAME + 20], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const cardIn = spring({
    frame: frame - (CLICK_FRAME + 8),
    fps,
    config: {damping: 13, stiffness: 110},
  });
  const cardOpen = frame >= CLICK_FRAME + 8;

  const chartProgress = interpolate(frame, [CLICK_FRAME + 22, CLICK_FRAME + 85], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: (t) => 1 - Math.pow(1 - t, 2),
  });

  return (
    <AbsoluteFill style={{background: T.bgTint}}>
      <div style={{position: 'absolute', top: 48, left: 64}}>
        <Lockup height={40} />
      </div>

      {/* headline */}
      <div
        style={{
          position: 'absolute',
          top: 96,
          width: '100%',
          textAlign: 'center',
          opacity: headIn * (cardOpen ? 0.35 : 1),
          transform: `translateY(${(1 - headIn) * 40}px)`,
        }}
      >
        <div
          style={{
            fontFamily: T.sans,
            fontWeight: 800,
            fontSize: 84,
            letterSpacing: '-0.02em',
            color: T.ink,
          }}
        >
          Find the next big <span style={{color: T.accent}}>token</span>.
        </div>
        <div
          style={{
            marginTop: 18,
            fontFamily: T.sans,
            fontSize: 30,
            color: T.gray,
            opacity: fadeIn(frame, 18),
          }}
        >
          New launches show up right in the bar — while you were waiting anyway.
        </div>
      </div>

      {/* the sponsor pill carrying a token launch */}
      <div
        style={{
          position: 'absolute',
          top: 660,
          width: '100%',
          display: 'flex',
          justifyContent: 'center',
          opacity: pillIn,
          transform: `translateY(${(1 - pillIn) * 50}px)`,
        }}
      >
        <SponsorPill
          chip="M"
          line="$MOON just launched on star.fun"
          tag="New"
          scale={1.35}
          hovered={hovered}
        />
      </div>

      {/* pop-open token card */}
      {cardOpen ? (
        <div
          style={{
            position: 'absolute',
            left: (1920 - 720) / 2,
            top: 172,
            width: 720,
            borderRadius: 18,
            background: T.bg,
            border: `1px solid ${T.line}`,
            boxShadow: '0 30px 90px rgba(0,0,0,0.18)',
            padding: '34px 40px 38px',
            opacity: Math.min(1, cardIn * 1.4),
            transform: `translateY(${(1 - cardIn) * 120}px) scale(${0.5 + cardIn * 0.5})`,
            transformOrigin: '50% 120%',
          }}
        >
          <div style={{display: 'flex', alignItems: 'center', gap: 20}}>
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: 999,
                background: `linear-gradient(135deg, ${T.ink2}, #000)`,
                color: '#fff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: T.sans,
                fontWeight: 800,
                fontSize: 30,
              }}
            >
              M
            </div>
            <div>
              <div
                style={{
                  fontFamily: T.sans,
                  fontWeight: 700,
                  fontSize: 34,
                  color: T.ink,
                }}
              >
                Moonbeam{' '}
                <span style={{fontFamily: T.mono, fontWeight: 600, color: T.gray}}>
                  $MOON
                </span>
              </div>
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 17,
                  color: T.gray2,
                  marginTop: 4,
                }}
              >
                launched 2h ago on star.fun
              </div>
            </div>
            <div
              style={{
                marginLeft: 'auto',
                fontFamily: T.mono,
                fontWeight: 600,
                fontSize: 15,
                letterSpacing: '0.05em',
                color: T.accentD,
                background: 'rgba(255,0,0,0.08)',
                border: '1px solid rgba(255,0,0,0.25)',
                padding: '6px 14px',
                borderRadius: 999,
              }}
            >
              NEW
            </div>
          </div>

          <div style={{marginTop: 26}}>
            <Sparkline progress={chartProgress} />
          </div>

          <div
            style={{
              display: 'flex',
              gap: 36,
              marginTop: 22,
              fontFamily: T.mono,
              fontSize: 19,
              color: T.gray,
              opacity: fadeIn(frame, CLICK_FRAME + 40),
            }}
          >
            <span>holders 1,204</span>
            <span>·</span>
            <span>age 2h 14m</span>
            <span>·</span>
            <span>solana / SPL</span>
          </div>

          <div
            style={{
              marginTop: 28,
              display: 'inline-block',
              fontFamily: T.sans,
              fontWeight: 700,
              fontSize: 24,
              color: T.accentInk,
              background: T.accent,
              padding: '16px 34px',
              borderRadius: 8,
              opacity: fadeIn(frame, CLICK_FRAME + 55),
            }}
          >
            View token ↗
          </div>
        </div>
      ) : null}

      <ClickRipple x={CLICK_X} y={CLICK_Y} progress={ripple} />
      {flight > 0.01 ? <Cursor x={curX} y={curY} press={press} /> : null}
    </AbsoluteFill>
  );
};
