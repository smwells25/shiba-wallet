import { mnemonicToSeed } from './mnemonic.js';
import type { ChainRegistry } from '../registry/registry.js';
import type { DerivedAccount } from '../chains/types.js';

/**
 * The HD keyring: one seed, every chain. Holds the seed in memory only for
 * the lifetime of the object; persistence and OS-level protection (Keychain /
 * Android Keystore, biometric gating) are the mobile shell's responsibility.
 * Nothing here ever performs I/O — the non-custodial invariant is enforced by
 * construction, because key material has no code path off the device.
 */
export class HdKeyring {
  private seed: Uint8Array;

  private constructor(seed: Uint8Array, private registry: ChainRegistry) {
    this.seed = seed;
  }

  static fromMnemonic(
    mnemonic: string,
    registry: ChainRegistry,
    passphrase = '',
  ): HdKeyring {
    return new HdKeyring(mnemonicToSeed(mnemonic, passphrase), registry);
  }

  /** Derives the account/addressIndex account for a registered chain. */
  getAccount(chainId: string, account = 0, addressIndex = 0): DerivedAccount {
    return this.registry.get(chainId).deriveAccount(this.seed, account, addressIndex);
  }

  /** Best-effort zeroization once the wallet locks. */
  wipe(): void {
    this.seed.fill(0);
  }
}
