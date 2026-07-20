import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';
import { color, font } from '../theme';
import { Halftone, SectionLabel } from '../components/primitives';
import { NETWORKS } from '../data';
import { riseIn, countUp } from '../anim';

const Counter: React.FC<{ frame: number; value: number; label: string; accent: string }> = ({
  frame,
  value,
  label,
  accent,
}) => (
  <div style={{ textAlign: 'center' }}>
    <div
      style={{
        fontFamily: font.display,
        fontWeight: 800,
        fontSize: 130,
        lineHeight: 0.9,
        letterSpacing: '-0.04em',
        color: accent,
      }}
    >
      {Math.round(countUp(frame, value, 6, 34))}
    </div>
    <div
      style={{
        fontFamily: font.mono,
        fontWeight: 700,
        fontSize: 22,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: color.paper,
        marginTop: 6,
      }}
    >
      {label}
    </div>
  </div>
);

export const Scale: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const head = riseIn(frame, fps, 0, 24);

  return (
    <AbsoluteFill style={{ background: color.ink }}>
      <Halftone dark opacity={0.07} />
      <AbsoluteFill style={{ padding: '80px 100px' }}>
        <div style={head}>
          <SectionLabel onDark>the breadth</SectionLabel>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 90,
            margin: '18px 0 30px',
          }}
        >
          <Counter frame={frame} value={86} label="adapters" accent={color.blueBright} />
          <div style={{ fontFamily: font.display, fontSize: 70, color: color.smudge }}>×</div>
          <Counter frame={frame} value={72} label="network families" accent={color.magenta} />
        </div>

        {/* the network wall */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 12,
            justifyContent: 'center',
            alignContent: 'center',
            flex: 1,
            maxWidth: 1640,
            margin: '0 auto',
          }}
        >
          {NETWORKS.map((n, i) => {
            const delay = 30 + i * 1.15;
            const s = spring({
              frame: frame - delay,
              fps,
              config: { damping: 200, mass: 0.5, stiffness: 120 },
            });
            const highlight = ['Awin', 'CJ Affiliate', 'Impact', 'Rakuten', 'eBay'].includes(n);
            return (
              <span
                key={n}
                style={{
                  opacity: s,
                  transform: `scale(${interpolate(s, [0, 1], [0.6, 1])})`,
                  fontFamily: font.mono,
                  fontWeight: 700,
                  fontSize: 24,
                  letterSpacing: '0.02em',
                  padding: '9px 15px',
                  borderRadius: 6,
                  border: `2px solid ${highlight ? color.blue : color.lineInvert}`,
                  background: highlight ? color.blue : 'transparent',
                  color: highlight ? color.paper : color.fgInvertMut,
                  whiteSpace: 'nowrap',
                }}
              >
                {n}
              </span>
            );
          })}
        </div>

        <div
          style={{
            opacity: interpolate(frame, [128, 142], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
            textAlign: 'center',
            fontFamily: font.sans,
            fontWeight: 500,
            fontSize: 28,
            color: color.fgInvertMut,
            marginTop: 24,
          }}
        >
          Publisher <span style={{ color: color.blueBright, fontWeight: 700 }}>and</span> advertiser
          sides. Public beta — maturity varies, and it's honest about which is which.
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
