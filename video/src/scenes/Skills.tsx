import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { color, font, shadow } from '../theme';
import { Halftone, SectionLabel } from '../components/primitives';
import { riseIn } from '../anim';

const SKILLS = [
  { side: 'PUB', q: '“What did I earn last month?”', name: 'affiliate-earnings-report', accent: color.blue },
  { side: 'PUB', q: '“Are all my networks healthy?”', name: 'affiliate-network-status', accent: color.blue },
  { side: 'PUB', q: '“Audit the links in my sitemap.”', name: 'audit-affiliate-links', accent: color.blue },
  { side: 'PUB', q: '“Help me set up Awin.”', name: 'affiliate-network-setup-help', accent: color.blue },
  { side: 'BRAND', q: '“How is Acme doing this quarter?”', name: 'programme-performance-report', accent: color.magenta },
  { side: 'BRAND', q: '“Revenue across all my clients?”', name: 'agency-portfolio-rollup', accent: color.magenta },
  { side: 'BRAND', q: '“Any anomalies this week?”', name: 'programme-anomaly-watch', accent: color.magenta },
];

export const Skills: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const head = riseIn(frame, fps, 0, 24);

  return (
    <AbsoluteFill style={{ background: color.paper }}>
      <Halftone opacity={0.05} />
      <AbsoluteFill style={{ padding: '72px 100px' }}>
        <div style={head}>
          <SectionLabel>packaged skills</SectionLabel>
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
            you don't invoke them. you just ask.
          </div>
          <div style={{ fontFamily: font.sans, fontSize: 27, color: color.smudgeDk, marginTop: 10 }}>
            Pre-written conversation patterns — Claude picks the right one from what you type.
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 34 }}>
          {SKILLS.map((s, i) => {
            const a = riseIn(frame, fps, 24 + i * 8, 34);
            return (
              <div
                key={s.name}
                style={{
                  ...a,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 18,
                  background: color.paper,
                  border: `2.5px solid ${color.ink}`,
                  borderRadius: 8,
                  boxShadow: shadow.hard,
                  padding: '18px 22px',
                }}
              >
                <span
                  style={{
                    fontFamily: font.mono,
                    fontWeight: 800,
                    fontSize: 17,
                    letterSpacing: '0.1em',
                    background: s.accent,
                    color: color.paper,
                    padding: '5px 10px',
                    borderRadius: 4,
                    flex: '0 0 auto',
                  }}
                >
                  {s.side}
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: font.sans, fontWeight: 700, fontSize: 27, color: color.ink }}>
                    {s.q}
                  </div>
                  <div style={{ fontFamily: font.mono, fontSize: 19, color: color.smudgeDk, marginTop: 2 }}>
                    → {s.name}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
