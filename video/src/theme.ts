// affiliate-mcp brand tokens, mirrored from design-system/colors_and_type.css.
// Punk / riso / gig-poster energy: heavy ink, newsprint paper, two electric
// shock accents, crisp monospace. No green anywhere in the data language.

export const color = {
  ink: '#0B0B0C',
  inkSoft: '#16161B',
  paper: '#FFFFFF',
  paper2: '#F2F3F7',
  smudge: '#8B8FA0',
  smudgeDk: '#565A6B',

  blue: '#2B2BFF', // riso blue — primary accent
  blueDeep: '#1B1BB8',
  blueBright: '#5A78FF', // legible on dark
  magenta: '#FF2E88', // hot pink — secondary / down / reversed
  pending: '#E8A317', // amber — pending / waiting

  lineInvert: 'rgba(255,255,255,0.16)',
  fgInvertMut: '#9A9DAC',
} as const;

// Status → colour, matching the design system (up/paid = blue, down = magenta,
// pending = amber). Deliberately no green.
export const statusColor = {
  approved: color.blue,
  paid: color.blueBright,
  pending: color.pending,
  reversed: color.magenta,
} as const;

export const font = {
  display: "'Bricolage Grotesque', 'Arial Black', system-ui, sans-serif",
  sans: "'Space Grotesk', system-ui, -apple-system, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
} as const;

export const shadow = {
  hard: `8px 8px 0 0 ${color.ink}`,
  hardLg: `12px 12px 0 0 ${color.ink}`,
  blue: `8px 8px 0 0 ${color.blue}`,
  magenta: `8px 8px 0 0 ${color.magenta}`,
} as const;

export const VIDEO = {
  width: 1920,
  height: 1080,
  fps: 30,
} as const;
