import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';
import { color, font, statusColor } from '../theme';
import { Halftone, SectionLabel } from '../components/primitives';
import { ChatFrame, UserBubble, AssistantRow, ToolCall } from '../components/ChatFrame';
import { riseIn, fadeIn, typed, countUp, gbp } from '../anim';

const EARNINGS = [
  { network: 'Impact', value: 3540 },
  { network: 'Awin', value: 4182 },
  { network: 'CJ Affiliate', value: 2910 },
  { network: 'Rakuten', value: 2088 },
  { network: 'Skimlinks', value: 1225 },
];
const TOTAL = EARNINGS.reduce((s, e) => s + e.value, 0);
const MAX = Math.max(...EARNINGS.map((e) => e.value));

const STATUS = [
  { label: 'approved', value: 6120, key: 'approved' as const },
  { label: 'paid', value: 4980, key: 'paid' as const },
  { label: 'pending', value: 2410, key: 'pending' as const },
  { label: 'reversed', value: 435, key: 'reversed' as const },
];

const PROMPT = 'What did I earn across all my networks last month?';

export const PublisherDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const promptText = typed(frame, PROMPT, 8, 1.7);
  const showCaret = frame < 8 + PROMPT.length / 1.7 + 4;

  const tools = ['list_transactions', 'get_earnings_summary'];

  return (
    <AbsoluteFill style={{ background: color.paper2 }}>
      <Halftone opacity={0.05} />
      <AbsoluteFill style={{ padding: '54px 100px' }}>
        <div style={{ ...riseIn(frame, fps, 0, 20), marginBottom: 22 }}>
          <SectionLabel accent={color.blue}>publisher · one question, every network</SectionLabel>
        </div>

        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <ChatFrame title="your AI workspace">
            {/* user prompt */}
            <UserBubble>
              {promptText}
              {showCaret && <span style={{ opacity: frame % 16 < 8 ? 1 : 0 }}>▍</span>}
            </UserBubble>

            {/* assistant */}
            <div style={{ opacity: fadeIn(frame, 44, 10), marginTop: 26 }}>
              <AssistantRow>
                {/* tool calls fanning out */}
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
                  <span
                    style={{
                      fontFamily: font.mono,
                      fontSize: 19,
                      color: color.smudgeDk,
                      alignSelf: 'center',
                    }}
                  >
                    calling 5 networks in parallel:
                  </span>
                  {tools.map((t, i) => (
                    <span key={t} style={{ opacity: fadeIn(frame, 52 + i * 8, 8) }}>
                      <ToolCall label={t} done={frame > 78} />
                    </span>
                  ))}
                </div>

                {/* headline total */}
                <div style={{ opacity: fadeIn(frame, 84, 10) }}>
                  <div style={{ fontFamily: font.sans, fontSize: 26, color: color.ink }}>
                    Across 5 networks last month you earned
                  </div>
                  <div
                    style={{
                      fontFamily: font.display,
                      fontWeight: 800,
                      fontSize: 88,
                      letterSpacing: '-0.03em',
                      color: color.blue,
                      lineHeight: 1.05,
                    }}
                  >
                    {gbp(countUp(frame, TOTAL, 88, 34))}
                  </div>
                </div>

                {/* by-network bars */}
                <div style={{ display: 'flex', gap: 40, marginTop: 18 }}>
                  <div style={{ flex: 1.15 }}>
                    <ColHead>by network</ColHead>
                    {EARNINGS.map((e, i) => {
                      const delay = 104 + i * 7;
                      const w = interpolate(
                        spring({ frame: frame - delay, fps, config: { damping: 200, stiffness: 90 } }),
                        [0, 1],
                        [0, (e.value / MAX) * 100],
                      );
                      return (
                        <div key={e.network} style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 11 }}>
                          <span style={{ width: 180, fontFamily: font.mono, fontWeight: 700, fontSize: 21, color: color.ink }}>
                            {e.network}
                          </span>
                          <div style={{ flex: 1, height: 26, background: color.paper2, borderRadius: 3, border: `1.5px solid ${color.ink}` }}>
                            <div style={{ width: `${w}%`, height: '100%', background: color.blue }} />
                          </div>
                          <span style={{ width: 110, textAlign: 'right', fontFamily: font.mono, fontWeight: 700, fontSize: 21, color: color.ink }}>
                            {gbp(countUp(frame, e.value, delay, 24))}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  {/* status split */}
                  <div style={{ flex: 0.85 }}>
                    <ColHead>by status</ColHead>
                    {STATUS.map((s, i) => {
                      const delay = 120 + i * 6;
                      const w = interpolate(
                        spring({ frame: frame - delay, fps, config: { damping: 200, stiffness: 90 } }),
                        [0, 1],
                        [0, (s.value / STATUS[0].value) * 100],
                      );
                      return (
                        <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 11 }}>
                          <span style={{ width: 130, fontFamily: font.mono, fontWeight: 700, fontSize: 20, color: statusColor[s.key], textTransform: 'uppercase' }}>
                            {s.label}
                          </span>
                          <div style={{ flex: 1, height: 26, background: color.paper2, borderRadius: 3, border: `1.5px solid ${color.ink}` }}>
                            <div style={{ width: `${w}%`, height: '100%', background: statusColor[s.key] }} />
                          </div>
                          <span style={{ width: 95, textAlign: 'right', fontFamily: font.mono, fontWeight: 700, fontSize: 20, color: color.ink }}>
                            {gbp(countUp(frame, s.value, delay, 22))}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* flagged callout */}
                <div
                  style={{
                    opacity: fadeIn(frame, 168, 12),
                    transform: `translateY(${interpolate(fadeIn(frame, 168, 12), [0, 1], [16, 0])}px)`,
                    marginTop: 18,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    background: color.magenta,
                    color: color.paper,
                    borderRadius: 8,
                    padding: '14px 20px',
                    border: `3px solid ${color.ink}`,
                    boxShadow: `4px 4px 0 0 ${color.ink}`,
                  }}
                >
                  <span style={{ fontFamily: font.mono, fontWeight: 800, fontSize: 22, letterSpacing: '0.1em' }}>
                    ⚑ FLAGGED
                  </span>
                  <span style={{ fontFamily: font.sans, fontWeight: 500, fontSize: 24 }}>
                    £1,180 across 14 transactions still pending after 90 days on CJ &amp; Rakuten.
                  </span>
                </div>
              </AssistantRow>
            </div>
          </ChatFrame>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const ColHead: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      fontFamily: font.mono,
      fontWeight: 700,
      fontSize: 18,
      letterSpacing: '0.14em',
      textTransform: 'uppercase',
      color: color.smudgeDk,
      marginBottom: 12,
    }}
  >
    {children}
  </div>
);
