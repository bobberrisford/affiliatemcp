import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';
import { color, font } from '../../theme';
import { Halftone, SectionLabel, Chip } from '../../components/primitives';
import { riseIn } from '../../anim';

// Simplified: one idea. No install, no terminal — for people who just want
// answers. The voiceover carries the rest.
export const WhyHosted: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const label = riseIn(frame, fps, 0, 24);
  const head = spring({ frame: frame - 14, fps, config: { damping: 200, stiffness: 90 } });
  const sub = riseIn(frame, fps, 30, 30);
  const chips = riseIn(frame, fps, 46, 24);

  return (
    <AbsoluteFill style={{ background: color.paper2 }}>
      <Halftone opacity={0.05} />
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', padding: '0 120px', paddingBottom: 130 }}>
        <div style={{ ...label, marginBottom: 26 }}>
          <SectionLabel>who it's for</SectionLabel>
        </div>
        <div
          style={{
            opacity: head,
            transform: `translateY(${interpolate(head, [0, 1], [40, 0])}px)`,
            fontFamily: font.display,
            fontWeight: 800,
            fontSize: 128,
            textTransform: 'lowercase',
            letterSpacing: '-0.04em',
            lineHeight: 0.98,
            color: color.ink,
            textAlign: 'center',
          }}
        >
          no install.
          <br />
          no terminal.
        </div>
        <div
          style={{
            ...sub,
            fontFamily: font.sans,
            fontWeight: 500,
            fontSize: 36,
            color: color.smudgeDk,
            textAlign: 'center',
            marginTop: 26,
          }}
        >
          for the people who just want answers, not a setup guide.
        </div>
        <div style={{ ...chips, display: 'flex', gap: 16, marginTop: 34 }}>
          <Chip variant="blue">agency &amp; brand managers</Chip>
          <Chip variant="ink">busy publishers</Chip>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
