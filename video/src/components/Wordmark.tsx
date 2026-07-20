import React from 'react';
import { color, font } from '../theme';

// "affiliate-mcp" wordmark — lowercase Bricolage display, with "mcp" reversed
// out in a riso-blue box, exactly as the site nav / footer render it.
export const Wordmark: React.FC<{
  size?: number;
  onDark?: boolean;
}> = ({ size = 64, onDark = false }) => {
  return (
    <span
      style={{
        fontFamily: font.display,
        fontWeight: 800,
        fontSize: size,
        letterSpacing: '-0.03em',
        lineHeight: 1,
        textTransform: 'lowercase',
        color: onDark ? color.paper : color.ink,
        whiteSpace: 'nowrap',
        display: 'inline-flex',
        alignItems: 'baseline',
      }}
    >
      affiliate-
      <span
        style={{
          background: color.blue,
          color: color.paper,
          padding: '0 0.1em',
          borderRadius: size * 0.12,
        }}
      >
        mcp
      </span>
    </span>
  );
};
