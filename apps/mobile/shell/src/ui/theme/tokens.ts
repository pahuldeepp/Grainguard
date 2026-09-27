// Tokens from docs/DESIGN_SYSTEM.md. Pure data: also read by scripts/contrast.mjs.
export const palette = {
  light: {
    bg: '#F3F4F2',
    surface: '#FFFFFF',
    surfaceRaised: '#FFFFFF',
    line: '#D5D9D5',
    text: '#141A16',
    textMuted: '#4A544E',
    brand: '#0B5D36',
    onBrand: '#FFFFFF',
    focus: '#1D5FD1',
    critical: '#B3261E',
    warning: '#8A5A00',
    notice: '#1D5FD1',
    ok: '#1E6B3C',
    offline: '#5B4B8A',
  },
  dark: {
    bg: '#0F1311',
    surface: '#171C19',
    surfaceRaised: '#1E2521',
    line: '#2C3530',
    text: '#EAEFEB',
    textMuted: '#A6B0AA',
    brand: '#4CBF84',
    onBrand: '#06170E',
    focus: '#7FB0FF',
    critical: '#FF8A80',
    warning: '#F2B84B',
    notice: '#7FB0FF',
    ok: '#6FD09A',
    offline: '#B9A8F0',
  },
} as const;

export type Palette = { [K in keyof typeof palette.light]: string };

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
};
export const radius = { input: 4, control: 8 };
export const MIN_TARGET = 44;

export type TypeRole =
  | 'title'
  | 'section'
  | 'rowTitle'
  | 'body'
  | 'display'
  | 'data'
  | 'meta'
  | 'button';

// size / weight / line height from the design system; `cap` is the largest
// Dynamic Type multiplier before layout, not text, has to give.
export const type: Record<
  TypeRole,
  {
    size: number;
    weight: '400' | '600' | '700';
    line: number;
    tabular?: boolean;
    cap: number;
  }
> = {
  title: { size: 28, weight: '700', line: 34, cap: 1.4 },
  section: { size: 20, weight: '600', line: 26, cap: 1.5 },
  rowTitle: { size: 17, weight: '600', line: 22, cap: 1.8 },
  body: { size: 16, weight: '400', line: 24, cap: 1.8 },
  display: { size: 34, weight: '700', line: 40, tabular: true, cap: 1.3 },
  data: { size: 22, weight: '600', line: 28, tabular: true, cap: 1.5 },
  meta: { size: 14, weight: '400', line: 20, cap: 1.8 },
  button: { size: 17, weight: '600', line: 22, cap: 1.6 },
};

export type SeverityKey = 'critical' | 'high' | 'warning' | 'notice';
export type MarkerKind = SeverityKey | 'acknowledged' | 'unsent';
