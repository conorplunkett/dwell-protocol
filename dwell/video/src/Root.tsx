import React from 'react';
import {Composition} from 'remotion';
import {LaunchVideo} from './LaunchVideo';

export const RemotionRoot: React.FC = () => (
  <Composition
    id="LaunchVideo"
    component={LaunchVideo}
    durationInFrames={1350}
    fps={30}
    width={1920}
    height={1080}
  />
);
