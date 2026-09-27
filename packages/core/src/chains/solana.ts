import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';
import { slip10DerivePath } from '../keyring/slip10.js';
import type { ChainKeyProvider, DerivedAccount } from './types.js';

/**
 * Solana key provider. Solana uses ed25519, so derivation follows SLIP-0010
 * (hardened-only) rather than BIP-32. The path m/44'/501'/{account}'/0'
 * matches Phantom and the broader Solana wallet ecosystem, so a seed phrase
 * imported from or exported to other Solana wallets resolves the same
 * addresses. The address is simply the base58-encoded ed25519 public key.
 */
export const SLIP44_SOL = 501;

export const solanaKeyProvider: ChainKeyProvider = {
  chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  coinType: SLIP44_SOL,
  curve: 'ed25519',
  name: 'Solana',

  // Solana convention: the account index is the third segment; the address
  // index is unused (kept 0') because each account has one address.
  derivationPath(account: number, _addressIndex: number): string {
    return `m/44'/${SLIP44_SOL}'/${account}'/0'`;
  },

  deriveAccount(seed: Uint8Array, account: number, addressIndex: number): DerivedAccount {
    const path = this.derivationPath(account, addressIndex);
    const node = slip10DerivePath(seed, path);
    const publicKey = ed25519.getPublicKey(node.privateKey);
    return {
      chainId: this.chainId,
      path,
      publicKey,
      address: base58.encode(publicKey),
      sign: (message: Uint8Array) => ed25519.sign(message, node.privateKey),
    };
  },
};
