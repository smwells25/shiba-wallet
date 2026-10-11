import type { FungibleAsset, HistoryEntry } from '@shiba-wallet/core';
import {
  ENTRYPOINT_V07,
  STAKING_SELECTORS,
  activitySentence,
  activityTokenContracts,
  decodeActivity,
  formatExactUnits,
  httpTransport,
  predictKernelAddress,
  shortActivityAddress,
} from '@shiba-wallet/chains-evm';
import type { ActivityDescription, ActivitySentenceContext, AssetChange } from '@shiba-wallet/chains-evm';
// Explicit .ts extensions: scripts/check-activity.mjs loads this module
// under Node's type stripping, which resolves relative specifiers literally.
import { withEndpoint } from '../config/networks.ts';
import { maskAmount } from '../config/prefs.ts';
import { findExactContact, type Contact } from './contacts.ts';
import { resolveTokenMeta, type TokenMetaMap } from './simulation.ts';
import type { Erc20Metadata } from './erc20.ts';
import { smartAccountSaltFor } from './account-ids.ts';
// A type-only import (erased at run time): risk.ts imports this module, so a
// value import back would be a require cycle, which Metro warns about. The
// lookup itself (risk.ts stakingContractAt) is passed in by the screen.
import type { PinnedStakingContract } from './risk.ts';

/**
 * Human-readable Activity rows (phase 11 item 4): app glue around the
 * engine's activity decoder (packages/chains-evm/src/activity-decode.ts),
 * which turns a transaction hash into a structured description and a plain
 * sentence built only from the transaction and its receipt.
 *
 * What this module adds:
 *  - Endpoint: every decode runs through config/networks.ts withEndpoint,
 *    i.e. the ACTIVE network's endpoint with the shared failover rule (a
 *    failing default endpoint is reported and the decode is repeated once
 *    on the next healthy candidate).
 *  - Bounds: at most `maxPerCall` new decodes per call (the screen calls
 *    once per page it shows), one at a time, so a long history never
 *    triggers a burst of requests against a public endpoint.
 *  - Cache: successful decodes are kept in memory (bounded, oldest out
 *    first) per network + wallet addresses + hash, so revisiting the
 *    screen costs nothing. Failures and "not available yet" answers are
 *    NOT cached; they are remembered per decoder so the same row is not
 *    retried on every render, and a pull-to-refresh (reset()) tries again.
 *  - Failure policy: any failure leaves the row exactly as it was — no
 *    sentence, no error text. The sentence is an addition to the row, never
 *    a replacement for the amount/fee line.
 *  - Token metadata: the balance-change preview's own resolver
 *    (./simulation.ts resolveTokenMeta: tracked-token list for this exact
 *    network first, else on-chain symbol()/decimals(), capped, sanitized).
 *  - Rendering: contacts' EXACT-match names for counterparties
 *    (./contacts.ts findExactContact — never a prefix/suffix match), and
 *    Hide amounts through config/prefs.ts maskAmount. Rendering is separate
 *    from decoding, so toggling Hide amounts or editing a contact changes
 *    the sentence immediately without a new network request.
 *
 * Deliberately free of React Native imports so scripts/check-activity.mjs
 * runs the exact code the screen runs.
 */

/** New decodes per decodeEntries call (one Activity page). */
export const MAX_DECODES_PER_CALL = 8;
/** Successful decodes kept in memory across screen visits. */
export const ACTIVITY_CACHE_LIMIT = 300;

export interface DecodedActivity {
  description: ActivityDescription;
  /** Token metadata by lowercase contract address. */
  tokens: TokenMetaMap;
}

const cache = new Map<string, DecodedActivity>();

function remember(key: string, value: DecodedActivity): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > ACTIVITY_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Drops every cached decode (wallet wipe; tests). */
export function clearActivityCache(): void {
  cache.clear();
}

/** Number of cached decodes (tests). */
export function activityCacheSize(): number {
  return cache.size;
}

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Runs `operation` against an RPC URL. The default goes through
 * withEndpoint for `chainId`; checks inject a fixed URL.
 */
export type EndpointRunner = <T>(operation: (url: string) => Promise<T>) => Promise<T>;

export function activeEndpointRunner(chainId: string): EndpointRunner {
  return async (operation) => (await withEndpoint(chainId, (ep) => operation(ep.url))).value;
}

export interface ActivityDecoderOptions {
  /** CAIP-2 id of the active EVM network (e.g. 'eip155:11155111'). */
  chainCaip2: string;
  /** Its EIP-155 chain id. */
  evmChainId: bigint;
  /** The wallet's addresses on this network (EOA first; smart accounts if known). */
  wallet: string[];
  /** Tracked tokens (filtered to this network by the metadata resolver). */
  trackedTokens: FungibleAsset[];
  /** Where requests go; defaults to activeEndpointRunner(chainCaip2). */
  run?: EndpointRunner;
  maxPerCall?: number;
  /** Metadata reader override (tests). */
  fetchMetadata?: (url: string, contract: string) => Promise<Erc20Metadata>;
}

export interface ActivityDecoder {
  /**
   * Decodes up to maxPerCall of `ids` (transaction hashes) that are not
   * cached and have not failed in this decoder, in the given order, then
   * returns every cached result for `ids`. Never throws.
   */
  decodeEntries(ids: string[]): Promise<Map<string, DecodedActivity>>;
  /** Cached results for `ids`, without any request. */
  cachedFor(ids: string[]): Map<string, DecodedActivity>;
  /** Forgets this decoder's failures so they are tried again. */
  reset(): void;
  /** Hashes that failed in this decoder (tests). */
  failedIds(): string[];
  /**
   * True when a decode of `id` could still give a sentence: a transaction
   * hash that is neither cached nor failed in this decoder. A row for such
   * an id says its details are loading.
   */
  mayDecode(id: string): boolean;
}

export function createActivityDecoder(options: ActivityDecoderOptions): ActivityDecoder {
  const walletKey = options.wallet.map((a) => a.toLowerCase()).sort().join(',');
  const keyFor = (hash: string) => `${options.chainCaip2}|${walletKey}|${hash.toLowerCase()}`;
  const run = options.run ?? activeEndpointRunner(options.chainCaip2);
  const maxPerCall = options.maxPerCall ?? MAX_DECODES_PER_CALL;
  const failed = new Set<string>();
  const inFlight = new Set<string>();

  const cachedFor = (ids: string[]) => {
    const out = new Map<string, DecodedActivity>();
    for (const id of ids) {
      const hit = cache.get(keyFor(id));
      if (hit) out.set(id, hit);
    }
    return out;
  };

  async function decodeOne(hash: string): Promise<DecodedActivity | null> {
    return run(async (url) => {
      const outcome = await decodeActivity(httpTransport(url), hash, {
        wallet: options.wallet,
        chainId: options.evmChainId,
      });
      if (outcome.status !== 'ok') return null;
      const description = outcome.description;
      // The preview's resolver takes balance changes; present each contract
      // the sentence may name as a zero-amount change so the same tracked-
      // list matching, eth_call reads, cap and sanitizing apply.
      const contracts = activityTokenContracts(description);
      const asChanges: AssetChange[] = contracts.map((token) => ({
        type: 'erc20',
        callIndex: 0,
        direction: 'in',
        token,
        from: token,
        to: token,
        amount: 0n,
      }));
      const tokens = contracts.length
        ? await resolveTokenMeta(asChanges, {
            url,
            chainCaip2: options.chainCaip2,
            trackedTokens: options.trackedTokens,
            ...(options.fetchMetadata ? { fetchMetadata: options.fetchMetadata } : {}),
          })
        : {};
      return { description, tokens };
    });
  }

  return {
    cachedFor,
    reset() {
      failed.clear();
    },
    failedIds() {
      return [...failed];
    },
    mayDecode(id) {
      return HASH_RE.test(id) && !cache.has(keyFor(id)) && !failed.has(id);
    },
    async decodeEntries(ids) {
      const unique = [...new Set(ids)];
      const todo = unique
        .filter((id) => HASH_RE.test(id) && !cache.has(keyFor(id)) && !failed.has(id) && !inFlight.has(id))
        .slice(0, maxPerCall);
      for (const id of todo) {
        inFlight.add(id);
        try {
          const decoded = await decodeOne(id);
          if (decoded) remember(keyFor(id), decoded);
          else failed.add(id);
        } catch {
          failed.add(id);
        } finally {
          inFlight.delete(id);
        }
      }
      return cachedFor(unique);
    },
  };
}

export interface SentenceRenderOptions {
  /** Native currency label of the active network ("ETH", "test ETH"). */
  nativeSymbol: string;
  /** Hide amounts. */
  hidden: boolean;
  /** Contacts of the active network (exact matches only are used). */
  contacts: readonly Contact[];
  /** The contacts network id (the active EVM network's CAIP-2 id). */
  networkId: string;
  /**
   * The wallet's own accounts on this network with the names every screen
   * shows (activityAccountLabels). An address the sentence names that is
   * not one of the decoded account's own addresses (those read "yourself")
   * is called by its account name — "Account 1", "Imported 1 (imported
   * key)", "Multisig 2 (2-of-3)" — instead of a short address. A contact's
   * name for the same address is still used first.
   */
  accountLabels?: readonly AccountLabel[];
  /**
   * risk.ts stakingContractAt bound to the active network: the pinned
   * staking contract at an address, or null. With it, a call to a pinned
   * staking contract whose selector is one the engine pins
   * (packages/chains-evm/src/staking.ts STAKING_SELECTORS) is described by
   * what it does (stakingCallPhrase), and the contract is named by its
   * label wherever the sentence mentions it (stakingContractLabel). Passed
   * in rather than imported because risk.ts imports this module.
   */
  stakingContractAt?: (address: string) => PinnedStakingContract | null;
  /**
   * The addresses that read "yourself" (activityAddressSets().self): the
   * account whose Activity this is — its own address and, for a regular
   * account, its own smart account. Every other wallet address in the
   * decode (another account's smart account, a multisig) is then named by
   * its label (accountLabels) instead. Absent, every wallet address reads
   * "yourself" (the engine's original rule).
   */
  selfAddresses?: readonly string[];
  /**
   * How a "yourself" address is named when a sentence mentions it as the
   * other party (activityAddressSets().selfNames): the viewing regular
   * account's own smart account reads "your smart account", so Account 1's
   * top-up of its Kernel account reads "Sent 0.0015 test ETH to your smart
   * account" (emulator pass of 2026-10-11, finding F1), not "to yourself".
   */
  selfNames?: readonly { address: string; name: string }[];
}

/** One of the wallet's own accounts, for the sentences (activityAccountLabels). */
export interface AccountLabel {
  address: string;
  label: string;
}

/**
 * The labels of the wallet's own accounts on one network: every account
 * the wallet holds a key for (recovery-phrase and imported accounts, by
 * their shown names) and the stored multi-signature accounts of that
 * network (multisig.ts ownMultisigAddresses, "Multisig 1 (2-of-3)").
 * Watch-only addresses are not the wallet's own and are not included.
 * Malformed addresses are skipped; an address listed twice keeps its first
 * label.
 *
 * With `aa` (the network's smart-account settings) and an account's
 * `index`, the account's smart-account addresses known without a network
 * request (walletAddressesFor: the Kernel counterfactual, a recovered
 * account) are labelled "<name>’s smart account" — the wording of risk.ts
 * ownWalletAddresses, which the risk card and the success screens use.
 * They follow all the accounts' own addresses, before the multisigs.
 * Without `aa` the result is exactly what it was before.
 */
export function activityAccountLabels(
  accounts: readonly { name: string; evmAddress: string | null; index?: number }[],
  multisigs: readonly { address: string; label: string }[] = [],
  aa: AaAddressFacts | null = null,
): AccountLabel[] {
  const out: AccountLabel[] = [];
  const seen = new Set<string>();
  const add = (address: string | null, label: string) => {
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return;
    const key = address.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ address, label });
  };
  for (const a of accounts) add(a.evmAddress, a.name);
  if (aa) {
    for (const a of accounts) {
      if (!a.evmAddress || a.index === undefined || !/^0x[0-9a-fA-F]{40}$/.test(a.evmAddress)) continue;
      for (const smart of walletAddressesFor(a.evmAddress, a.index, aa).slice(1)) add(smart, `${a.name}’s smart account`);
    }
  }
  for (const m of multisigs) add(m.address, m.label);
  return out;
}

/**
 * The address sets one account's Activity is decoded and worded with
 * (emulator re-check of 2026-10-11, findings 2 and 3):
 *
 *  - `self`: the addresses that read "yourself" — the account's own
 *    address and, for a regular account, its own smart account
 *    (walletAddressesFor without multisigs; a multisig or watch-only
 *    account has no smart account of its own, so only its address);
 *  - `wallet`: what the decoder treats as the wallet's own — `self`, then
 *    every other account's smart-account addresses and every stored
 *    multisig of the network. These are decoded as the wallet's (so a
 *    top-up from Account 1's smart account to the multisig is described
 *    with its amount instead of "from other accounts") but are NAMED in
 *    the sentence ("Multisig 2 (2-of-3)", "Account 1’s smart account")
 *    instead of "yourself". The other accounts' OWN addresses are not
 *    added: a transfer from Account 2 to this account is someone else's
 *    transaction ("Received … from Account 2"), not one this account sent;
 *  - `labels`: activityAccountLabels for every account, smart account and
 *    multisig.
 */
export function activityAddressSets(input: {
  /** The active account's address on this network (a multisig's own address when one is active). */
  eoa: string;
  /** The active account's id (its smart-account salt comes from it). */
  accountIndex: number;
  aa: AaAddressFacts | null;
  /** The accounts the wallet holds a key for (WalletContext accountList). */
  accounts: readonly { name: string; evmAddress: string | null; index: number }[];
  /** The network's stored multisigs (multisig.ts ownMultisigAddresses). */
  multisigs: readonly { address: string; label: string }[];
}): { self: string[]; wallet: string[]; labels: AccountLabel[]; selfNames: { address: string; name: string }[] } {
  const self = walletAddressesFor(input.eoa, input.accountIndex, input.aa);
  const others: string[] = [];
  if (input.aa) {
    for (const a of input.accounts) {
      if (!a.evmAddress || !/^0x[0-9a-fA-F]{40}$/.test(a.evmAddress)) continue;
      others.push(...walletAddressesFor(a.evmAddress, a.index, input.aa).slice(1));
    }
  }
  for (const m of input.multisigs) {
    if (/^0x[0-9a-fA-F]{40}$/.test(m.address)) others.push(m.address);
  }
  return {
    self,
    wallet: dedupe([...self, ...others]),
    labels: activityAccountLabels(input.accounts, input.multisigs, input.aa),
    // Every "yourself" address after the account's own is its smart
    // account (walletAddressesFor: the Kernel counterfactual, a recovered
    // account); as the other party of a sentence it reads "your smart
    // account" (finding F1).
    selfNames: self.slice(1).map((address) => ({ address, name: YOUR_SMART_ACCOUNT })),
  };
}

/** How the viewing regular account's own smart account is named in its sentences. */
export const YOUR_SMART_ACCOUNT = 'your smart account';

/**
 * The row-level sentence for a native movement between the smart account
 * whose history the row is and the ERC-4337 EntryPoint v0.7
 * (0x0000000071727De22E5E9d8BAf0edAc6f37da032, the engine's ENTRYPOINT_V07),
 * or null for every other row (emulator pass of 2026-10-11, finding F4:
 * such rows read only "Sent, −0.000923 test ETH", and the staking bundle's
 * "−0.000747" top-up row carried the bundle's "staked 0.0001 test ETH"
 * sentence, so it could be read as an amount staked).
 *
 * Facts, from eth-infinitism/account-abstraction v0.7.0
 * (contracts/core/StakeManager.sol and EntryPoint.sol):
 *  - ETH sent to the EntryPoint (its receive function) is added to the
 *    SENDER's deposit (depositTo(msg.sender)); a smart account sends it
 *    while it validates an operation (missingAccountFunds) or a top-up, and
 *    the deposit pays that account's network fees first; the unused part
 *    of a prefund is credited back to the deposit (_incrementDeposit), not
 *    sent back;
 *  - ETH leaves the EntryPoint only through withdrawTo (from a deposit),
 *    withdrawStake (from a stake) or the fee payment to a bundle's
 *    beneficiary (_compensate), so ETH from the EntryPoint is "paid out by
 *    the EntryPoint", without guessing which.
 *
 * Only rows whose queried address is a smart account qualify:
 * `smartAccountRow` is true for a row of the smart account's history next
 * to a regular account (isSmartAccountEntry) and for every row of an active
 * multisig. The amount is exact (no rounding) and masked by Hide amounts.
 */
export function entryPointRowSentence(
  entry: HistoryEntry,
  options: { smartAccountRow: boolean; nativeSymbol: string; hidden: boolean },
): string | null {
  if (!options.smartAccountRow) return null;
  if (entry.assetSymbol !== undefined || entry.assetAmount !== undefined) return null;
  if (entry.amount === undefined || entry.amount <= 0n) return null;
  if (!entry.counterparty || entry.counterparty.toLowerCase() !== ENTRYPOINT_V07.toLowerCase()) return null;
  const amount = `${maskAmount(formatExactUnits(entry.amount, 18), options.hidden)} ${options.nativeSymbol}`;
  if (entry.direction === 'out') return `EntryPoint deposit: ${amount} set aside for this smart account’s network fees`;
  if (entry.direction === 'in') return `EntryPoint payout: ${amount} paid to this smart account by the EntryPoint`;
  return null;
}

/**
 * What one Activity row says (finding F5): the row-level EntryPoint
 * sentence when there is one (computed from the row itself, so it is there
 * on the first render); else the decoded transaction's sentence; else
 * nothing, with `loading` true while a decode may still bring one (the row
 * then tells a screen reader its details are loading).
 */
export function activityRowText(input: {
  entryPoint: string | null;
  sentence: string | null;
  mayDecode: boolean;
}): { sentence: string | null; loading: boolean } {
  if (input.entryPoint) return { sentence: input.entryPoint, loading: false };
  if (input.sentence) return { sentence: input.sentence, loading: false };
  return { sentence: null, loading: input.mayDecode };
}

/** The accessibility label of a row whose details are still loading (prefix). */
export const ROW_DETAILS_LOADING_LABEL = 'Transaction, details loading';

/**
 * The one smart-account address whose history the Activity screen lists
 * next to the account's own (smart-account-history.ts), known without a
 * network request: the recovered account attached to this owner if any
 * (the wallet's smart-account sends then use it), else the Kernel v3.3
 * counterfactual when Kernel is the network's account type with a factory.
 * Null without settings, for an owner upgraded with EIP-7702 (its smart
 * account is its own address, already listed), for a SimpleAccount (its
 * address needs a factory call), and for a multisig or watch-only id
 * (walletAddressesFor adds nothing for them).
 */
export function historySmartAccountFor(eoa: string, accountIndex: number, aa: AaAddressFacts | null): string | null {
  if (!aa) return null;
  const lower = eoa.toLowerCase();
  if ((aa.eip7702Owners ?? []).some((owner) => owner.toLowerCase() === lower)) return null;
  const recovered = aa.recoveredAccounts?.find((l) => l.owner.toLowerCase() === lower)?.account ?? null;
  if (recovered && /^0x[0-9a-fA-F]{40}$/.test(recovered)) return recovered;
  const addresses = walletAddressesFor(eoa, accountIndex, aa);
  return addresses.length > 1 ? addresses[1]! : null;
}

/** "Lido wstETH contract 0xB823…067b": how a sentence names a pinned staking contract. */
export function stakingContractLabel(contract: PinnedStakingContract): string {
  return `${contract.protocol} ${contract.name} contract ${shortActivityAddress(contract.address)}`;
}

/**
 * The phrase for a call to a pinned staking contract, or null for the
 * generic wording ("Called 0x… with …"). Only the selectors the wallet
 * itself builds (STAKING_SELECTORS, each copied from the protocol's
 * source in staking.ts) are described, each only on the contract it
 * belongs to, and only with a value that call can carry (a payable stake
 * needs a value; every other call none). What the logs show the account
 * sent or received follows after a colon (added by the engine).
 *
 * A Rocket Pool deposit goes to the deposit pool, whose address the
 * wallet resolves from RocketStorage when it quotes and does not pin, so
 * it keeps the generic wording.
 */
export function stakingCallPhrase(
  contract: PinnedStakingContract | null,
  call: { to: string; selector: string | null; value: bigint },
  format: { native: (amount: bigint) => string; nativeSymbol: string },
): string | null {
  if (!contract) return null;
  const short = shortActivityAddress(contract.address);
  const selector = call.selector === null ? null : call.selector.toLowerCase();
  const is = (key: keyof typeof STAKING_SELECTORS) => selector === STAKING_SELECTORS[key].toLowerCase();
  if (contract.protocol === 'Lido' && contract.name === 'stETH') {
    if (is('lidoSubmit') && call.value > 0n) return `staked ${format.native(call.value)} with Lido (stETH contract ${short})`;
    return null;
  }
  if (contract.protocol === 'Lido' && contract.name === 'wstETH') {
    // Lido's wstETH contract stakes ETH sent to it and wraps the stETH in
    // one step (its receive function; the Staking screen's "Stake → wstETH").
    if (selector === null) {
      return call.value > 0n ? `staked ${format.native(call.value)} with Lido and wrapped it into wstETH (wstETH contract ${short})` : null;
    }
    if (call.value !== 0n) return null;
    if (is('wstethWrap')) return `wrapped stETH into wstETH with Lido (wstETH contract ${short})`;
    if (is('wstethUnwrap')) return `unwrapped wstETH into stETH with Lido (wstETH contract ${short})`;
    return null;
  }
  if (contract.protocol === 'Lido' && contract.name === 'withdrawal queue') {
    if (call.value !== 0n) return null;
    if (is('requestWithdrawals') || is('requestWithdrawalsWstETH')) {
      return `requested a withdrawal from Lido (withdrawal queue contract ${short})`;
    }
    if (is('claimWithdrawals') || is('claimWithdrawal')) {
      return `claimed withdrawn ${format.nativeSymbol} from Lido (withdrawal queue contract ${short})`;
    }
    return null;
  }
  if (contract.protocol === 'Rocket Pool' && contract.name === 'rETH') {
    if (call.value === 0n && is('rethBurn')) return `burned rETH for ${format.nativeSymbol} with Rocket Pool (rETH contract ${short})`;
    return null;
  }
  return null;
}

/** The sentence for one decoded transaction, rendered for the current preferences. */
export function renderActivitySentence(decoded: DecodedActivity, options: SentenceRenderOptions): string {
  const pinnedAt = options.stakingContractAt;
  const labels = options.accountLabels ?? [];
  const nameFor = (address: string): string | null => {
    const contact = findExactContact(options.networkId, address, options.contacts)?.name ?? null;
    if (contact) return contact;
    const lower = address.toLowerCase();
    const own = labels.find((l) => l.address.toLowerCase() === lower);
    if (own) return own.label;
    const pinned = pinnedAt ? pinnedAt(address) : null;
    return pinned ? stakingContractLabel(pinned) : null;
  };
  const describeCall: ActivitySentenceContext['describeCall'] = pinnedAt
    ? (call, format) => stakingCallPhrase(pinnedAt(call.to), call, format)
    : undefined;
  return activitySentence(decoded.description, {
    nativeSymbol: options.nativeSymbol,
    tokens: decoded.tokens,
    nameFor,
    maskAmount: (text) => maskAmount(text, options.hidden),
    ...(describeCall ? { describeCall } : {}),
    ...(options.selfAddresses ? { selfAddresses: options.selfAddresses } : {}),
    ...(options.selfNames ? { selfNames: options.selfNames } : {}),
  });
}

/** The parts of an AA chain configuration (./aa.ts AaChainConfig) this module reads. */
export interface AaAddressFacts {
  accountType: string;
  factory: string | null;
  factoryImplementation: string | null;
  kernelValidator: string | null;
  recoveredAccounts?: { owner: string; account: string }[];
  /** Owners upgraded with EIP-7702 on this network (their smart account is their own address). */
  eip7702Owners?: string[];
}

/**
 * The wallet's addresses for decoding on one network: the account's EOA,
 * plus the smart-account addresses that are known WITHOUT a network
 * request — the Kernel v3.3 counterfactual address (engine
 * predictKernelAddress with the verified factory, the account's salt
 * (smartAccountSaltFor: the index, or 0 for an imported key), the
 * configured validator) when Kernel is the chain's account type,
 * and a recovered account attached to this owner. SimpleAccount addresses
 * need a factory call and are not included, so their operations read as
 * "from other accounts".
 *
 * `multisigs` (phase 18 item 3) are the wallet's own multi-signature
 * accounts on this network, as multisig.ts ownMultisigAddresses returns them
 * ({ address, label: "Multisig 1 (2-of-3)" }). Every one is added, so a
 * multisig's operations inside an EntryPoint bundle are described as the
 * wallet's operations with the multisig as their sender. Malformed
 * addresses are skipped. The Activity screen no longer passes them here: it
 * uses activityAddressSets, which adds them to the decode set but keeps
 * them out of the "yourself" set, so a send to a multisig reads "to
 * Multisig 2 (2-of-3)" (emulator re-check of 2026-10-11, finding 2).
 */
export function walletAddressesFor(
  eoa: string,
  accountIndex: number,
  aa: AaAddressFacts | null,
  multisigs: readonly { address: string; label: string }[] = [],
): string[] {
  const out = [eoa];
  for (const m of multisigs) {
    if (/^0x[0-9a-fA-F]{40}$/.test(m.address)) out.push(m.address);
  }
  if (!aa) return dedupe(out);
  if (aa.accountType === 'kernel-v3.3' && aa.factory) {
    try {
      out.push(
        predictKernelAddress(eoa, {
          // The account's CREATE2 salt: its derivation index, or 0 for an
          // imported key's account (account-ids.ts, ADR D9).
          index: BigInt(smartAccountSaltFor(accountIndex)),
          factory: aa.factory,
          ...(aa.factoryImplementation ? { implementation: aa.factoryImplementation } : {}),
          ...(aa.kernelValidator ? { ecdsaValidator: aa.kernelValidator } : {}),
        }),
      );
    } catch {
      // A malformed stored value adds nothing.
    }
  }
  const recovered = aa.recoveredAccounts?.find((l) => l.owner.toLowerCase() === eoa.toLowerCase());
  if (recovered) out.push(recovered.account);
  return dedupe(out);
}

/** Addresses without repeats, compared over the 20 bytes (first spelling kept). */
function dedupe(addresses: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of addresses) {
    const key = a.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}
