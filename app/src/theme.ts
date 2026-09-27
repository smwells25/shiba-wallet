import { useColorScheme } from 'react-native';

/**
 * Minimal hand-rolled theme, dark-mode aware via the OS color scheme.
 * Deliberately no design-system dependency: plain React Native components
 * styled from this palette.
 */
export interface Theme {
  dark: boolean;
  background: string;
  card: string;
  text: string;
  textMuted: string;
  border: string;
  accent: string;
  danger: string;
  dangerSurface: string;
  warningSurface: string;
  warningBorder: string;
  warningText: string;
  success: string;
}

const light: Theme = {
  dark: false,
  background: '#f6f7f9',
  card: '#ffffff',
  text: '#16181d',
  textMuted: '#5c6470',
  border: '#e2e5ea',
  accent: '#d97a1a',
  danger: '#c62828',
  dangerSurface: '#fdecea',
  warningSurface: '#fff6e5',
  warningBorder: '#e6b35a',
  warningText: '#7a4a00',
  success: '#2e7d32',
};

const dark: Theme = {
  dark: true,
  background: '#101216',
  card: '#1b1e24',
  text: '#eceef2',
  textMuted: '#9aa3b0',
  border: '#2a2e36',
  accent: '#f0942f',
  danger: '#ef5350',
  dangerSurface: '#3a1f1f',
  warningSurface: '#332916',
  warningBorder: '#8a6a2f',
  warningText: '#f0c987',
  success: '#66bb6a',
};

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}
