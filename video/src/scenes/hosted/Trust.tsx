import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import { color, font, shadow } from '../../theme';
import { Halftone, SectionLabel } from '../../components/primitives';
import { riseIn } from '../../anim';

// The custody contract, stated plainly. Wording tracks the accepted record
// 2026-07-12-hosted-credential-custody.md and the "honest bits" on the site.
const BITS = [
  {
    k: 'keys',
    title: 'keys go in the dashboard, never in Claude',
    body: 'Entered only in the encrypted dashboard. Claude gets a short-lived OAuth session, never your credentials.',
  },
  {
    k: 'crypto',
    title: 'encrypted at rest, decrypted only to serve you',
    body: 'KMS-backed envelope encryption with per-user keys, decrypted in memory only at the moment your request runs.',
  },
  {
    k: 'control',
    title: 'export or hard-delete any time',
    body: 'Everything is exportable and deletion is complete, credentials included. Read-only in scope, always.',
  },
  {
    k: 'scope',
    title: 'four networks live, honestly labelled',
    body: 'Awin, CJ, Impact, and Rakuten today. Others stay local-only until their terms are checked.',
  },
];

export const Trust: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const head = riseIn(frame, fps, 0, 24);

  return (
    <AbsoluteFill style={{ background: color.blue }}>
      <Halftone dark opacity={0.08} />
      <AbsoluteFill style={{ padding: '80px 100px', justifyContent: 'center' }}>
        <div style={{ ...head, marginBottom: 34 }}>
          <SectionLabel accent={color.paper}>the honest bits</SectionLabel>
          <div
            style={{
              fontFamily: font.display,
              fontWeight: 800,
              fontSize: 62,
              textTransform: 'lowercase',
              letterSpacing: '-0.03em',
              color: color.paper,
              marginTop: 16,
            }}
          >
            holding your keys is a responsibility, not a footnote.
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
          {BITS.map((b, i) => {
            const a = riseIn(frame, fps, 26 + i * 10, 42);
            return (
              <div
                key={b.k}
                style={{
                  ...a,
                  background: color.paper,
                  border: `3px solid ${color.ink}`,
                  borderRadius: 12,
                  boxShadow: shadow.hard,
                  padding: '24px 28px',
                }}
              >
                <div
                  style={{
                    fontFamily: font.display,
                    fontWeight: 800,
                    fontSize: 30,
                    textTransform: 'lowercase',
                    letterSpacing: '-0.015em',
                    color: color.ink,
                    marginBottom: 8,
                  }}
                >
                  {b.title}
                </div>
                <div style={{ fontFamily: font.sans, fontSize: 23, lineHeight: 1.45, color: color.smudgeDk }}>
                  {b.body}
                </div>
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
