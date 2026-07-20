import React from 'react';
import { color, font, shadow } from '../theme';
import { Mark } from './Mark';

// A minimal, brand-styled AI-workspace chat window. Deliberately not a pixel
// copy of any real client — it reads as "your AI workspace" with the punk chrome.
export const ChatFrame: React.FC<{
  title: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ title, children, style }) => {
  return (
    <div
      style={{
        width: 1180,
        background: color.paper,
        border: `3px solid ${color.ink}`,
        borderRadius: 10,
        boxShadow: shadow.hardLg,
        overflow: 'hidden',
        ...style,
      }}
    >
      {/* title bar */}
      <div
        style={{
          height: 62,
          background: color.ink,
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '0 22px',
        }}
      >
        <div style={{ display: 'flex', gap: 9 }}>
          {[color.magenta, color.pending, color.blueBright].map((c) => (
            <span
              key={c}
              style={{
                width: 15,
                height: 15,
                borderRadius: 999,
                background: c,
              }}
            />
          ))}
        </div>
        <span
          style={{
            fontFamily: font.mono,
            fontWeight: 700,
            fontSize: 20,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: color.fgInvertMut,
            marginLeft: 8,
          }}
        >
          {title}
        </span>
      </div>
      <div style={{ padding: '34px 40px 40px' }}>{children}</div>
    </div>
  );
};

// Right-aligned user prompt bubble.
export const UserBubble: React.FC<{
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ children, style }) => (
  <div style={{ display: 'flex', justifyContent: 'flex-end', ...style }}>
    <div
      style={{
        maxWidth: 820,
        background: color.blue,
        color: color.paper,
        fontFamily: font.sans,
        fontWeight: 500,
        fontSize: 30,
        lineHeight: 1.4,
        padding: '18px 24px',
        borderRadius: 12,
        borderBottomRightRadius: 3,
        boxShadow: `4px 4px 0 0 ${color.ink}`,
      }}
    >
      {children}
    </div>
  </div>
);

// Left-aligned assistant response, led by the brand mark avatar.
export const AssistantRow: React.FC<{
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ children, style }) => (
  <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start', ...style }}>
    <div style={{ flex: '0 0 auto', marginTop: 2 }}>
      <Mark size={46} />
    </div>
    <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
  </div>
);

// A tool-call chip, e.g. the MCP tool the assistant invoked.
export const ToolCall: React.FC<{
  label: string;
  done?: boolean;
}> = ({ label, done = true }) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 10,
      fontFamily: font.mono,
      fontWeight: 700,
      fontSize: 19,
      color: color.ink,
      background: color.paper2,
      border: `2px solid ${color.ink}`,
      borderRadius: 6,
      padding: '7px 12px',
    }}
  >
    <span
      style={{
        width: 12,
        height: 12,
        borderRadius: 999,
        background: done ? color.blue : color.pending,
      }}
    />
    {label}
  </span>
);
