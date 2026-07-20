import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, continueRender, delayRender } from 'remotion';
import { TransitionSeries, linearTiming } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { color } from './theme';
import { loadBrandFonts } from './fonts';

import { Title } from './scenes/Title';
import { Problem } from './scenes/Problem';
import { HowItWorks } from './scenes/HowItWorks';
import { Scale } from './scenes/Scale';
import { PublisherDemo } from './scenes/PublisherDemo';
import { BrandDemo } from './scenes/BrandDemo';
import { LocalFirst } from './scenes/LocalFirst';
import { Skills } from './scenes/Skills';
import { GetStarted } from './scenes/GetStarted';
import { Outro } from './scenes/Outro';

// Per-scene durations (frames @ 30fps). Transitions overlap by TR frames, so
// the total = sum(durations) − TR * (numberOfTransitions).
export const SCENES = [
  { C: Title, d: 115 },
  { C: Problem, d: 165 },
  { C: HowItWorks, d: 165 },
  { C: Scale, d: 165 },
  { C: PublisherDemo, d: 320 },
  { C: BrandDemo, d: 300 },
  { C: LocalFirst, d: 150 },
  { C: Skills, d: 175 },
  { C: GetStarted, d: 190 },
  { C: Outro, d: 130 },
] as const;

const TR = 15;

export const TOTAL_FRAMES =
  SCENES.reduce((s, x) => s + x.d, 0) - TR * (SCENES.length - 1);

// A thin persistent progress rule along the bottom of the whole film.
const ProgressRule: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const w = interpolate(frame, [0, durationInFrames - 1], [0, 100], {
    extrapolateRight: 'clamp',
  });
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          height: 6,
          width: `${w}%`,
          background: color.magenta,
        }}
      />
    </AbsoluteFill>
  );
};

export const DemoVideo: React.FC = () => {
  const [handle] = React.useState(() => delayRender('load-fonts'));
  React.useEffect(() => {
    loadBrandFonts().then(() => continueRender(handle));
  }, [handle]);

  return (
    <AbsoluteFill style={{ background: color.ink }}>
      <TransitionSeries>
        {SCENES.map(({ C, d }, i) => (
          <React.Fragment key={i}>
            <TransitionSeries.Sequence durationInFrames={d}>
              <C />
            </TransitionSeries.Sequence>
            {i < SCENES.length - 1 ? (
              <TransitionSeries.Transition
                presentation={fade()}
                timing={linearTiming({ durationInFrames: TR })}
              />
            ) : null}
          </React.Fragment>
        ))}
      </TransitionSeries>
      <ProgressRule />
    </AbsoluteFill>
  );
};
