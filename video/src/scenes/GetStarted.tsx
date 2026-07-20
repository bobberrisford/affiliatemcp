import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import { color, font, shadow } from '../theme';
import { Halftone, SectionLabel } from '../components/primitives';
import { riseIn, fadeIn, typed } from '../anim';

const CMD = 'npx affiliate-networks-mcp setup';

// The lines that "print" after the command runs, each revealed on a frame.
const OUTPUT: { at: number; text: string; c: string }[] = [
  { at: 66, text: '◇  Which network? › Awin', c: color.paper },
  { at: 78, text: '◇  Publisher or advertiser side? › Publisher', c: color.paper },
  { at: 90, text: '◇  API token ›  ••••••••••••••••', c: color.fgInvertMut },
  { at: 102, text: '✓  Checked against the live network — ok', c: color.blueBright },
  { at: 116, text: '✓  Wrote ~/.affiliate-mcp/.env  (mode 0600)', c: color.blueBright },
  { at: 128, text: '›  Connect to a client? Claude Desktop · Code · Codex', c: color.pending },
];

const CLIENTS = ['Claude Desktop', 'Claude Code', 'Codex', 'Cowork'];

export const GetStarted: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const head = riseIn(frame, fps, 0, 22);
  const cmdText = typed(frame, CMD, 30, 1.5);
  const cmdDone = frame > 30 + CMD.length / 1.5;

  return (
    <AbsoluteFill style={{ background: color.paper2 }}>
      <Halftone opacity={0.05} />
      <AbsoluteFill style={{ padding: '78px 110px', justifyContent: 'center' }}>
        <div style={{ ...head, marginBottom: 30 }}>
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
            one command. no code required.
          </div>
        </div>

        {/* terminal */}
        <div
          style={{
            ...riseIn(frame, fps, 18, 40),
            background: color.ink,
            border: `3px solid ${color.ink}`,
            borderRadius: 12,
            boxShadow: shadow.blue,
            overflow: 'hidden',
            maxWidth: 1500,
          }}
        >
          <div style={{ height: 52, background: color.inkSoft, display: 'flex', alignItems: 'center', gap: 9, padding: '0 20px' }}>
            {[color.magenta, color.pending, color.blueBright].map((c) => (
              <span key={c} style={{ width: 13, height: 13, borderRadius: 999, background: c }} />
            ))}
            <span style={{ fontFamily: font.mono, fontSize: 17, color: color.fgInvertMut, marginLeft: 8, letterSpacing: '0.1em' }}>
              terminal
            </span>
          </div>
          <div style={{ padding: '26px 30px', minHeight: 360, fontFamily: font.mono, fontSize: 26, lineHeight: 1.7 }}>
            <div>
              <span style={{ color: color.blueBright }}>$ </span>
              <span style={{ color: color.paper }}>{cmdText}</span>
              {!cmdDone && <span style={{ opacity: frame % 16 < 8 ? 1 : 0, color: color.paper }}>▍</span>}
            </div>
            {OUTPUT.map((l) => (
              <div key={l.text} style={{ opacity: fadeIn(frame, l.at, 6), color: l.c }}>
                {l.text}
              </div>
            ))}
          </div>
        </div>

        {/* clients */}
        <div style={{ opacity: fadeIn(frame, 138, 12), display: 'flex', alignItems: 'center', gap: 16, marginTop: 30 }}>
          <span style={{ fontFamily: font.mono, fontWeight: 700, fontSize: 22, letterSpacing: '0.12em', textTransform: 'uppercase', color: color.smudgeDk }}>
            works with
          </span>
          {CLIENTS.map((c, i) => (
            <span
              key={c}
              style={{
                opacity: fadeIn(frame, 144 + i * 6, 8),
                fontFamily: font.mono,
                fontWeight: 700,
                fontSize: 24,
                padding: '9px 16px',
                borderRadius: 6,
                border: `2.5px solid ${color.ink}`,
                background: color.paper,
                color: color.ink,
              }}
            >
              {c}
            </span>
          ))}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
