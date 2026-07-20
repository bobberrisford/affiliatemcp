import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';
import { color, font, shadow } from '../../theme';
import { Halftone, SectionLabel } from '../../components/primitives';
import { riseIn, fadeIn } from '../../anim';

// Scheduled digests and anomaly watch land while the user's machine is off.
// Weekly earnings digest is Solo; anomaly + unpaid-commission digests are Pro.
const MAILS = [
  {
    when: 'MON 08:00',
    subject: 'Your weekly earnings digest',
    preview: '£13,945 across 5 networks last week, up 6%. £1,180 still pending past 90 days.',
    accent: color.blue,
    tag: 'digest',
  },
  {
    when: 'MON 08:00',
    subject: 'Anomaly watch: 2 things need attention',
    preview: 'Acme revenue down 34% wk/wk. Reversals 3.1× baseline on Northwind.',
    accent: color.magenta,
    tag: 'anomaly',
  },
  {
    when: 'THU 08:00',
    subject: 'Unpaid commissions reminder',
    preview: '14 transactions over 90 days old across CJ and Rakuten. Chase or write off.',
    accent: color.pending,
    tag: 'unpaid',
  },
];

export const Schedule: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const head = riseIn(frame, fps, 0, 24);

  return (
    <AbsoluteFill style={{ background: color.ink }}>
      <Halftone dark opacity={0.08} />
      <AbsoluteFill style={{ padding: '84px 110px', justifyContent: 'center' }}>
        <div style={{ ...head, marginBottom: 34 }}>
          <SectionLabel onDark accent={color.blueBright}>automation, not just answers</SectionLabel>
          <div
            style={{
              fontFamily: font.display,
              fontWeight: 800,
              fontSize: 62,
              textTransform: 'lowercase',
              letterSpacing: '-0.03em',
              color: color.paper,
              marginTop: 16,
            }}
          >
            it works the days you don't.
          </div>
          <div style={{ fontFamily: font.sans, fontWeight: 500, fontSize: 29, color: color.fgInvertMut, marginTop: 12, maxWidth: 62 * 18 }}>
            Reports run on a schedule on the hosted server, laptop shut. The
            digests and anomaly checks arrive in your inbox before you open one.
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 1500 }}>
          {MAILS.map((m, i) => {
            const delay = 28 + i * 14;
            const sp = spring({ frame: frame - delay, fps, config: { damping: 200, mass: 0.6, stiffness: 110 } });
            return (
              <div
                key={m.subject}
                style={{
                  opacity: sp,
                  transform: `translateX(${interpolate(sp, [0, 1], [-40, 0])}px)`,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 22,
                  background: color.paper,
                  border: `3px solid ${color.ink}`,
                  borderLeft: `12px solid ${m.accent}`,
                  borderRadius: 10,
                  boxShadow: shadow.hard,
                  padding: '20px 26px',
                }}
              >
                <div
                  style={{
                    fontFamily: font.mono,
                    fontWeight: 800,
                    fontSize: 20,
                    letterSpacing: '0.06em',
                    color: color.paper,
                    background: color.ink,
                    borderRadius: 6,
                    padding: '10px 12px',
                    minWidth: 128,
                    textAlign: 'center',
                  }}
                >
                  {m.when}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ fontFamily: font.sans, fontWeight: 700, fontSize: 29, color: color.ink }}>{m.subject}</span>
                    <span
                      style={{
                        fontFamily: font.mono,
                        fontWeight: 800,
                        fontSize: 15,
                        letterSpacing: '0.1em',
                        textTransform: 'uppercase',
                        color: color.paper,
                        background: m.accent,
                        padding: '3px 8px',
                        borderRadius: 4,
                      }}
                    >
                      {m.tag}
                    </span>
                  </div>
                  <div style={{ fontFamily: font.sans, fontSize: 23, color: color.smudgeDk, marginTop: 4 }}>{m.preview}</div>
                </div>
              </div>
            );
          })}
        </div>

        <div
          style={{
            opacity: fadeIn(frame, 80, 14),
            marginTop: 24,
            fontFamily: font.mono,
            fontWeight: 700,
            fontSize: 22,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: color.fgInvertMut,
          }}
        >
          weekly digest on solo · anomaly + unpaid-commission watch on pro
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
