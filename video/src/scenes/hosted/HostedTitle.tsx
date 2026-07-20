import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';
import { color, font } from '../../theme';
import { Halftone, Chip } from '../../components/primitives';
import { Mark } from '../../components/Mark';

export const HostedTitle: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const markS = spring({ frame, fps, config: { damping: 12, mass: 0.9, stiffness: 90 } });
  const wordS = spring({ frame: frame - 12, fps, config: { damping: 200, stiffness: 90 } });
  const tagS = spring({ frame: frame - 22, fps, config: { damping: 12, stiffness: 120 } });
  const leadS = spring({ frame: frame - 30, fps, config: { damping: 200 } });
  const chipS = spring({ frame: frame - 44, fps, config: { damping: 200 } });

  return (
    <AbsoluteFill style={{ background: color.ink }}>
      <Halftone dark opacity={0.08} />
      <AbsoluteFill
        style={{
          background: color.blue,
          transform: `translateY(${interpolate(
            spring({ frame: frame - 6, fps, config: { damping: 200, stiffness: 70 } }),
            [0, 1],
            [1080, 800],
          )}px)`,
        }}
      />
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', gap: 34 }}>
        <div
          style={{
            transform: `scale(${interpolate(markS, [0, 1], [0.4, 1])}) rotate(${interpolate(markS, [0, 1], [-16, 0])}deg)`,
            opacity: markS,
          }}
        >
          <Mark size={150} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
          <div
            style={{
              opacity: wordS,
              transform: `translateY(${interpolate(wordS, [0, 1], [40, 0])}px)`,
              fontFamily: font.display,
              fontWeight: 800,
              fontSize: 128,
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
          <span
            style={{
              opacity: tagS,
              transform: `rotate(-6deg) scale(${interpolate(tagS, [0, 1], [0.6, 1])})`,
              fontFamily: font.mono,
              fontWeight: 800,
              fontSize: 40,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: color.paper,
              border: `4px solid ${color.paper}`,
              padding: '6px 16px',
              borderRadius: 8,
            }}
          >
            hosted
          </span>
        </div>

        <div
          style={{
            opacity: leadS,
            transform: `translateY(${interpolate(leadS, [0, 1], [26, 0])}px)`,
            fontFamily: font.sans,
            fontWeight: 500,
            fontSize: 42,
            color: color.paper,
            textAlign: 'center',
            maxWidth: 1200,
          }}
        >
          your affiliate data in{' '}
          <span style={{ color: color.blueBright, fontWeight: 700 }}>Claude</span>. no install,
          no terminal.
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
          <Chip variant="blue">start free, £0</Chip>
          <Chip variant="ink" style={{ border: `2px solid ${color.lineInvert}` }}>
            runs in the cloud
          </Chip>
          <Chip variant="mag">keys encrypted</Chip>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
