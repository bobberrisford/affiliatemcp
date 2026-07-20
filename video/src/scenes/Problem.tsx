import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import { color, font, shadow } from '../theme';
import { Halftone, SectionLabel } from '../components/primitives';
import { riseIn } from '../anim';

const Side: React.FC<{
  frame: number;
  fps: number;
  delay: number;
  label: string;
  title: string;
  lines: string[];
  accent: string;
}> = ({ frame, fps, delay, label, title, lines, accent }) => {
  const a = riseIn(frame, fps, delay, 50);
  return (
    <div
      style={{
        ...a,
        flex: 1,
        background: color.paper,
        border: `3px solid ${color.ink}`,
        borderRadius: 10,
        boxShadow: shadow.hard,
        padding: '34px 38px',
      }}
    >
      <span
        style={{
          fontFamily: font.mono,
          fontWeight: 800,
          fontSize: 22,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          background: accent,
          color: color.paper,
          padding: '6px 12px',
          borderRadius: 4,
        }}
      >
        {label}
      </span>
      <div
        style={{
          fontFamily: font.display,
          fontWeight: 800,
          fontSize: 46,
          textTransform: 'lowercase',
          letterSpacing: '-0.02em',
          margin: '20px 0 16px',
          color: color.ink,
        }}
      >
        {title}
      </div>
      {lines.map((l, i) => (
        <div
          key={i}
          style={{
            fontFamily: font.sans,
            fontSize: 27,
            lineHeight: 1.45,
            color: color.smudgeDk,
            marginBottom: 8,
          }}
        >
          {l}
        </div>
      ))}
    </div>
  );
};

export const Problem: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const head = riseIn(frame, fps, 0, 30);
  const punch = riseIn(frame, fps, 62, 30);

  return (
    <AbsoluteFill style={{ background: color.paper2 }}>
      <Halftone opacity={0.05} />
      <AbsoluteFill style={{ padding: '90px 110px', justifyContent: 'center' }}>
        <div style={{ ...head, marginBottom: 34 }}>
          <SectionLabel>the problem</SectionLabel>
          <div
            style={{
              fontFamily: font.display,
              fontWeight: 800,
              fontSize: 66,
              textTransform: 'lowercase',
              letterSpacing: '-0.03em',
              lineHeight: 1.02,
              color: color.ink,
              marginTop: 18,
              maxWidth: 1400,
            }}
          >
            affiliate networks have two sides. neither ships an AI-workspace
            integration.
          </div>
        </div>

        <div style={{ display: 'flex', gap: 30 }}>
          <Side
            frame={frame}
            fps={fps}
            delay={30}
            label="publishers"
            title="earn the commissions"
            lines={[
              'Track earnings, pending payouts, and link health',
              'across every network — one dashboard at a time.',
            ]}
            accent={color.blue}
          />
          <Side
            frame={frame}
            fps={fps}
            delay={44}
            label="brands & agencies"
            title="run the programmes"
            lines={[
              'Optimise partners, spot anomalies, prep client',
              'updates — bouncing between portals and CSVs.',
            ]}
            accent={color.magenta}
          />
        </div>

        <div
          style={{
            ...punch,
            marginTop: 34,
            fontFamily: font.sans,
            fontWeight: 700,
            fontSize: 32,
            color: color.ink,
          }}
        >
          The data lives behind {' '}
          <span style={{ background: color.blue, color: color.paper, padding: '0 8px' }}>
            72 different logins
          </span>{' '}
          — and none of them talk to the tools you actually work in.
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
