import { useColorScheme } from 'react-native';
import { darkTheme, lightTheme, type Theme } from './theme-palette';

/**
 * Minimal hand-rolled theme, dark-mode aware via the OS color scheme.
 * Deliberately no design-system dependency: plain React Native components
 * styled from this palette. The palettes themselves live in
 * ./theme-palette.ts (no React Native imports) so the offline scripts can
 * check their contrast ratios.
 */
export type { Theme };

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? darkTheme : lightTheme;
}
