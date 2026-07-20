import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';
import { color, font, shadow } from '../../theme';
import { Halftone, SectionLabel } from '../../components/primitives';
import { riseIn } from '../../anim';

// The five-step hosted flow, wording aligned with site/hosted.html.
const STEPS = [
  { n: '1', title: 'sign in by email', body: 'A single-use link, no password to set.' },
  { n: '2', title: 'connect networks', body: 'Guided form, keys encrypted, live-tested on save.' },
  { n: '3', title: 'start free', body: '3 reports a week on your own data, no card.' },
  { n: '4', title: 'add it to Claude', body: 'Approve one connector by browser. No token to paste.' },
  { n: '5', title: 'run a report', body: '“Summarise last month’s earnings.” Done.' },
];

export const Onboarding: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const head = riseIn(frame, fps, 0, 24);

  // progress line growth across the rail
  const line = interpolate(frame, [30, 110], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{ background: color.paper }}>
      <Halftone opacity={0.05} />
      <AbsoluteFill style={{ padding: '84px 90px', justifyContent: 'center' }}>
        <div style={{ ...head, marginBottom: 46 }}>
          <SectionLabel accent={color.blue}>five steps, about ten minutes</SectionLabel>
          <div
            style={{
              fontFamily: font.display,
              fontWeight: 800,
              fontSize: 62,
              textTransform: 'lowercase',
              letterSpacing: '-0.03em',
              color: color.ink,
              marginTop: 14,
            }}
          >
            email to answers, no code in between.
          </div>
        </div>

        <div style={{ position: 'relative' }}>
          {/* connector rail */}
          <div
            style={{
              position: 'absolute',
              top: 33,
              left: 60,
              right: 60,
              height: 4,
              background: color.paper2,
              border: `1px solid rgba(11,11,12,0.14)`,
            }}
          />
          <div
            style={{
              position: 'absolute',
              top: 33,
              left: 60,
              width: `calc((100% - 120px) * ${line})`,
              height: 4,
              background: color.blue,
            }}
          />

          <div style={{ display: 'flex', gap: 18, position: 'relative' }}>
            {STEPS.map((s, i) => {
              const delay = 30 + i * 14;
              const sp = spring({ frame: frame - delay, fps, config: { damping: 200, mass: 0.6, stiffness: 110 } });
              return (
                <div key={s.n} style={{ flex: 1, opacity: sp, transform: `translateY(${interpolate(sp, [0, 1], [30, 0])}px)` }}>
                  <div
                    style={{
                      width: 70,
                      height: 70,
                      borderRadius: 999,
                      background: color.blue,
                      color: color.paper,
                      border: `4px solid ${color.paper}`,
                      boxShadow: `0 0 0 3px ${color.ink}`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontFamily: font.display,
                      fontWeight: 800,
                      fontSize: 34,
                      margin: '0 auto 20px',
                    }}
                  >
                    {s.n}
                  </div>
                  <div
                    style={{
                      background: color.paper,
                      border: `3px solid ${color.ink}`,
                      borderRadius: 10,
                      boxShadow: shadow.hard,
                      padding: '20px 20px',
                      minHeight: 190,
                    }}
                  >
                    <div
                      style={{
                        fontFamily: font.display,
                        fontWeight: 800,
                        fontSize: 27,
                        textTransform: 'lowercase',
                        letterSpacing: '-0.01em',
                        color: color.ink,
                        marginBottom: 10,
                      }}
                    >
                      {s.title}
                    </div>
                    <div style={{ fontFamily: font.sans, fontSize: 21, lineHeight: 1.4, color: color.smudgeDk }}>
                      {s.body}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div
          style={{
            opacity: interpolate(frame, [120, 134], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
            marginTop: 34,
            textAlign: 'center',
            fontFamily: font.mono,
            fontWeight: 700,
            fontSize: 24,
            letterSpacing: '0.04em',
            color: color.smudgeDk,
          }}
        >
          nothing to copy or paste, at any step.
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
