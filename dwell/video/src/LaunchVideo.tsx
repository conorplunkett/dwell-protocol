import React from 'react';
import {AbsoluteFill, Series, useCurrentFrame, interpolate} from 'remotion';
import {Hook} from './scenes/Hook';
import {MakeMoney} from './scenes/MakeMoney';
import {TokenScene} from './scenes/TokenScene';
import {Payout} from './scenes/Payout';
import {Cta} from './scenes/Cta';

/** Quick white dip between scenes so cuts don't feel abrupt. */
const SceneFade: React.FC<{
  children: React.ReactNode;
  duration: number;
}> = ({children, duration}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(
    frame,
    [0, 6, duration - 6, duration],
    [0, 1, 1, 0],
    {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'},
  );
  return <AbsoluteFill style={{opacity}}>{children}</AbsoluteFill>;
};

// 45s @ 30fps = 1350 frames
const D = {hook: 230, money: 210, token: 360, payout: 240, cta: 310};

export const LaunchVideo: React.FC = () => (
  <AbsoluteFill style={{background: '#ffffff'}}>
    <Series>
      <Series.Sequence durationInFrames={D.hook}>
        <SceneFade duration={D.hook}>
          <Hook />
        </SceneFade>
      </Series.Sequence>
      <Series.Sequence durationInFrames={D.money}>
        <SceneFade duration={D.money}>
          <MakeMoney />
        </SceneFade>
      </Series.Sequence>
      <Series.Sequence durationInFrames={D.token}>
        <SceneFade duration={D.token}>
          <TokenScene />
        </SceneFade>
      </Series.Sequence>
      <Series.Sequence durationInFrames={D.payout}>
        <SceneFade duration={D.payout}>
          <Payout />
        </SceneFade>
      </Series.Sequence>
      <Series.Sequence durationInFrames={D.cta}>
        <SceneFade duration={D.cta}>
          <Cta />
        </SceneFade>
      </Series.Sequence>
    </Series>
  </AbsoluteFill>
);
