import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, continueRender, delayRender } from 'remotion';
import { TransitionSeries, linearTiming } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { color } from './theme';
import { loadBrandFonts } from './fonts';
import { SceneWithVO } from './components/vo';

import { HostedTitle } from './scenes/hosted/HostedTitle';
import { WhyHosted } from './scenes/hosted/WhyHosted';
import { Onboarding } from './scenes/hosted/Onboarding';
import { HostedReport } from './scenes/hosted/HostedReport';
import { Schedule } from './scenes/hosted/Schedule';
import { Trust } from './scenes/hosted/Trust';
import { Pricing } from './scenes/Pricing';
import { HostedOutro } from './scenes/hosted/HostedOutro';

import manifest from './vo/manifest.json';
import linesData from './vo/lines.json';

const TR = 15; // crossfade frames
const HEAD_PAD = 16; // frames before narration starts in a scene
const TAIL_PAD = 42; // quiet frames after narration before the next scene

// Scene component + a minimum length that guarantees its build animation
// finishes even if the narration line is short. Order matches the manifest.
const SCENE_DEFS: { id: string; C: React.FC; min: number }[] = [
  { id: 'title', C: HostedTitle, min: 90 },
  { id: 'why', C: WhyHosted, min: 110 },
  { id: 'connect', C: Onboarding, min: 150 },
  { id: 'report', C: HostedReport, min: 210 },
  { id: 'schedule', C: Schedule, min: 130 },
  { id: 'trust', C: Trust, min: 120 },
  { id: 'pricing', C: Pricing, min: 150 },
  { id: 'cta', C: HostedOutro, min: 110 },
];

const vo = Object.fromEntries(manifest.scenes.map((s) => [s.id, s]));
const caption = Object.fromEntries(linesData.lines.map((l) => [l.id, l.caption]));

const SCENES = SCENE_DEFS.map((d) => {
  const clip = vo[d.id];
  const dur = Math.max(d.min, (clip?.frames ?? 0) + HEAD_PAD + TAIL_PAD);
  return { ...d, dur, audioFile: clip?.file ?? '', text: caption[d.id] ?? '' };
});

export const HOSTED_TOTAL_FRAMES = SCENES.reduce((s, x) => s + x.dur, 0) - TR * (SCENES.length - 1);

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
        {SCENES.map((s, i) => (
          <React.Fragment key={s.id}>
            <TransitionSeries.Sequence durationInFrames={s.dur}>
              <SceneWithVO comp={s.C} caption={s.text} audioFile={s.audioFile} dur={s.dur} headPad={HEAD_PAD} />
            </TransitionSeries.Sequence>
            {i < SCENES.length - 1 ? (
              <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: TR })} />
            ) : null}
          </React.Fragment>
        ))}
      </TransitionSeries>
      <ProgressRule />
    </AbsoluteFill>
  );
};
