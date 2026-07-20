import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';
import { color, font } from '../theme';
import { Halftone, Chip } from '../components/primitives';
import { Mark } from '../components/Mark';
import { riseIn, fadeIn } from '../anim';

export const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const markS = spring({ frame, fps, config: { damping: 13, mass: 0.9, stiffness: 90 } });
  const word = riseIn(frame, fps, 12, 40);

  return (
    <AbsoluteFill style={{ background: color.ink }}>
      <Halftone dark opacity={0.08} />
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', gap: 34 }}>
        <div style={{ opacity: markS, transform: `scale(${interpolate(markS, [0, 1], [0.5, 1])})` }}>
          <Mark size={150} />
        </div>

        <div
          style={{
            ...word,
            fontFamily: font.display,
            fontWeight: 800,
            fontSize: 130,
            letterSpacing: '-0.04em',
            lineHeight: 1,
            textTransform: 'lowercase',
            color: color.paper,
            display: 'flex',
            alignItems: 'baseline',
          }}
        >
          affiliate-
          <span style={{ background: color.blue, color: color.paper, padding: '0 0.08em', borderRadius: 14 }}>
            mcp
          </span>
        </div>

        <div
          style={{
            opacity: fadeIn(frame, 30, 14),
            fontFamily: font.sans,
            fontWeight: 500,
            fontSize: 38,
            color: color.paper,
            textAlign: 'center',
          }}
        >
          affiliate data, where affiliate work happens.
        </div>

        <div style={{ opacity: fadeIn(frame, 44, 14), display: 'flex', gap: 16, marginTop: 6 }}>
          <Chip variant="blue">MIT licensed</Chip>
          <Chip variant="ink" style={{ border: `2px solid ${color.lineInvert}` }}>
            public beta
          </Chip>
          <Chip variant="mag">bring your own keys</Chip>
        </div>

        <div
          style={{
            opacity: fadeIn(frame, 58, 14),
            fontFamily: font.mono,
            fontWeight: 700,
            fontSize: 27,
            letterSpacing: '0.08em',
            color: color.blueBright,
            marginTop: 14,
          }}
        >
          github.com/bobberrisford/affiliatemcp
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
