import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import { color, font, shadow } from '../theme';
import { Halftone, SectionLabel, Chip } from '../components/primitives';
import { Mark } from '../components/Mark';
import { riseIn, fadeIn } from '../anim';

// The non-technical, hosted path. Framing and claims mirror site/hosted.html
// and the accepted custody + freemium decisions: no install, keys stay
// encrypted in the dashboard and never reach Claude, local stays free.
const STEPS = [
  {
    n: '1',
    title: 'sign in by email',
    body: 'A one-time link, no password. That identity owns your account.',
  },
  {
    n: '2',
    title: 'connect in the dashboard',
    body: 'A guided form per network, keys encrypted at rest, live-tested on save.',
  },
  {
    n: '3',
    title: 'add it to Claude',
    body: 'Approve a connector by browser. Reports run on a schedule, laptop shut.',
  },
];

export const Hosted: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const head = riseIn(frame, fps, 0, 24);

  return (
    <AbsoluteFill style={{ background: color.ink }}>
      <Halftone dark opacity={0.08} />
      <AbsoluteFill style={{ padding: '78px 100px' }}>
        <div style={head}>
          <SectionLabel onDark accent={color.blueBright}>
            can't self-host? get hosted
          </SectionLabel>
          <div
            style={{
              fontFamily: font.display,
              fontWeight: 800,
              fontSize: 62,
              textTransform: 'lowercase',
              letterSpacing: '-0.03em',
              color: color.paper,
              marginTop: 16,
              maxWidth: 1500,
            }}
          >
            no install. no terminal. no laptop left running.
          </div>
          <div
            style={{
              fontFamily: font.sans,
              fontWeight: 500,
              fontSize: 29,
              color: color.fgInvertMut,
              marginTop: 12,
              maxWidth: 62 * 18,
            }}
          >
            Built for the people the terminal shuts out: agency managers, brand
            managers, and busy publishers. Same answers, running in the cloud.
          </div>
        </div>

        {/* three steps */}
        <div style={{ display: 'flex', gap: 22, marginTop: 34 }}>
          {STEPS.map((s, i) => {
            const a = riseIn(frame, fps, 26 + i * 12, 46);
            return (
              <div
                key={s.n}
                style={{
                  ...a,
                  flex: 1,
                  background: color.inkSoft,
                  border: `2.5px solid ${color.lineInvert}`,
                  borderRadius: 12,
                  padding: '28px 30px',
                }}
              >
                <div
                  style={{
                    fontFamily: font.mono,
                    fontWeight: 800,
                    fontSize: 26,
                    color: color.ink,
                    background: color.blueBright,
                    width: 46,
                    height: 46,
                    borderRadius: 8,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginBottom: 18,
                  }}
                >
                  {s.n}
                </div>
                <div
                  style={{
                    fontFamily: font.display,
                    fontWeight: 800,
                    fontSize: 34,
                    textTransform: 'lowercase',
                    letterSpacing: '-0.02em',
                    color: color.paper,
                    marginBottom: 10,
                  }}
                >
                  {s.title}
                </div>
                <div style={{ fontFamily: font.sans, fontSize: 24, lineHeight: 1.45, color: color.fgInvertMut }}>
                  {s.body}
                </div>
              </div>
            );
          })}
        </div>

        {/* trust + honesty strip */}
        <div
          style={{
            opacity: fadeIn(frame, 74, 14),
            marginTop: 30,
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <Chip variant="blue">keys encrypted, never given to Claude</Chip>
          <Chip variant="ink" style={{ border: `2px solid ${color.lineInvert}` }}>
            4 networks live: awin · cj · impact · rakuten
          </Chip>
          <span
            style={{
              fontFamily: font.sans,
              fontWeight: 700,
              fontSize: 24,
              color: color.paper,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <span style={{ background: color.paper, borderRadius: 8, padding: 3, display: 'inline-flex' }}>
              <Mark size={30} />
            </span>
            local stays free and complete.
          </span>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
