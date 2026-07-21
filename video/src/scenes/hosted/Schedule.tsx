import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';
import { color, font, shadow } from '../../theme';
import { Halftone, SectionLabel } from '../../components/primitives';
import { riseIn } from '../../anim';

// Simplified to two scheduled emails: a weekly report and an anomaly alert.
const MAILS = [
  {
    when: 'MON 08:00',
    subject: 'Your weekly earnings digest',
    preview: '£13,945 across 5 networks last week, up 6%.',
    accent: color.blue,
    tag: 'report',
  },
  {
    when: 'MON 08:00',
    subject: 'Anomaly alert',
    preview: 'Acme revenue down 34% week on week. Worth a look.',
    accent: color.magenta,
    tag: 'alert',
  },
];

export const Schedule: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const head = riseIn(frame, fps, 0, 24);

  return (
    <AbsoluteFill style={{ background: color.ink }}>
      <Halftone dark opacity={0.08} />
      <AbsoluteFill style={{ justifyContent: 'center', padding: '0 120px', paddingBottom: 120 }}>
        <div style={{ ...head, marginBottom: 40 }}>
          <SectionLabel onDark accent={color.blueBright}>automation</SectionLabel>
          <div
            style={{
              fontFamily: font.display,
              fontWeight: 800,
              fontSize: 72,
              textTransform: 'lowercase',
              letterSpacing: '-0.03em',
              color: color.paper,
              marginTop: 16,
            }}
          >
            it works the days you don't.
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 1400 }}>
          {MAILS.map((m, i) => {
            const sp = spring({ frame: frame - (30 + i * 16), fps, config: { damping: 200, mass: 0.6, stiffness: 110 } });
            return (
              <div
                key={m.subject}
                style={{
                  opacity: sp,
                  transform: `translateX(${interpolate(sp, [0, 1], [-44, 0])}px)`,
                  display: 'flex', alignItems: 'center', gap: 24,
                  background: color.paper, border: `3px solid ${color.ink}`, borderLeft: `14px solid ${m.accent}`,
                  borderRadius: 10, boxShadow: shadow.hard, padding: '24px 30px',
                }}
              >
                <div style={{ fontFamily: font.mono, fontWeight: 800, fontSize: 22, letterSpacing: '0.06em', color: color.paper, background: color.ink, borderRadius: 6, padding: '12px 14px', minWidth: 150, textAlign: 'center' }}>
                  {m.when}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ fontFamily: font.sans, fontWeight: 700, fontSize: 33, color: color.ink }}>{m.subject}</span>
                    <span style={{ fontFamily: font.mono, fontWeight: 800, fontSize: 16, letterSpacing: '0.1em', textTransform: 'uppercase', color: color.paper, background: m.accent, padding: '4px 9px', borderRadius: 4 }}>
                      {m.tag}
                    </span>
                  </div>
                  <div style={{ fontFamily: font.sans, fontSize: 26, color: color.smudgeDk, marginTop: 6 }}>{m.preview}</div>
                </div>
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
