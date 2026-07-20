import React from 'react';
import { color } from '../theme';

// The brand mark: a terminal prompt glyph (chevron + cursor bar) in a riso-blue
// rounded square. Copied 1:1 from design-system/assets/mark.svg.
export const Mark: React.FC<{ size?: number; onDark?: boolean }> = ({
  size = 120,
  onDark = false,
}) => {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 120 120"
      role="img"
      aria-label="affiliate-mcp mark"
    >
      <rect x="0" y="0" width="120" height="120" rx="14" fill={color.blue} />
      <polyline
        points="34,38 58,60 34,82"
        fill="none"
        stroke={onDark ? color.paper : color.paper}
        strokeWidth="13"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
      <rect x="66" y="68" width="24" height="14" fill={color.paper} />
    </svg>
  );
};
