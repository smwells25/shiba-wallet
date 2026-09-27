# Shiba Wallet (working title)

A non-custodial mobile cryptocurrency wallet whose defining feature is
**Account Abstraction** (ERC-4337, with EIP-7702 as the EOA on-ramp), with
first-class support for Bitcoin, Solana, Dogecoin, and an adapter system
designed to scale to thousands of chains and any fungible or non-fungible
asset.

## Non-negotiable principles

1. **Non-custodial.** Keys are generated, stored, and used only on the
   user's device. No server ever sees key material. The core library
   enforces this by construction: key handling code performs no I/O at all.
2. **One seed phrase recovers everything.** The wallet is hierarchical
   deterministic (BIP-39 / BIP-32 / BIP-44, SLIP-0010 for ed25519 chains).
   Every asset — including counterfactual ERC-4337 smart accounts, whose
   addresses derive deterministically from the seed-derived owner key — is
   recoverable from a single mnemonic.
3. **No lock-in, ever.** Chains are plugins behind a `ChainAdapter`
   interface keyed by CAIP-2 identifiers; assets are CAIP-19 identifiers;
   bundlers and paymasters are injected transports (vendors are
   configuration, not code). Features can always be added later without
   rewriting the core.

## Repository layout

| Path | Contents |
|---|---|
| `docs/FEATURE_UNIVERSE.md` | The complete feature landscape (99 features) with an investment-tiered prioritization, written for leadership |
| `docs/ARCHITECTURE.md` | System architecture: layers, key management, Account Abstraction design, chain adapters, threat model, ADRs |
| `packages/core` | Wallet engine: BIP-39 mnemonics, BIP-32/SLIP-0010 derivation, chain key providers (EVM, Bitcoin, Dogecoin, Solana), chain registry, CAIP-19 asset registry |
| `packages/chains-evm` | ERC-4337 support: EntryPoint v0.7 UserOperations, counterfactual CREATE2 addresses, vendor-neutral bundler and ERC-7677 paymaster clients, smart-account orchestration |
| `packages/chains-utxo` | Bitcoin/Dogecoin transaction building, signing, broadcast (in progress) |
| `packages/chains-solana` | Solana transaction building, signing, submission (in progress) |
| `AGENTS.md` | Persistent project state for agents and contributors |

## Development

Requires Node.js ≥ 20 (the team uses 24.x via nvm).

```sh
npm install        # install all workspace dependencies
npm run build      # build every package
npm test           # run every package's test suite
```

## Testing philosophy

Cryptographic correctness is never asserted from memory. Every derivation
and encoding path is validated against official test vectors (BIP-84,
SLIP-0010) or cross-checked against independent implementations (ethers.js,
ed25519-hd-key), and consensus-critical constants are verified against
upstream sources (dogecoin/dogecoin chain parameters,
eth-infinitism/account-abstraction contracts) with the source cited in a
comment where the constant lands. Cryptographic primitives come exclusively
from the audited `@noble`/`@scure` libraries; this project implements
protocols, never primitives.
