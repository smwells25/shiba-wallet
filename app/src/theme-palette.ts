/**
 * The colour palettes behind ./theme.ts, kept free of React Native imports
 * so scripts/check-devmode.mjs can load them under Node's type stripping and
 * compute contrast ratios from the exact values the app uses.
 *
 * CONTRAST (phase 11 item 6 finding D1). WCAG 2.2 success criterion 1.4.3
 * "Contrast (Minimum)" (https://www.w3.org/TR/WCAG22/#contrast-minimum)
 * asks for at least 4.5:1 between text and its background, or 3:1 for
 * large text (at least 18 point, or 14 point bold). Button labels here are
 * 16 px semibold, which is not large text, so 4.5:1 applies. The ratio and
 * relative luminance follow the WCAG 2.2 definitions
 * (https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio and
 * #dfn-relative-luminance): (L1 + 0.05) / (L2 + 0.05), with each sRGB
 * channel linearised as c / 12.92 when c <= 0.04045, else
 * ((c + 0.055) / 1.055) ^ 2.4.
 *
 * In dark mode white text on the dark accent (#f0942f) measured about
 * 2.3:1. Darkening the accent enough for white text would also darken the
 * secondary buttons' orange text on the near-black background below 4.5:1,
 * so dark mode keeps the accent and puts dark text on it instead
 * (`onAccent`), and does the same on the danger fill and the orange
 * TESTNET fill. Light mode is unchanged on purpose (see the report in
 * AGENTS.md for its own ratios).
 */
export interface Theme {
  dark: boolean;
  background: string;
  card: string;
  text: string;
  textMuted: string;
  border: string;
  accent: string;
  /** Text and icons drawn ON an accent fill (primary buttons, selected chips). */
  onAccent: string;
  danger: string;
  /** Text drawn on a danger fill (destructive buttons). */
  onDanger: string;
  dangerSurface: string;
  warningSurface: string;
  warningBorder: string;
  warningText: string;
  success: string;
  /** The orange fill of TESTNET badges and "test networks only" chips. */
  testnetFill: string;
  /** Text drawn on testnetFill. */
  onTestnetFill: string;
}

/** The TESTNET orange used across the app (unchanged value). */
export const TESTNET_ORANGE = '#e07800';

export const lightTheme: Theme = {
  dark: false,
  background: '#f6f7f9',
  card: '#ffffff',
  text: '#16181d',
  textMuted: '#5c6470',
  border: '#e2e5ea',
  accent: '#d97a1a',
  onAccent: '#ffffff',
  danger: '#c62828',
  onDanger: '#ffffff',
  dangerSurface: '#fdecea',
  warningSurface: '#fff6e5',
  warningBorder: '#e6b35a',
  warningText: '#7a4a00',
  success: '#2e7d32',
  testnetFill: TESTNET_ORANGE,
  onTestnetFill: '#ffffff',
};

export const darkTheme: Theme = {
  dark: true,
  background: '#101216',
  card: '#1b1e24',
  text: '#eceef2',
  textMuted: '#9aa3b0',
  border: '#2a2e36',
  accent: '#f0942f',
  onAccent: '#101216',
  danger: '#ef5350',
  onDanger: '#101216',
  dangerSurface: '#3a1f1f',
  warningSurface: '#332916',
  warningBorder: '#8a6a2f',
  warningText: '#f0c987',
  success: '#66bb6a',
  testnetFill: TESTNET_ORANGE,
  onTestnetFill: '#101216',
};

function channel(hex: string, offset: number): number {
  const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.2 relative luminance of a #rrggbb colour. */
export function relativeLuminance(hex: string): number {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error(`Not a #rrggbb colour: ${hex}`);
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

/** WCAG 2.2 contrast ratio between two #rrggbb colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
