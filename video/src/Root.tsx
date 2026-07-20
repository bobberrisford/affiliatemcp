import React from 'react';
import { Composition } from 'remotion';
import { DemoVideo, TOTAL_FRAMES } from './DemoVideo';
import { VIDEO } from './theme';

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="DemoVideo"
      component={DemoVideo}
      durationInFrames={TOTAL_FRAMES}
      fps={VIDEO.fps}
      width={VIDEO.width}
      height={VIDEO.height}
    />
  );
};
