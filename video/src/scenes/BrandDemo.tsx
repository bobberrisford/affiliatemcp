import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import { color, font } from '../theme';
import { Halftone, SectionLabel } from '../components/primitives';
import { ChatFrame, UserBubble, AssistantRow, ToolCall } from '../components/ChatFrame';
import { riseIn, fadeIn, typed } from '../anim';

const PROMPT = 'Any anomalies across my clients this week?';

type Anom = {
  tag: string;
  brand: string;
  headline: string;
  detail: string;
  delta: string;
  accent: string;
};

const ANOMALIES: Anom[] = [
  {
    tag: 'REVENUE DROP',
    brand: 'Acme · Awin',
    headline: 'Revenue down 34% wk/wk',
    detail: '£18.2k → £12.0k. Two top publishers went quiet.',
    delta: '−34%',
    accent: color.magenta,
  },
  {
    tag: 'REVERSAL SPIKE',
    brand: 'Northwind · Impact',
    headline: 'Reversals 3.1× baseline',
    detail: '£4,050 reversed vs £1,300 typical. Likely returns batch.',
    delta: '×3.1',
    accent: color.magenta,
  },
  {
    tag: 'TOP-10 DROPOUT',
    brand: 'Globex · CJ',
    headline: '2 top-10 publishers dropped out',
    detail: 'No clicks in 9 days from previously active partners.',
    delta: '−2',
    accent: color.pending,
  },
  {
    tag: 'DEAD PROGRAMME',
    brand: 'Initech · Rakuten',
    headline: 'Programme drifting toward zero',
    detail: '4 straight weeks declining. £120 this week.',
    delta: '↓↓',
    accent: color.pending,
  },
];

export const BrandDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const promptText = typed(frame, PROMPT, 8, 1.7);
  const showCaret = frame < 8 + PROMPT.length / 1.7 + 4;

  return (
    <AbsoluteFill style={{ background: color.paper }}>
      <Halftone opacity={0.05} />
      <AbsoluteFill style={{ padding: '54px 100px' }}>
        <div style={{ ...riseIn(frame, fps, 0, 20), marginBottom: 22 }}>
          <SectionLabel accent={color.magenta}>brand &amp; agency · catches what dashboards bury</SectionLabel>
        </div>

        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <ChatFrame title="your AI workspace — scheduled weekly">
            <UserBubble>
              {promptText}
              {showCaret && <span style={{ opacity: frame % 16 < 8 ? 1 : 0 }}>▍</span>}
            </UserBubble>

            <div style={{ opacity: fadeIn(frame, 44, 10), marginTop: 26 }}>
              <AssistantRow>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20, alignItems: 'center' }}>
                  <span style={{ fontFamily: font.mono, fontSize: 19, color: color.smudgeDk }}>
                    week-over-week scan across 4 brands:
                  </span>
                  <span style={{ opacity: fadeIn(frame, 52, 8) }}>
                    <ToolCall label="agency-portfolio-rollup" done={frame > 74} />
                  </span>
                  <span style={{ opacity: fadeIn(frame, 60, 8) }}>
                    <ToolCall label="programme-anomaly-watch" done={frame > 80} />
                  </span>
                </div>

                <div
                  style={{
                    opacity: fadeIn(frame, 84, 10),
                    fontFamily: font.sans,
                    fontSize: 26,
                    color: color.ink,
                    marginBottom: 18,
                  }}
                >
                  <span style={{ fontWeight: 700 }}>4 things need attention</span> — surfaced,
                  not buried in four dashboards:
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  {ANOMALIES.map((a, i) => {
                    const delay = 96 + i * 12;
                    const op = fadeIn(frame, delay, 12);
                    return (
                      <div
                        key={a.tag}
                        style={{
                          opacity: op,
                          transform: `translateY(${interpolate(op, [0, 1], [24, 0])}px)`,
                          background: color.paper,
                          border: `3px solid ${color.ink}`,
                          borderRadius: 10,
                          borderLeft: `12px solid ${a.accent}`,
                          boxShadow: `4px 4px 0 0 ${color.ink}`,
                          padding: '18px 22px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 18,
                        }}
                      >
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 6 }}>
                            <span
                              style={{
                                fontFamily: font.mono,
                                fontWeight: 800,
                                fontSize: 17,
                                letterSpacing: '0.1em',
                                color: color.paper,
                                background: a.accent,
                                padding: '3px 9px',
                                borderRadius: 4,
                              }}
                            >
                              {a.tag}
                            </span>
                            <span style={{ fontFamily: font.mono, fontSize: 18, color: color.smudgeDk }}>
                              {a.brand}
                            </span>
                          </div>
                          <div style={{ fontFamily: font.sans, fontWeight: 700, fontSize: 25, color: color.ink }}>
                            {a.headline}
                          </div>
                          <div style={{ fontFamily: font.sans, fontSize: 20, color: color.smudgeDk, marginTop: 2 }}>
                            {a.detail}
                          </div>
                        </div>
                        <div
                          style={{
                            fontFamily: font.display,
                            fontWeight: 800,
                            fontSize: 42,
                            letterSpacing: '-0.02em',
                            color: a.accent,
                          }}
                        >
                          {a.delta}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </AssistantRow>
            </div>
          </ChatFrame>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
