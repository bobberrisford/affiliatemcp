import React from 'react';
import { AbsoluteFill, Audio, Sequence, interpolate, useCurrentFrame, staticFile } from 'remotion';
import { color, font } from '../theme';

// Lower-third caption band. Fades in with the scene and out before it ends,
// so the film reads clearly with the sound off.
export const CaptionBar: React.FC<{ text: string; dur: number }> = ({ text, dur }) => {
  const frame = useCurrentFrame();
  const op = interpolate(
    frame,
    [4, 14, dur - 12, dur - 2],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', pointerEvents: 'none' }}>
      <div
        style={{
          opacity: op,
          margin: '0 auto 46px',
          maxWidth: 1400,
          background: 'rgba(11,11,12,0.92)',
          border: `2px solid ${color.paper}`,
          borderRadius: 10,
          padding: '16px 30px',
          textAlign: 'center',
        }}
      >
        <span style={{ fontFamily: font.sans, fontWeight: 500, fontSize: 32, lineHeight: 1.3, color: color.paper }}>
          {text}
        </span>
      </div>
    </AbsoluteFill>
  );
};

// Pairs a scene component with its narration clip and caption. The audio
// starts after a short head pad so the visual can settle first.
export const SceneWithVO: React.FC<{
  comp: React.FC;
  caption: string;
  audioFile: string;
  dur: number;
  headPad: number;
}> = ({ comp: Comp, caption, audioFile, dur, headPad }) => {
  return (
    <AbsoluteFill>
      <Comp />
      <Sequence from={headPad} name="voiceover">
        <Audio src={staticFile(audioFile)} />
      </Sequence>
      <CaptionBar text={caption} dur={dur} />
    </AbsoluteFill>
  );
};
