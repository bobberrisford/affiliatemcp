import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';
import { color, font, shadow } from '../theme';
import { Halftone, SectionLabel } from '../components/primitives';
import { Mark } from '../components/Mark';
import { riseIn, fadeIn } from '../anim';

const Node: React.FC<{
  a: React.CSSProperties;
  title: string;
  sub: string;
  bg: string;
  fg: string;
  border?: string;
  icon?: React.ReactNode;
}> = ({ a, title, sub, bg, fg, border, icon }) => (
  <div
    style={{
      ...a,
      width: 380,
      background: bg,
      color: fg,
      border: `3px solid ${border ?? color.ink}`,
      borderRadius: 10,
      boxShadow: shadow.hard,
      padding: '28px 30px',
      textAlign: 'center',
    }}
  >
    {icon}
    <div
      style={{
        fontFamily: font.display,
        fontWeight: 800,
        fontSize: 40,
        textTransform: 'lowercase',
        letterSpacing: '-0.02em',
        marginTop: icon ? 12 : 0,
      }}
    >
      {title}
    </div>
    <div style={{ fontFamily: font.mono, fontSize: 21, letterSpacing: '0.04em', marginTop: 8, opacity: 0.85 }}>
      {sub}
    </div>
  </div>
);

// Animated dashed connector that "flows" data left→right.
const Wire: React.FC<{ frame: number; delay: number; reverseLabel: string; label: string }> = ({
  frame,
  delay,
  label,
  reverseLabel,
}) => {
  const grow = interpolate(frame - delay, [0, 18], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const dash = -((frame * 1.4) % 28);
  return (
    <div style={{ position: 'relative', width: 190, height: 90, opacity: grow }}>
      <svg width="190" height="90" style={{ position: 'absolute', inset: 0 }}>
        <line
          x1="0"
          y1="34"
          x2={190 * grow}
          y2="34"
          stroke={color.blue}
          strokeWidth="4"
          strokeDasharray="14 14"
          strokeDashoffset={dash}
        />
        <polygon points={`${190 * grow},34 ${190 * grow - 16},26 ${190 * grow - 16},42`} fill={color.blue} />
      </svg>
      <div
        style={{
          position: 'absolute',
          top: 44,
          width: 190,
          textAlign: 'center',
          fontFamily: font.mono,
          fontSize: 15,
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: color.smudgeDk,
        }}
      >
        {label}
        <div style={{ color: color.magenta }}>↩ {reverseLabel}</div>
      </div>
    </div>
  );
};

export const HowItWorks: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const head = riseIn(frame, fps, 0, 30);

  return (
    <AbsoluteFill style={{ background: color.paper }}>
      <Halftone opacity={0.05} />
      <AbsoluteFill style={{ padding: '90px 100px' }}>
        <div style={head}>
          <SectionLabel>how it works</SectionLabel>
          <div
            style={{
              fontFamily: font.display,
              fontWeight: 800,
              fontSize: 62,
              textTransform: 'lowercase',
              letterSpacing: '-0.03em',
              color: color.ink,
              marginTop: 16,
            }}
          >
            one local MCP server, standing between your chat and every network
          </div>
        </div>

        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 4,
            marginTop: 10,
          }}
        >
          <Node
            a={riseIn(frame, fps, 24, 40)}
            title="your chat"
            sub="Claude · Code · Codex"
            bg={color.ink}
            fg={color.paper}
            border={color.ink}
          />
          <Wire frame={frame} delay={44} label="plain english →" reverseLabel="answers" />
          <Node
            a={{
              opacity: fadeIn(frame, 60, 12),
              transform: `scale(${interpolate(
                spring({ frame: frame - 60, fps, config: { damping: 12, stiffness: 100 } }),
                [0, 1],
                [0.7, 1],
              )})`,
            }}
            title="affiliate-mcp"
            sub="runs on your machine"
            bg={color.blue}
            fg={color.paper}
            border={color.ink}
            icon={
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <div style={{ background: color.paper, borderRadius: 12, padding: 4 }}>
                  <Mark size={54} />
                </div>
              </div>
            }
          />
          <Wire frame={frame} delay={80} label="live API calls →" reverseLabel="your data" />
          <Node
            a={riseIn(frame, fps, 96, 40)}
            title="86 adapters"
            sub="72 network families"
            bg={color.paper}
            fg={color.ink}
            border={color.ink}
          />
        </div>

        <div
          style={{
            opacity: fadeIn(frame, 118, 14),
            fontFamily: font.sans,
            fontWeight: 500,
            fontSize: 30,
            color: color.smudgeDk,
            textAlign: 'center',
          }}
        >
          Ask in plain English. It figures out which networks to call, fetches
          live, and answers. Your keys never leave your machine.
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
