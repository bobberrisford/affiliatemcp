import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';
import { color, font, shadow } from '../../theme';
import { Halftone, Chip } from '../../components/primitives';
import { Mark } from '../../components/Mark';
import { riseIn, fadeIn } from '../../anim';

export const HostedOutro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const markS = spring({ frame, fps, config: { damping: 13, mass: 0.9, stiffness: 90 } });
  const word = riseIn(frame, fps, 12, 40);

  return (
    <AbsoluteFill style={{ background: color.ink }}>
      <Halftone dark opacity={0.08} />
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', gap: 30 }}>
        <div style={{ opacity: markS, transform: `scale(${interpolate(markS, [0, 1], [0.5, 1])})` }}>
          <Mark size={130} />
        </div>

        <div
          style={{
            ...word,
            fontFamily: font.display,
            fontWeight: 800,
            fontSize: 104,
            letterSpacing: '-0.04em',
            lineHeight: 1,
            textTransform: 'lowercase',
            color: color.paper,
          }}
        >
          get hosted
        </div>

        <div
          style={{
            opacity: fadeIn(frame, 26, 14),
            fontFamily: font.sans,
            fontWeight: 500,
            fontSize: 36,
            color: color.paper,
            textAlign: 'center',
          }}
        >
          sign in by email, connect your networks, ask Claude anything.
        </div>

        {/* the two concrete entry points */}
        <div style={{ opacity: fadeIn(frame, 40, 14), display: 'flex', gap: 16, marginTop: 8 }}>
          <span
            style={{
              fontFamily: font.mono,
              fontWeight: 700,
              fontSize: 26,
              color: color.ink,
              background: color.paper,
              borderRadius: 8,
              padding: '12px 20px',
              boxShadow: shadow.blue,
            }}
          >
            agenticaffiliate.ai
          </span>
          <span
            style={{
              fontFamily: font.mono,
              fontWeight: 700,
              fontSize: 26,
              color: color.blueBright,
              border: `2px solid ${color.lineInvert}`,
              borderRadius: 8,
              padding: '12px 20px',
            }}
          >
            mcp.agenticaffiliate.ai/mcp
          </span>
        </div>

        <div style={{ opacity: fadeIn(frame, 56, 14), display: 'flex', gap: 14, marginTop: 12 }}>
          <Chip variant="blue">start free, £0</Chip>
          <Chip variant="mag">cancel any time</Chip>
          <Chip variant="ink" style={{ border: `2px solid ${color.lineInvert}` }}>
            local stays free &amp; complete
          </Chip>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
