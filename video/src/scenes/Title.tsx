import React from 'react';
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
} from 'remotion';
import { color, font } from '../theme';
import { Halftone, Chip } from '../components/primitives';
import { Mark } from '../components/Mark';

export const Title: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const markS = spring({ frame, fps, config: { damping: 12, mass: 0.9, stiffness: 90 } });
  const wordS = spring({ frame: frame - 12, fps, config: { damping: 200, stiffness: 90 } });
  const tagS = spring({ frame: frame - 26, fps, config: { damping: 200 } });
  const chipS = spring({ frame: frame - 40, fps, config: { damping: 200 } });

  return (
    <AbsoluteFill style={{ background: color.ink }}>
      <Halftone dark opacity={0.08} />
      {/* riso-blue slab sweeping up from the bottom */}
      <AbsoluteFill
        style={{
          background: color.blue,
          transform: `translateY(${interpolate(
            spring({ frame: frame - 6, fps, config: { damping: 200, stiffness: 70 } }),
            [0, 1],
            [1080, 760],
          )}px)`,
        }}
      />
      <AbsoluteFill
        style={{
          justifyContent: 'center',
          alignItems: 'center',
          gap: 40,
        }}
      >
        <div
          style={{
            transform: `scale(${interpolate(markS, [0, 1], [0.4, 1])}) rotate(${interpolate(
              markS,
              [0, 1],
              [-18, 0],
            )}deg)`,
            opacity: markS,
          }}
        >
          <Mark size={170} />
        </div>

        <div
          style={{
            opacity: wordS,
            transform: `translateY(${interpolate(wordS, [0, 1], [40, 0])}px)`,
            fontFamily: font.display,
            fontWeight: 800,
            fontSize: 150,
            letterSpacing: '-0.04em',
            lineHeight: 1,
            textTransform: 'lowercase',
            color: color.paper,
            display: 'flex',
            alignItems: 'baseline',
          }}
        >
          affiliate-
          <span style={{ background: color.blue, color: color.paper, padding: '0 0.08em', borderRadius: 16 }}>
            mcp
          </span>
        </div>

        <div
          style={{
            opacity: tagS,
            transform: `translateY(${interpolate(tagS, [0, 1], [30, 0])}px)`,
            fontFamily: font.sans,
            fontWeight: 500,
            fontSize: 40,
            color: color.paper,
            textAlign: 'center',
          }}
        >
          integrate your affiliate networks with{' '}
          <span style={{ color: color.blueBright, fontWeight: 700 }}>Claude</span> or{' '}
          <span style={{ color: color.blueBright, fontWeight: 700 }}>Codex</span>
        </div>

        <div
          style={{
            opacity: chipS,
            transform: `translateY(${interpolate(chipS, [0, 1], [20, 0])}px)`,
            display: 'flex',
            gap: 16,
            marginTop: 6,
          }}
        >
          <Chip variant="blue">free &amp; open source</Chip>
          <Chip variant="ink" style={{ border: `2px solid ${color.lineInvert}` }}>
            local-first
          </Chip>
          <Chip variant="mag">bring your own keys</Chip>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
