/**
 * Chain abstraction layer. The core package deliberately contains only the
 * offline, deterministic half of chain support (key derivation, addresses,
 * signing primitives) so it stays pure and auditable. Network behavior
 * (balance queries, fee estimation, broadcasting, ERC-4337 bundler traffic)
 * lives in per-chain adapter packages that implement ChainAdapter and
 * register themselves at runtime — this is how the wallet scales to
 * thousands of chains without modifying core.
 */

export type Curve = 'secp256k1' | 'ed25519';

/** An account derived from the wallet seed for one chain. */
export interface DerivedAccount {
  /** CAIP-2 chain identifier, e.g. "eip155:1", "bip122:000000000019d6689c085ae165831e93", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp". */
  chainId: string;
  /** Full BIP-32 / SLIP-0010 derivation path used. */
  path: string;
  publicKey: Uint8Array;
  address: string;
  /**
   * Signs a chain-appropriate digest or message with the account's private
   * key. What the input means (tx hash, UserOperation hash, raw message) is
   * defined by the chain's ChainKeyProvider.
   */
  sign(digest: Uint8Array): Uint8Array;
}

/**
 * The offline key/address half of a chain integration. Implementations must
 * be pure: no I/O, fully deterministic from the seed.
 */
export interface ChainKeyProvider {
  /** CAIP-2 identifier of the chain (or chain family reference chain). */
  chainId: string;
  /** SLIP-44 coin type used in the BIP-44 path. */
  coinType: number;
  curve: Curve;
  /** Human-readable name, e.g. "Ethereum". */
  name: string;
  /** Returns the derivation path for an account/address index pair. */
  derivationPath(account: number, addressIndex: number): string;
  /** Derives one account from the 64-byte BIP-39 seed. */
  deriveAccount(seed: Uint8Array, account: number, addressIndex: number): DerivedAccount;
}

/**
 * The full chain integration contract implemented by adapter packages
 * (e.g. @shiba-wallet/chains-evm). Extends the pure key provider with
 * network operations. All methods take explicit endpoint configuration so
 * the wallet is never locked to one RPC vendor.
 */
export interface ChainAdapter extends ChainKeyProvider {
  getBalance(address: string): Promise<bigint>;
  estimateFee(tx: unknown): Promise<bigint>;
  buildTransaction(params: unknown): Promise<unknown>;
  signTransaction(account: DerivedAccount, tx: unknown): Promise<Uint8Array>;
  broadcast(signedTx: Uint8Array): Promise<string>;
}
