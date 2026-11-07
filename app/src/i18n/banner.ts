/**
 * The app-wide TESTNET banner (App.tsx) in the active language. The
 * profiles keep their English bannerText (config/evm-chain.ts,
 * wallet/custom-networks.ts; pinned by the check scripts); this reads the
 * network name (and, for a network the user added, its coin) back out of
 * the known English shapes and builds the sentence from the table. A name
 * the user typed is put back unchanged. Any other text is shown as given.
 */
import { localize, t } from './index.ts';

const BUILT_IN = /^TESTNET — (.+) test mode is on\. Amounts are test ETH, not real funds\.$/;
const CUSTOM = /^TESTNET — (.+) test mode is on \(a network you added\)\. Amounts are test (\S+), not real funds\.$/;

export function testnetBannerText(english: string): string {
  const custom = CUSTOM.exec(english);
  if (custom) return t('banner.testnet.custom', { network: custom[1], symbol: custom[2] });
  const builtIn = BUILT_IN.exec(english);
  if (builtIn) return t('banner.testnet', { network: builtIn[1] });
  return localize(english);
}

/**
 * The Solana devnet banner (pass p24-solana finding 2), shown at the top of
 * the Solana screens while Settings → Developer → "Use Solana devnet" is on
 * (components/SolanaDevnetBanner.tsx). It is separate from the TESTNET
 * banner above, which follows the Ethereum network choice only, so it is
 * shown whatever that choice is.
 */
export function solanaDevnetBannerText(): string {
  return t('banner.solanaDevnet');
}
