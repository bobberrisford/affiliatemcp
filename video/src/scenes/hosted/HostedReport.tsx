import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';
import { color, font, statusColor } from '../../theme';
import { Halftone, SectionLabel } from '../../components/primitives';
import { ChatFrame, UserBubble, AssistantRow, ToolCall } from '../../components/ChatFrame';
import { riseIn, fadeIn, typed, countUp, gbp } from '../../anim';

const PROMPT = 'Show my unpaid commissions on Awin from the last 30 days.';

const ROWS = [
  { adv: 'Northwind Outdoors', ref: 'A-40118', days: 41, amt: 128.4 },
  { adv: 'Globex Home', ref: 'A-39902', days: 37, amt: 96.15 },
  { adv: 'Acme Supplies', ref: 'A-39755', days: 33, amt: 74.9 },
  { adv: 'Initech Store', ref: 'A-39640', days: 31, amt: 52.2 },
];
const TOTAL = ROWS.reduce((s, r) => s + r.amt, 0);

export const HostedReport: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const promptText = typed(frame, PROMPT, 8, 1.7);
  const showCaret = frame < 8 + PROMPT.length / 1.7 + 4;

  return (
    <AbsoluteFill style={{ background: color.paper2 }}>
      <Halftone opacity={0.05} />
      <AbsoluteFill style={{ padding: '54px 100px' }}>
        <div style={{ ...riseIn(frame, fps, 0, 20), marginBottom: 20 }}>
          <SectionLabel accent={color.blue}>a real report, running in the cloud</SectionLabel>
        </div>

        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <ChatFrame title="claude · affiliate-mcp connector">
            {/* connected badge */}
            <div
              style={{
                opacity: fadeIn(frame, 0, 8),
                display: 'inline-flex',
                alignItems: 'center',
                gap: 10,
                fontFamily: font.mono,
                fontWeight: 700,
                fontSize: 19,
                color: color.blue,
                background: color.paper2,
                border: `2px solid ${color.blue}`,
                borderRadius: 999,
                padding: '6px 14px',
                marginBottom: 22,
              }}
            >
              <span style={{ width: 11, height: 11, borderRadius: 999, background: color.blue }} />
              connected via OAuth · keys stay in the dashboard
            </div>

            <UserBubble>
              {promptText}
              {showCaret && <span style={{ opacity: frame % 16 < 8 ? 1 : 0 }}>▍</span>}
            </UserBubble>

            <div style={{ opacity: fadeIn(frame, 48, 10), marginTop: 26 }}>
              <AssistantRow>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18, alignItems: 'center' }}>
                  <span style={{ fontFamily: font.mono, fontSize: 19, color: color.smudgeDk }}>on the hosted server:</span>
                  <span style={{ opacity: fadeIn(frame, 56, 8) }}>
                    <ToolCall label="affiliate_awin_list_transactions" done={frame > 82} />
                  </span>
                </div>

                <div style={{ opacity: fadeIn(frame, 88, 10) }}>
                  <div style={{ fontFamily: font.sans, fontSize: 26, color: color.ink, marginBottom: 4 }}>
                    You have{' '}
                    <span style={{ fontWeight: 700 }}>{ROWS.length} unpaid commissions</span> on Awin,
                    totalling
                  </div>
                  <div style={{ fontFamily: font.display, fontWeight: 800, fontSize: 72, letterSpacing: '-0.03em', color: color.blue, lineHeight: 1.1 }}>
                    {gbp(countUp(frame, TOTAL, 88, 30))}
                  </div>
                </div>

                {/* table */}
                <div style={{ marginTop: 16 }}>
                  <div style={{ display: 'flex', fontFamily: font.mono, fontWeight: 700, fontSize: 17, letterSpacing: '0.08em', textTransform: 'uppercase', color: color.smudgeDk, borderBottom: `2px solid ${color.ink}`, paddingBottom: 8 }}>
                    <span style={{ flex: 2 }}>advertiser</span>
                    <span style={{ flex: 1 }}>ref</span>
                    <span style={{ flex: 1, textAlign: 'center' }}>age</span>
                    <span style={{ flex: 1, textAlign: 'right' }}>amount</span>
                  </div>
                  {ROWS.map((r, i) => {
                    const delay = 104 + i * 8;
                    const op = fadeIn(frame, delay, 8);
                    return (
                      <div
                        key={r.ref}
                        style={{
                          opacity: op,
                          transform: `translateX(${interpolate(op, [0, 1], [-16, 0])}px)`,
                          display: 'flex',
                          alignItems: 'center',
                          fontFamily: font.sans,
                          fontSize: 24,
                          color: color.ink,
                          padding: '11px 0',
                          borderBottom: `1px solid rgba(11,11,12,0.12)`,
                        }}
                      >
                        <span style={{ flex: 2, fontWeight: 600 }}>{r.adv}</span>
                        <span style={{ flex: 1, fontFamily: font.mono, color: color.smudgeDk }}>{r.ref}</span>
                        <span style={{ flex: 1, textAlign: 'center' }}>
                          <span
                            style={{
                              fontFamily: font.mono,
                              fontWeight: 700,
                              fontSize: 19,
                              color: color.pending,
                              border: `2px solid ${color.pending}`,
                              borderRadius: 999,
                              padding: '2px 10px',
                            }}
                          >
                            {r.days}d
                          </span>
                        </span>
                        <span style={{ flex: 1, textAlign: 'right', fontFamily: font.mono, fontWeight: 700, color: statusColor.pending }}>
                          {gbp(r.amt)}
                        </span>
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
