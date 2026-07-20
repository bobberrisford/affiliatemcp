import { interpolate, spring, Easing } from 'remotion';

export const FPS = 30;

// Standard "rise + fade in" for an element that appears at `delay` frames.
export const riseIn = (
  frame: number,
  fps: number,
  delay = 0,
  distance = 40,
) => {
  const s = spring({
    frame: frame - delay,
    fps,
    config: { damping: 200, mass: 0.7, stiffness: 120 },
  });
  return {
    opacity: interpolate(s, [0, 1], [0, 1]),
    transform: `translateY(${interpolate(s, [0, 1], [distance, 0])}px)`,
  };
};

// Simple opacity fade between [delay, delay+dur].
export const fadeIn = (frame: number, delay = 0, dur = 12) =>
  interpolate(frame, [delay, delay + dur], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

// Number of visible characters of a string at the current frame — typewriter.
export const typed = (
  frame: number,
  text: string,
  startFrame: number,
  charsPerFrame = 1.6,
) => {
  const n = Math.max(0, Math.floor((frame - startFrame) * charsPerFrame));
  return text.slice(0, n);
};

// Count-up from 0 to `value`, easing out, over [delay, delay+dur].
export const countUp = (
  frame: number,
  value: number,
  delay = 0,
  dur = 30,
) => {
  const t = interpolate(frame, [delay, delay + dur], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  return value * t;
};

export const gbp = (n: number) =>
  '£' +
  Math.round(n).toLocaleString('en-GB', { maximumFractionDigits: 0 });
