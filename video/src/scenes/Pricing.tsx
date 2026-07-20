import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';
import { color, font, shadow } from '../theme';
import { Halftone, SectionLabel } from '../components/primitives';
import { riseIn, fadeIn } from '../anim';

// Tiers and copy mirror site/hosted.html and the accepted freemium decision
// (2026-07-18). Free is not a Stripe object; paid tiers add automation and
// assurance, never access to a user's own data.
type Tier = {
  name: string;
  price: string;
  per: string;
  who: string;
  points: string[];
  featured?: boolean;
};

const TIERS: Tier[] = [
  {
    name: 'free',
    price: '£0',
    per: 'no card',
    who: 'Try it on your own data before you pay anything.',
    points: ['Ask about your own data in Claude', '3 reports a week', 'No commitment'],
  },
  {
    name: 'solo',
    price: '£34',
    per: 'per month',
    who: 'Multi-network publishers who want earnings in one place.',
    points: ['No weekly cap', 'Up to 5 networks', 'Weekly earnings digest'],
    featured: true,
  },
  {
    name: 'pro',
    price: '£99',
    per: 'per month',
    who: 'Advertisers, agency staff, and serious publishers.',
    points: ['All networks', 'Scheduled anomaly watch + digests', 'QBR actions · CSV export'],
  },
];

export const Pricing: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const head = riseIn(frame, fps, 0, 24);

  return (
    <AbsoluteFill style={{ background: color.paper }}>
      <Halftone opacity={0.05} />
      <AbsoluteFill style={{ padding: '72px 100px' }}>
        <div style={head}>
          <SectionLabel accent={color.magenta}>where it pays for itself</SectionLabel>
          <div
            style={{
              fontFamily: font.display,
              fontWeight: 800,
              fontSize: 60,
              textTransform: 'lowercase',
              letterSpacing: '-0.03em',
              color: color.ink,
              marginTop: 14,
            }}
          >
            start free. pay for automation, not for your own data.
          </div>
        </div>

        <div style={{ display: 'flex', gap: 22, marginTop: 34, alignItems: 'stretch' }}>
          {TIERS.map((t, i) => {
            const s = spring({ frame: frame - (26 + i * 12), fps, config: { damping: 200, stiffness: 95 } });
            return (
              <div
                key={t.name}
                style={{
                  opacity: s,
                  transform: `translateY(${interpolate(s, [0, 1], [46, 0])}px)`,
                  flex: 1,
                  background: t.featured ? color.blue : color.paper,
                  color: t.featured ? color.paper : color.ink,
                  border: `3px solid ${color.ink}`,
                  borderRadius: 12,
                  boxShadow: t.featured ? shadow.hardLg : shadow.hard,
                  padding: '30px 32px',
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span
                    style={{
                      fontFamily: font.display,
                      fontWeight: 800,
                      fontSize: 34,
                      textTransform: 'lowercase',
                      letterSpacing: '-0.02em',
                    }}
                  >
                    {t.name}
                  </span>
                  {t.featured ? (
                    <span
                      style={{
                        fontFamily: font.mono,
                        fontWeight: 800,
                        fontSize: 15,
                        letterSpacing: '0.12em',
                        textTransform: 'uppercase',
                        background: color.magenta,
                        color: color.paper,
                        padding: '4px 9px',
                        borderRadius: 4,
                      }}
                    >
                      popular
                    </span>
                  ) : null}
                </div>

                <div style={{ marginTop: 14, display: 'flex', alignItems: 'baseline', gap: 10 }}>
                  <span style={{ fontFamily: font.display, fontWeight: 800, fontSize: 62, letterSpacing: '-0.03em', lineHeight: 1 }}>
                    {t.price}
                  </span>
                  <span
                    style={{
                      fontFamily: font.mono,
                      fontWeight: 700,
                      fontSize: 18,
                      letterSpacing: '0.06em',
                      textTransform: 'uppercase',
                      color: t.featured ? 'rgba(255,255,255,0.85)' : color.smudgeDk,
                    }}
                  >
                    {t.per}
                  </span>
                </div>

                <div
                  style={{
                    fontFamily: font.sans,
                    fontSize: 22,
                    lineHeight: 1.4,
                    color: t.featured ? 'rgba(255,255,255,0.92)' : color.smudgeDk,
                    margin: '12px 0 18px',
                    minHeight: 62,
                  }}
                >
                  {t.who}
                </div>

                <div style={{ borderTop: `2px solid ${t.featured ? color.lineInvert : color.ink}`, paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {t.points.map((p) => (
                    <div key={p} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                      <span style={{ fontFamily: font.mono, fontWeight: 800, fontSize: 22, color: t.featured ? color.paper : color.blue, lineHeight: 1.2 }}>
                        &gt;
                      </span>
                      <span style={{ fontFamily: font.sans, fontWeight: 500, fontSize: 23, lineHeight: 1.25 }}>{p}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <div
          style={{
            opacity: fadeIn(frame, 74, 14),
            marginTop: 28,
            fontFamily: font.sans,
            fontWeight: 500,
            fontSize: 27,
            color: color.smudgeDk,
          }}
        >
          Card only at conversion, cancel any time.{' '}
          <span style={{ color: color.ink, fontWeight: 700 }}>
            The free, open-source local server still does everything, for every network.
          </span>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
