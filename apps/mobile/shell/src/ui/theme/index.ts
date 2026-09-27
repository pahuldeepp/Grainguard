import { useColorScheme } from 'react-native';
import { palette, radius, space } from './tokens';
import type { MarkerKind, Palette, SeverityKey } from './tokens';

export * from './tokens';

export interface Theme {
  dark: boolean;
  c: Palette;
  space: typeof space;
  radius: typeof radius;
}

const themes: Record<'light' | 'dark', Theme> = {
  light: { dark: false, c: palette.light, space, radius },
  dark: { dark: true, c: palette.dark, space, radius },
};

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? themes.dark : themes.light;
}

// The backend severities are critical, high, medium, low. Design words:
// medium is "Warning", low is "Notice"; anything unknown reads as Notice.
export function severityKey(severity: string): SeverityKey {
  switch (severity.toLowerCase()) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'medium':
    case 'warning':
      return 'warning';
    default:
      return 'notice';
  }
}

export const MARKER_WORD: Record<MarkerKind, string> = {
  critical: 'Critical',
  high: 'High',
  warning: 'Warning',
  notice: 'Notice',
  acknowledged: 'Acknowledged',
  unsent: 'Unsent',
};

export function markerColor(c: Palette, kind: MarkerKind): string {
  switch (kind) {
    case 'critical':
    case 'high':
      return c.critical;
    case 'warning':
      return c.warning;
    case 'notice':
      return c.notice;
    case 'acknowledged':
      return c.ok;
    case 'unsent':
      return c.offline;
  }
}

export function severityRank(severity: string): number {
  return ['critical', 'high', 'warning', 'notice'].indexOf(
    severityKey(severity),
  );
}
