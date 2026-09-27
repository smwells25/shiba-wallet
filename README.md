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
   bundlers, paymasters, indexers, and swap aggregators are injected
   transports and providers (vendors are configuration, not code).

## Proven on live networks

Every transaction below was built and signed entirely by this repository's
code and accepted by real public networks:

- **Ethereum Sepolia, ERC-4337**: a counterfactual SimpleAccount was
  deployed at the exact address the engine predicted offline, via
  EntryPoint v0.7 (one self-bundled `handleOps` transaction, then a
  UserOperation through a commercial bundler with a successful receipt).
- **Ethereum Sepolia, EOA**: EIP-1559 transactions confirmed.
- **Bitcoin testnet3**: P2WPKH spends accepted, including a two-input
  consolidation.
- **Solana devnet**: a System transfer finalized, with the network's
  returned signature matching the locally computed transaction id.
- **Dogecoin**: live Blockbook reads (balances, UTXOs, classified
  history) on mainnet and testnet; a broadcast awaits testnet funds, and
  the signing path is byte-identical to bitcoinjs-lib in tests.

## Repository layout

| Path | Contents |
|---|---|
| `docs/FEATURE_UNIVERSE.md` | The complete feature landscape (99 features) with an investment-tiered prioritization |
| `docs/ARCHITECTURE.md` | System architecture: layers, key management, Account Abstraction design, chain adapters, threat model, ADRs |
| `docs/AA_STACK.md` | EntryPoint/account/bundler selection and the on-chain factory verification procedure |
| `packages/core` | Wallet engine: BIP-39 mnemonics, BIP-32/SLIP-0010 derivation, chain key providers, chain registry, CAIP-19 asset registry, history model |
| `packages/chains-evm` | ERC-4337 (EntryPoint v0.7 UserOperations, counterfactual accounts, bundler + ERC-7677 paymaster clients, smart-account orchestration), EIP-1559 signing, EIP-712 typed data, ERC-20 helpers and transfer logs, transfers-indexer history, eth_call simulation with revert decoding, swap-quote interface with a 0x v2 adapter |
| `packages/chains-utxo` | Bitcoin/Dogecoin transaction building and signing (BIP-143 and legacy sighash), coin selection with verified dust rules, Esplora and Blockbook transports and history providers |
| `packages/chains-solana` | Message compilation and signing, System and SPL token transfers (PDA/ATA derivation), RPC client, history provider |
| `app/` | Expo app: onboarding with quiz-verified backup, balances (native + ERC-20), send flows (native, token, experimental ERC-4337 path), per-chain activity, WalletConnect v2, biometric gating |
| `scripts/testnet/` | Live smoke tests: per-chain self-sends and the ERC-4337 deployment/bundler run |
| `AGENTS.md` | Persistent project state: status, decisions, phase plans, and the honestly recorded untested remainder |

## Development

Requires Node.js ≥ 20 (the team uses 24.x via nvm).

```sh
npm install        # workspace dependencies (engine packages)
npm run build      # build every package, core first
npm test           # every package's vitest suite
cd app && npm install && npx tsc --noEmit   # the mobile app has its own tree
```

API keys and the development wallet live only in the git-ignored
`.dev-wallet/` directory; nothing sensitive is tracked.

## Testing philosophy

Cryptographic and protocol correctness is never asserted from memory.
Every derivation and encoding path is validated against official test
vectors (BIP-84, SLIP-0010, the EIP-712 specification example) or
cross-checked byte-for-byte against independent implementations
(ethers.js, bitcoinjs-lib, @solana/web3.js, @solana/spl-token,
ed25519-hd-key), and consensus-critical constants are verified against
upstream sources (Bitcoin Core and Dogecoin chain parameters,
eth-infinitism account-abstraction contracts, Solana program sources)
with the source cited in a comment where the constant lands. External
API shapes (Esplora, Blockbook, Solana RPC, Alchemy transfers, 0x
quotes) are verified against their documentation, probed live where
possible, and exercised through injected fakes in tests. Cryptographic
primitives come exclusively from the audited `@noble`/`@scure`
libraries; this project implements protocols, never primitives.
