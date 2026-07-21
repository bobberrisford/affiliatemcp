import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';
import { color, font, shadow } from '../../theme';
import { Halftone, SectionLabel } from '../../components/primitives';
import { riseIn } from '../../anim';

// Simplified to three steps: sign in, connect, ask.
const STEPS = [
  { n: '1', title: 'sign in by email', body: 'A single-use link. No password.' },
  { n: '2', title: 'connect networks', body: 'A guided dashboard, keys encrypted.' },
  { n: '3', title: 'just ask', body: 'Add it to Claude and go.' },
];

export const Onboarding: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const head = riseIn(frame, fps, 0, 24);
  const line = interpolate(frame, [30, 96], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{ background: color.paper }}>
      <Halftone opacity={0.05} />
      <AbsoluteFill style={{ justifyContent: 'center', padding: '0 130px', paddingBottom: 120 }}>
        <div style={{ ...head, marginBottom: 54, textAlign: 'center' }}>
          <div style={{ display: 'inline-block' }}>
            <SectionLabel accent={color.blue}>getting started</SectionLabel>
          </div>
          <div
            style={{
              fontFamily: font.display,
              fontWeight: 800,
              fontSize: 64,
              textTransform: 'lowercase',
              letterSpacing: '-0.03em',
              color: color.ink,
              marginTop: 16,
            }}
          >
            email to answers, in three steps.
          </div>
        </div>

        <div style={{ position: 'relative' }}>
          <div style={{ position: 'absolute', top: 35, left: 90, right: 90, height: 4, background: color.paper2, border: '1px solid rgba(11,11,12,0.14)' }} />
          <div style={{ position: 'absolute', top: 35, left: 90, width: `calc((100% - 180px) * ${line})`, height: 4, background: color.blue }} />

          <div style={{ display: 'flex', gap: 26, position: 'relative' }}>
            {STEPS.map((s, i) => {
              const sp = spring({ frame: frame - (30 + i * 16), fps, config: { damping: 200, mass: 0.6, stiffness: 110 } });
              return (
                <div key={s.n} style={{ flex: 1, opacity: sp, transform: `translateY(${interpolate(sp, [0, 1], [34, 0])}px)` }}>
                  <div
                    style={{
                      width: 74, height: 74, borderRadius: 999, background: color.blue, color: color.paper,
                      border: `4px solid ${color.paper}`, boxShadow: `0 0 0 3px ${color.ink}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontFamily: font.display, fontWeight: 800, fontSize: 36, margin: '0 auto 24px',
                    }}
                  >
                    {s.n}
                  </div>
                  <div style={{ background: color.paper, border: `3px solid ${color.ink}`, borderRadius: 12, boxShadow: shadow.hard, padding: '26px 26px', textAlign: 'center' }}>
                    <div style={{ fontFamily: font.display, fontWeight: 800, fontSize: 34, textTransform: 'lowercase', letterSpacing: '-0.02em', color: color.ink, marginBottom: 10 }}>
                      {s.title}
                    </div>
                    <div style={{ fontFamily: font.sans, fontSize: 25, lineHeight: 1.4, color: color.smudgeDk }}>{s.body}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
