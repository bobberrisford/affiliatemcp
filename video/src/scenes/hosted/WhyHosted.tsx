import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import { color, font, shadow } from '../../theme';
import { Halftone, SectionLabel } from '../../components/primitives';
import { riseIn, fadeIn } from '../../anim';

// The install walls that keep the highest-value cohort out, from the custody
// decision's context. Hosted exists to remove exactly these.
const WALLS = [
  { was: 'a runtime to install', now: 'nothing to install' },
  { was: 'config files to wire up', now: 'a guided dashboard' },
  { was: 'a laptop left awake', now: 'runs in the cloud' },
];

export const WhyHosted: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const head = riseIn(frame, fps, 0, 24);

  return (
    <AbsoluteFill style={{ background: color.paper2 }}>
      <Halftone opacity={0.05} />
      <AbsoluteFill style={{ padding: '90px 110px', justifyContent: 'center' }}>
        <div style={{ ...head, marginBottom: 40 }}>
          <SectionLabel>who hosted is for</SectionLabel>
          <div
            style={{
              fontFamily: font.display,
              fontWeight: 800,
              fontSize: 64,
              textTransform: 'lowercase',
              letterSpacing: '-0.03em',
              lineHeight: 1.02,
              color: color.ink,
              marginTop: 16,
              maxWidth: 1500,
            }}
          >
            love the idea, but never opened a terminal in your life?
          </div>
          <div
            style={{
              fontFamily: font.sans,
              fontWeight: 500,
              fontSize: 30,
              color: color.smudgeDk,
              marginTop: 14,
              maxWidth: 62 * 18,
            }}
          >
            The people who get the most from affiliate data, agency and brand
            managers and multi-network publishers, are often the ones who can't
            self-host. Hosted removes every wall in the way.
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {WALLS.map((w, i) => {
            const a = riseIn(frame, fps, 28 + i * 12, 40);
            return (
              <div
                key={w.was}
                style={{
                  ...a,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 28,
                  background: color.paper,
                  border: `3px solid ${color.ink}`,
                  borderRadius: 10,
                  boxShadow: shadow.hard,
                  padding: '20px 28px',
                }}
              >
                <span
                  style={{
                    flex: 1,
                    fontFamily: font.sans,
                    fontWeight: 500,
                    fontSize: 30,
                    color: color.smudgeDk,
                    textDecoration: 'line-through',
                    textDecorationColor: color.magenta,
                    textDecorationThickness: 3,
                  }}
                >
                  {w.was}
                </span>
                <span style={{ fontFamily: font.mono, fontWeight: 800, fontSize: 30, color: color.blue }}>
                  →
                </span>
                <span
                  style={{
                    flex: 1,
                    fontFamily: font.sans,
                    fontWeight: 700,
                    fontSize: 32,
                    color: color.ink,
                  }}
                >
                  {w.now}
                </span>
              </div>
            );
          })}
        </div>

        <div
          style={{
            opacity: fadeIn(frame, 74, 14),
            marginTop: 26,
            fontFamily: font.sans,
            fontWeight: 700,
            fontSize: 28,
            color: color.ink,
          }}
        >
          Same answers as the free local server.{' '}
          <span style={{ background: color.blue, color: color.paper, padding: '0 8px' }}>
            Someone else keeps the lights on.
          </span>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
