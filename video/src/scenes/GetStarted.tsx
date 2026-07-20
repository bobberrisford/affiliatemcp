import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import { color, font, shadow } from '../theme';
import { Halftone, SectionLabel } from '../components/primitives';
import { Mark } from '../components/Mark';
import { riseIn, fadeIn, typed } from '../anim';

// Two ways in: self-host (free, technical) and hosted (paid convenience,
// non-technical). Both keep credentials off any third party by default.
export const GetStarted: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const head = riseIn(frame, fps, 0, 22);
  const cmd = 'npx affiliate-networks-mcp setup';
  const cmdText = typed(frame, cmd, 40, 1.6);
  const cmdDone = frame > 40 + cmd.length / 1.6;

  const hostSteps = ['email sign-in link', 'connect in the dashboard', 'add the connector'];

  return (
    <AbsoluteFill style={{ background: color.paper2 }}>
      <Halftone opacity={0.05} />
      <AbsoluteFill style={{ padding: '78px 100px', justifyContent: 'center' }}>
        <div style={{ ...head, marginBottom: 34 }}>
          <SectionLabel>get started</SectionLabel>
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
            two ways in. pick the one that fits.
          </div>
        </div>

        <div style={{ display: 'flex', gap: 26 }}>
          {/* self-host track */}
          <div
            style={{
              ...riseIn(frame, fps, 22, 44),
              flex: 1,
              background: color.paper,
              border: `3px solid ${color.ink}`,
              borderRadius: 12,
              boxShadow: shadow.hard,
              padding: '30px 32px',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18 }}>
              <span
                style={{
                  fontFamily: font.mono,
                  fontWeight: 800,
                  fontSize: 18,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  background: color.ink,
                  color: color.paper,
                  padding: '6px 12px',
                  borderRadius: 4,
                }}
              >
                self-host · free
              </span>
              <span style={{ fontFamily: font.sans, fontWeight: 500, fontSize: 24, color: color.smudgeDk }}>
                your machine, your keys
              </span>
            </div>

            <div
              style={{
                background: color.ink,
                borderRadius: 10,
                padding: '22px 24px',
                fontFamily: font.mono,
                fontSize: 26,
                marginBottom: 18,
              }}
            >
              <span style={{ color: color.blueBright }}>$ </span>
              <span style={{ color: color.paper }}>{cmdText}</span>
              {!cmdDone && <span style={{ opacity: frame % 16 < 8 ? 1 : 0, color: color.paper }}>▍</span>}
            </div>

            <div style={{ fontFamily: font.sans, fontSize: 25, lineHeight: 1.5, color: color.ink }}>
              One command, no code. Works with{' '}
              <b>Claude Desktop, Claude Code, and Codex</b>. Every network, all
              86 adapters, forever free.
            </div>
          </div>

          {/* hosted track */}
          <div
            style={{
              ...riseIn(frame, fps, 40, 44),
              flex: 1,
              background: color.blue,
              color: color.paper,
              border: `3px solid ${color.ink}`,
              borderRadius: 12,
              boxShadow: shadow.hard,
              padding: '30px 32px',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18 }}>
              <span
                style={{
                  fontFamily: font.mono,
                  fontWeight: 800,
                  fontSize: 18,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  background: color.paper,
                  color: color.ink,
                  padding: '6px 12px',
                  borderRadius: 4,
                }}
              >
                hosted · from £0
              </span>
              <span style={{ fontFamily: font.sans, fontWeight: 500, fontSize: 24, color: 'rgba(255,255,255,0.9)' }}>
                no install, no terminal
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 18 }}>
              {hostSteps.map((s, i) => (
                <div
                  key={s}
                  style={{
                    opacity: fadeIn(frame, 58 + i * 8, 8),
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    background: 'rgba(255,255,255,0.12)',
                    border: `2px solid ${color.lineInvert}`,
                    borderRadius: 8,
                    padding: '12px 16px',
                  }}
                >
                  <span style={{ fontFamily: font.mono, fontWeight: 800, fontSize: 22, color: color.paper }}>{i + 1}</span>
                  <span style={{ fontFamily: font.mono, fontWeight: 700, fontSize: 23, color: color.paper }}>{s}</span>
                </div>
              ))}
            </div>

            <div style={{ fontFamily: font.sans, fontSize: 25, lineHeight: 1.5 }}>
              Sign in by email, connect networks, approve the connector in Claude.
              Reports run on a schedule, laptop shut.
            </div>
          </div>
        </div>

        <div
          style={{
            opacity: fadeIn(frame, 120, 14),
            marginTop: 26,
            textAlign: 'center',
            fontFamily: font.mono,
            fontWeight: 700,
            fontSize: 24,
            letterSpacing: '0.06em',
            color: color.smudgeDk,
          }}
        >
          agenticaffiliate.ai · github.com/bobberrisford/affiliatemcp
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
