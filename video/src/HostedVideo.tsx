import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, continueRender, delayRender } from 'remotion';
import { TransitionSeries, linearTiming } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { color } from './theme';
import { loadBrandFonts } from './fonts';

import { HostedTitle } from './scenes/hosted/HostedTitle';
import { WhyHosted } from './scenes/hosted/WhyHosted';
import { Onboarding } from './scenes/hosted/Onboarding';
import { HostedReport } from './scenes/hosted/HostedReport';
import { Schedule } from './scenes/hosted/Schedule';
import { Trust } from './scenes/hosted/Trust';
import { Pricing } from './scenes/Pricing';
import { HostedOutro } from './scenes/hosted/HostedOutro';

export const HOSTED_SCENES = [
  { C: HostedTitle, d: 120 },
  { C: WhyHosted, d: 165 },
  { C: Onboarding, d: 200 },
  { C: HostedReport, d: 300 },
  { C: Schedule, d: 195 },
  { C: Trust, d: 175 },
  { C: Pricing, d: 190 },
  { C: HostedOutro, d: 140 },
] as const;

const TR = 15;

export const HOSTED_TOTAL_FRAMES =
  HOSTED_SCENES.reduce((s, x) => s + x.d, 0) - TR * (HOSTED_SCENES.length - 1);

const ProgressRule: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const w = interpolate(frame, [0, durationInFrames - 1], [0, 100], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', bottom: 0, left: 0, height: 6, width: `${w}%`, background: color.magenta }} />
    </AbsoluteFill>
  );
};

export const HostedVideo: React.FC = () => {
  const [handle] = React.useState(() => delayRender('load-fonts'));
  React.useEffect(() => {
    loadBrandFonts().then(() => continueRender(handle));
  }, [handle]);

  return (
    <AbsoluteFill style={{ background: color.ink }}>
      <TransitionSeries>
        {HOSTED_SCENES.map(({ C, d }, i) => (
          <React.Fragment key={i}>
            <TransitionSeries.Sequence durationInFrames={d}>
              <C />
            </TransitionSeries.Sequence>
            {i < HOSTED_SCENES.length - 1 ? (
              <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: TR })} />
            ) : null}
          </React.Fragment>
        ))}
      </TransitionSeries>
      <ProgressRule />
    </AbsoluteFill>
  );
};
