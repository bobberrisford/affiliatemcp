import React from 'react';
import { AbsoluteFill } from 'remotion';
import { color, font } from '../theme';

// Full-frame halftone dot field, matching the site's .halftone-bg texture.
export const Halftone: React.FC<{
  opacity?: number;
  dark?: boolean;
  size?: number;
}> = ({ opacity = 0.06, dark = false, size = 22 }) => (
  <AbsoluteFill
    style={{
      opacity,
      backgroundImage: `radial-gradient(${dark ? color.paper : color.ink} 2.6px, transparent 3px)`,
      backgroundSize: `${size}px ${size}px`,
    }}
  />
);

// Mono uppercase section label with the leading rule, like .sec-label.
export const SectionLabel: React.FC<{
  children: React.ReactNode;
  onDark?: boolean;
  accent?: string;
}> = ({ children, onDark = false, accent }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 18,
      fontFamily: font.mono,
      fontWeight: 700,
      fontSize: 24,
      letterSpacing: '0.16em',
      textTransform: 'uppercase',
      color: accent ?? (onDark ? color.fgInvertMut : color.smudgeDk),
    }}
  >
    <span
      style={{
        width: 52,
        height: 3,
        background: accent ?? (onDark ? color.paper : color.ink),
      }}
    />
    {children}
  </div>
);

// Ink chip / sticker, .chip and its accent variants.
export const Chip: React.FC<{
  children: React.ReactNode;
  variant?: 'ink' | 'blue' | 'mag' | 'pending';
  style?: React.CSSProperties;
}> = ({ children, variant = 'ink', style }) => {
  const bg =
    variant === 'blue'
      ? color.blue
      : variant === 'mag'
        ? color.magenta
        : variant === 'pending'
          ? color.pending
          : color.ink;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        fontFamily: font.mono,
        fontWeight: 700,
        fontSize: 22,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
        background: bg,
        color: variant === 'pending' ? color.ink : color.paper,
        padding: '9px 15px',
        borderRadius: 4,
        ...style,
      }}
    >
      {children}
    </span>
  );
};
