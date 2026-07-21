import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { color, font, shadow } from '../../theme';
import { Halftone, SectionLabel } from '../../components/primitives';
import { riseIn } from '../../anim';

// Simplified to two points, plus the honest "four networks live" line so the
// cut never over-claims coverage.
const BITS = [
  {
    icon: '🔒',
    title: 'encrypted, never shared with Claude',
    body: 'Keys live in the dashboard. Claude gets a short-lived session, never your credentials.',
  },
  {
    icon: '🗑',
    title: 'yours to delete, any time',
    body: 'Used only to serve your requests. Export or hard-delete everything whenever you like.',
  },
];

export const Trust: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const head = riseIn(frame, fps, 0, 24);

  return (
    <AbsoluteFill style={{ background: color.blue }}>
      <Halftone dark opacity={0.08} />
      <AbsoluteFill style={{ justifyContent: 'center', padding: '0 120px', paddingBottom: 120 }}>
        <div style={{ ...head, marginBottom: 40 }}>
          <SectionLabel accent={color.paper}>your keys, your control</SectionLabel>
          <div
            style={{
              fontFamily: font.display,
              fontWeight: 800,
              fontSize: 68,
              textTransform: 'lowercase',
              letterSpacing: '-0.03em',
              color: color.paper,
              marginTop: 16,
            }}
          >
            holding your keys is a responsibility.
          </div>
          <div style={{ fontFamily: font.mono, fontWeight: 700, fontSize: 22, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.85)', marginTop: 12 }}>
            awin · cj · impact · rakuten live today
          </div>
        </div>

        <div style={{ display: 'flex', gap: 22 }}>
          {BITS.map((b, i) => {
            const a = riseIn(frame, fps, 30 + i * 14, 40);
            return (
              <div key={b.title} style={{ ...a, flex: 1, background: color.paper, border: `3px solid ${color.ink}`, borderRadius: 12, boxShadow: shadow.hard, padding: '30px 34px' }}>
                <div style={{ fontSize: 44, marginBottom: 14 }}>{b.icon}</div>
                <div style={{ fontFamily: font.display, fontWeight: 800, fontSize: 34, textTransform: 'lowercase', letterSpacing: '-0.015em', color: color.ink, marginBottom: 10 }}>
                  {b.title}
                </div>
                <div style={{ fontFamily: font.sans, fontSize: 25, lineHeight: 1.45, color: color.smudgeDk }}>{b.body}</div>
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
