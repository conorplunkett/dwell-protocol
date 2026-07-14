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

const OptionCard: React.FC<{
  title: string;
  detail: string;
  badge?: string;
  inAt: number;
}> = ({title, detail, badge, inAt}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const s = spring({frame: frame - inAt, fps, config: {damping: 14, stiffness: 120}});
  return (
    <div
      style={{
        width: 480,
        padding: '34px 38px',
        borderRadius: 16,
        background: T.bg,
        border: `1px solid ${T.line}`,
        boxShadow: '0 16px 50px rgba(0,0,0,0.08)',
        opacity: s,
        transform: `translateY(${(1 - s) * 60}px)`,
      }}
    >
      <div style={{display: 'flex', alignItems: 'center', gap: 14}}>
        <div
          style={{
            fontFamily: T.sans,
            fontWeight: 700,
            fontSize: 30,
            color: T.ink,
          }}
        >
          {title}
        </div>
        {badge ? (
          <div
            style={{
              fontFamily: T.mono,
              fontWeight: 600,
              fontSize: 16,
              color: T.accentInk,
              background: T.accent,
              padding: '5px 12px',
              borderRadius: 999,
            }}
          >
            {badge}
          </div>
        ) : null}
      </div>
      <div
        style={{
          marginTop: 14,
          fontFamily: T.mono,
          fontSize: 20,
          color: T.gray,
        }}
      >
        {detail}
      </div>
    </div>
  );
};

export const Payout: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const headIn = spring({frame: frame - 2, fps, config: {damping: 15, stiffness: 140}});
  const dwells = Math.round(
    interpolate(frame, [20, 90], [0, 12480], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: (t) => 1 - Math.pow(1 - t, 3),
    }),
  );

  return (
    <AbsoluteFill style={{background: T.bg, alignItems: 'center'}}>
      <div style={{position: 'absolute', top: 48, left: 64}}>
        <Lockup height={40} />
      </div>

      <div
        style={{
          marginTop: 150,
          fontFamily: T.sans,
          fontWeight: 800,
          fontSize: 92,
          letterSpacing: '-0.02em',
          color: T.ink,
          opacity: headIn,
          transform: `translateY(${(1 - headIn) * 40}px)`,
        }}
      >
        Cash out. <span style={{color: T.accent}}>For real.</span>
      </div>

      <div style={{marginTop: 56, textAlign: 'center'}}>
        <div
          style={{
            fontFamily: T.mono,
            fontWeight: 600,
            fontSize: 100,
            color: T.ink,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {dwells.toLocaleString('en-US')}
          <span style={{fontSize: 44, color: T.gray, marginLeft: 20}}>dwells</span>
        </div>
        <div
          style={{
            marginTop: 10,
            fontFamily: T.sans,
            fontWeight: 600,
            fontSize: 36,
            color: T.gray,
            opacity: fadeIn(frame, 85),
          }}
        >
          = <span style={{color: T.okFg, fontWeight: 700}}>$12.48</span> of earned ad value
        </div>
      </div>

      <div style={{display: 'flex', gap: 44, marginTop: 78}}>
        <OptionCard
          title="USDC → your wallet"
          detail="7xKX…9fQ2 · payout via licensed partners"
          inAt={110}
        />
        <OptionCard
          title="Claude credits"
          detail="turn earnings into more AI time"
          badge="+10% boost"
          inAt={122}
        />
      </div>
    </AbsoluteFill>
  );
};
