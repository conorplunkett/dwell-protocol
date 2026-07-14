/**
 * Brand tokens for the launch video, hand-mirrored from `dwell/web/theme.css`
 * ("Kinetic Broadcast"). If theme.css changes, update the values here in the
 * same commit — same rule as the other mirrored surfaces in AGENTS.md.
 */
export const T = {
  // Brand / accent
  accent: '#ff0000',
  accentD: '#bc0100',
  accentInk: '#ffffff',
  link: '#065fd4',

  // Surfaces
  bg: '#ffffff',
  bgTint: '#f9f9f9',
  cardInset: '#f3f3f4',

  // Ink & neutrals
  ink: '#0f0f0f',
  ink2: '#282828',
  gray: '#606060',
  gray2: '#909090',
  line: '#eeeeee',
  borderStrong: '#cccccc',

  // Overlay / sponsor pill (dark — floats over third-party surfaces)
  ovBarBg: 'rgba(15, 15, 15, 0.92)',
  ovBarBgHover: 'rgba(26, 26, 26, 0.96)',
  ovBarBorder: 'rgba(255, 255, 255, 0.08)',
  ovText: '#f1f1f1',
  ovLine: '#ffffff',
  ovDots: '#aaaaaa',
  ovChipBg: '#ff0000',
  ovChipInk: '#ffffff',
  ovTagBg: 'rgba(255, 0, 0, 0.2)',
  ovTagText: '#ff9d94',

  // LCD tally counter (green-on-black seven-segment hardware colors)
  lcdBezelA: '#24262b',
  lcdBezelB: '#0c0d10',
  lcdScreen: '#071108',
  lcdOn: '#4dffa0',
  lcdOff: 'rgba(77, 255, 160, 0.07)',
  lcdGlow: 'rgba(77, 255, 160, 0.55)',

  // Semantic
  okFg: '#1a7f37',

  // Fonts (loaded in fonts.ts)
  sans: 'Sora, Inter, system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, monospace',
} as const;
