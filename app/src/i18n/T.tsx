/**
 * <T> — the JSX form of the accessor (./index.ts), for text that the check
 * scripts pin at its call site: `<Text><T>Messages</T></Text>` or
 * `<Text><T>{INBOX_INTRO}</T></Text>`. It renders its one string child in
 * the active language when that string is exactly an English table entry
 * (./en.ts), and unchanged otherwise; it subscribes to the language, so a
 * change in Settings → Language re-renders it. It renders a bare string, so
 * it must sit inside a <Text> (scripts/check-i18n.mjs checks every use).
 */
import { useI18n } from './useI18n.ts';

export function T({ children }: { children: string }) {
  const { localize } = useI18n();
  return localize(children);
}
