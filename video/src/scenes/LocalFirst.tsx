import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { color, font, shadow } from '../theme';
import { Halftone, SectionLabel } from '../components/primitives';
import { riseIn } from '../anim';

const CARDS = [
  {
    glyph: '~/',
    title: 'your machine',
    body: 'The server runs locally. Keys live in ~/.affiliate-mcp/.env, locked to your user account (0600).',
  },
  {
    glyph: '🔑',
    title: 'your keys',
    body: 'Bring your own credentials. Networks see the same API calls they’d see from your dashboard. Nothing else.',
  },
  {
    glyph: 'GET',
    title: 'read-only, by default',
    body: 'Every brand-side adapter refuses any non-GET method before it leaves your machine. Telemetry is off by default.',
  },
];

export const LocalFirst: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const head = riseIn(frame, fps, 0, 24);

  return (
    <AbsoluteFill style={{ background: color.blue }}>
      <Halftone dark opacity={0.08} />
      <AbsoluteFill style={{ padding: '90px 110px', justifyContent: 'center' }}>
        <div style={{ ...head, marginBottom: 40 }}>
          <SectionLabel accent={color.paper}>your data, your machine</SectionLabel>
          <div
            style={{
              fontFamily: font.display,
              fontWeight: 800,
              fontSize: 66,
              textTransform: 'lowercase',
              letterSpacing: '-0.03em',
              color: color.paper,
              marginTop: 16,
            }}
          >
            local-first isn't a setting. it's the whole design.
          </div>
        </div>

        <div style={{ display: 'flex', gap: 26 }}>
          {CARDS.map((c, i) => {
            const a = riseIn(frame, fps, 26 + i * 12, 46);
            return (
              <div
                key={c.title}
                style={{
                  ...a,
                  flex: 1,
                  background: color.paper,
                  border: `3px solid ${color.ink}`,
                  borderRadius: 12,
                  boxShadow: shadow.hard,
                  padding: '32px 34px',
                }}
              >
                <div
                  style={{
                    fontFamily: font.mono,
                    fontWeight: 800,
                    fontSize: 44,
                    color: color.blue,
                    marginBottom: 18,
                  }}
                >
                  {c.glyph}
                </div>
                <div
                  style={{
                    fontFamily: font.display,
                    fontWeight: 800,
                    fontSize: 38,
                    textTransform: 'lowercase',
                    letterSpacing: '-0.02em',
                    color: color.ink,
                    marginBottom: 12,
                  }}
                >
                  {c.title}
                </div>
                <div style={{ fontFamily: font.sans, fontSize: 25, lineHeight: 1.45, color: color.smudgeDk }}>
                  {c.body}
                </div>
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
