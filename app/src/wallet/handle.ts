// Explicit .ts extensions on relative imports: this module is loaded by
// scripts/check-handle.mjs under Node's type stripping (the staking.ts /
// bridge.ts precedent).
import {
  ENS_V2_MIN_LABEL_LENGTH,
  ENS_V2_SEPOLIA,
  ENS_V2_SEPOLIA_REGISTRAR_LIMITS,
  ENS_V2_SEPOLIA_USDC,
  EnsRegisterError,
  checkEnsHandleLabel,
  checkEnsSubLabel,
  classifyEnsRegisterRevert,
  encodeErc20Approve,
  encodeErc20BalanceOf,
  encodeFunctionCall,
  ensOwnedResolverSalt,
  ensRegisterWindow,
  namehash,
  newEnsCommitSecret,
  planEnsRegistration,
  planEnsSubname,
  quoteEnsRegistration,
  readEnsCommitmentAt,
  readEnsNameState,
  readEnsOwnedResolver,
  readEnsPrimaryName,
  resolveEnsAddress,
  revertDataOf,
  toBytes,
  toHex,
  type Call,
  type EnsHandleLabelCheck,
  type EnsOwnedResolverState,
  type EnsPrimaryName,
  type EnsRegisterWindow,
  type EnsRegistrationPlan,
  type EnsRegistrationQuote,
  type EnsSubnamePlan,
  type JsonRpcTransport,
} from '@shiba-wallet/chains-evm';
import { formatUnits } from './balances.ts';
import { STORE_KEYS, readStoreItem, removeStoreItem, writeStoreItem, type KeyValueStore, type RemovableKeyValueStore } from './store-keys.ts';
import { isFeatureAllowed, readinessRefusal } from '../config/readiness.ts';
import { evmProfileByCaip2 } from '../config/evm-chain.ts';
import { t } from '../i18n/index.ts';
import { spokenShortAddress, withShortAddresses } from '../a11y.ts';

/**
 * A wallet handle (phase 23 item 6, feature 75; docs/WALLET_HANDLES.md): an
 * ENS .eth name registered on Ethereum Sepolia's ENSv2 contracts from the
 * app, the app half over the engine's packages/chains-evm/src/ens-register.ts.
 *
 * What this module decides (pure, no React; loaded by the check script):
 *
 *  - WHERE: Ethereum Sepolia only. The readiness row `wallet-handle`
 *    (testnet-only, enforced) refuses every main network first; any other
 *    test network is refused by the network sentence (ENSv2 runs only on
 *    Sepolia's test deployment; mainnet waits for the ENSv2 launch — the
 *    CTO's decision recorded with the engine half).
 *  - WHO OWNS THE NAME: the active account's regular address (a
 *    recovery-phrase account or an imported key), or its Kernel v3.3 smart
 *    account. Every call is sent by the owner itself (the engine's rule:
 *    the factory derives the resolver from msg.sender, the registrar
 *    charges msg.sender, setName names msg.sender), so a regular owner sends
 *    one transaction per call and a smart owner one operation per step.
 *  - PAYMENT: Circle's Sepolia USDC only (the engine refuses anything else),
 *    for the 28-day minimum term (ENS_V2_SEPOLIA_REGISTRAR_LIMITS
 *    .minRegisterDuration, re-read on-chain by every quote).
 *  - THE WAIT: readiness is decided from the LATEST BLOCK's timestamp on the
 *    endpoint the step is sent through, never from this phone's clock. The
 *    registrar accepts register() only in a block whose timestamp is at
 *    least commit time + 60 s (ETHRegistrar.sol 230–242, read by the engine
 *    as ensRegisterWindow). The live run of 2026-10-25 (AGENTS.md phase 23,
 *    item 6 "the first live wallet handle" and commit f7bc29b) found the
 *    engine's check ready with the latest block exactly at notBefore while
 *    the register pre-flight against load-balanced PublicNode still reverted
 *    CommitmentTooNew; so "ready" here means one more Sepolia slot
 *    (HANDLE_READY_MARGIN_SECONDS = 12, the smoke script's
 *    READY_MARGIN_SECONDS) past notBefore, the countdown is against that
 *    figure, register is pre-flighted (eth_call) before the device prompt,
 *    and a CommitmentTooNew pre-flight is a wait, re-read, never an error.
 *  - THE SECRET: the commitment hides the name behind 32 random bytes
 *    (newEnsCommitSecret). Someone who learns the secret before register()
 *    can front-run the name, so it is kept in ONE wallet-scoped store key
 *    (STORE_KEYS.handlePending, through the storage seam) written BEFORE the
 *    commit is sent, never rendered, never logged, never in a sentence this
 *    module builds, and deleted once the name is registered.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The one network handles are registered on. */
export const HANDLE_CHAIN = 'eip155:11155111';
export const HANDLE_CHAIN_ID = 11155111n;

/** The term this wallet registers (the registrar's minimum, 28 days). */
export const HANDLE_DURATION_SECONDS = ENS_V2_SEPOLIA_REGISTRAR_LIMITS.minRegisterDuration;
export const HANDLE_DURATION_DAYS = Number(HANDLE_DURATION_SECONDS / 86_400n);
export const HANDLE_GRACE_DAYS = Number(ENS_V2_SEPOLIA_REGISTRAR_LIMITS.gracePeriod / 86_400n);

/**
 * One Sepolia slot (12 s): register is attempted only once the latest
 * block's time is at least notBefore + this, so the block that includes it
 * is surely late enough (scripts/testnet/ens-register-smoke.mjs
 * READY_MARGIN_SECONDS, commit f7bc29b).
 */
export const HANDLE_READY_MARGIN_SECONDS = 12n;

/** How often the waiting card re-reads the latest block (a judgement: half a slot). */
export const HANDLE_WAIT_POLL_MS = 6_000;

/** At most this many prepared registrations are kept per wallet (one per account and network). */
export const MAX_PENDING_HANDLES = 8;

/** The default sub-label for the smart account's sub-name (the live shape smart.shibawalletdemo.eth). */
export const HANDLE_SUB_LABEL_DEFAULT = 'smart';

export const HANDLE_USDC = ENS_V2_SEPOLIA_USDC;

/** Exact USDC (six decimals, every digit). */
export function formatUsdc(baseUnits: bigint): string {
  return formatUnits(baseUnits, ENS_V2_SEPOLIA_USDC.decimals, ENS_V2_SEPOLIA_USDC.decimals);
}

/** A block time as "2026-10-25 15:31:12 UTC" (block times only; never this phone's clock). */
export function formatBlockTime(seconds: bigint): string {
  return `${new Date(Number(seconds) * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/** A refusal this module decides itself (shown as its own sentence). */
export class HandleRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandleRefusal';
  }
}

// ---------------------------------------------------------------------------
// Where and for whom
// ---------------------------------------------------------------------------

export type HandleOffer = { ok: true } | { ok: false; reason: 'readiness' | 'network'; text: string };

/**
 * Whether handles are offered on `caip2`: the readiness row first (a main
 * network gets the readiness sentence), then Sepolia only.
 */
export function handleOfferFor(caip2: string): HandleOffer {
  if (!isFeatureAllowed('wallet-handle', caip2)) return { ok: false, reason: 'readiness', text: readinessRefusal('wallet-handle') };
  if (caip2 !== HANDLE_CHAIN) {
    return { ok: false, reason: 'network', text: t('handle.refusal.network', { network: evmProfileByCaip2(caip2)?.label ?? caip2 }) };
  }
  return { ok: true };
}

/** Throws the offer's sentence when handles are not offered on `caip2`. */
export function assertHandleOffered(caip2: string): void {
  const offer = handleOfferFor(caip2);
  if (!offer.ok) throw new HandleRefusal(offer.text);
}

/** Whether the Home link shows (the screen itself refuses everything else again). */
export function handleLinkShown(caip2: string, account: { watchOnly: boolean; multisig?: boolean } | null): boolean {
  return handleAccountRefusal(account) === null && handleOfferFor(caip2).ok;
}

/** The refusal for an account that cannot own a handle from this wallet, or null. */
export function handleAccountRefusal(account: { watchOnly: boolean; multisig?: boolean } | null): string | null {
  if (!account) return t('handle.refusal.noAccount');
  if (account.watchOnly) return t('handle.refusal.watchOnly');
  if (account.multisig === true) return t('handle.refusal.multisig');
  return null;
}

export type HandleOwnerKind = 'regular' | 'smart';

/**
 * The smart account as owner (first slice): only a Kernel v3.3 account set
 * up on this network (factory-derived or recovered), never an EIP-7702
 * upgraded address (its address IS the regular one), SimpleAccount or a
 * multisig. Null when it may own a handle; else the sentence.
 */
export function smartOwnerRefusal(accountType: string | null, configured: boolean): string | null {
  if (!configured || accountType !== 'kernel-v3.3') return t('handle.owner.smartUnavailable');
  return null;
}

// ---------------------------------------------------------------------------
// Labels and errors as sentences
// ---------------------------------------------------------------------------

export type HandleLabelCheck = { ok: true; label: string; name: string } | { ok: false; text: string };

/** The engine's label rule (checkEnsHandleLabel), with each refusal as a sentence. */
export function checkHandleLabel(input: string): HandleLabelCheck {
  const check: EnsHandleLabelCheck = checkEnsHandleLabel(input);
  if (check.ok) return check;
  return { ok: false, text: handleLabelProblemSentence(check.problem) };
}

export function handleLabelProblemSentence(
  problem: 'not-ascii-subset' | 'empty' | 'label-extension' | 'too-long' | 'too-short' | 'not-eth' | 'not-second-level',
): string {
  switch (problem) {
    case 'empty':
      return t('handle.label.empty');
    case 'not-ascii-subset':
      return t('handle.label.notAscii');
    case 'label-extension':
      return t('handle.label.labelExtension');
    case 'too-long':
      return t('handle.label.tooLong');
    case 'too-short':
      return t('handle.label.tooShort', { min: ENS_V2_MIN_LABEL_LENGTH });
    case 'not-eth':
      return t('handle.label.notEth');
    case 'not-second-level':
      return t('handle.label.notSecondLevel');
  }
}

/** The sub-label rule (checkEnsSubLabel) as a sentence. */
export function checkHandleSubLabel(input: string): { ok: true; label: string } | { ok: false; text: string } {
  const check = checkEnsSubLabel(input);
  return check.ok ? check : { ok: false, text: t('handle.sub.invalid') };
}

/** Any error from the quote or plan, as the screen shows it. */
export function describeHandleError(e: unknown, name = ''): string {
  if (e instanceof HandleRefusal) return e.message;
  if ((e as { name?: unknown } | null)?.name === 'FeatureNotAllowedError') return (e as Error).message;
  const detail = e instanceof Error ? e.message : String(e);
  if (e instanceof EnsRegisterError || (e as { name?: unknown } | null)?.name === 'EnsRegisterError') {
    switch ((e as EnsRegisterError).reason) {
      case 'unavailable':
        return t('handle.refusal.taken', { name });
      case 'premium':
        return t('handle.refusal.premium', { name });
      case 'invalid-label':
        return t('handle.label.notAscii');
      case 'wrong-chain':
        return t('handle.refusal.wrongChain', { detail });
      case 'deployment-mismatch':
        return t('handle.refusal.deployment', { detail });
      case 'price-mismatch':
        return t('handle.refusal.price', { detail });
      case 'resolver':
        return t('handle.refusal.resolver', { detail });
      default:
        return t('handle.refusal.other', { detail });
    }
  }
  return t('handle.refusal.other', { detail });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The latest block (number and timestamp) on `node` — the clock the wait is measured on. */
export async function readLatestBlock(node: JsonRpcTransport): Promise<{ number: bigint; timestamp: bigint }> {
  const block = (await node('eth_getBlockByNumber', ['latest', false])) as { number?: unknown; timestamp?: unknown } | null;
  if (!block || typeof block.number !== 'string' || typeof block.timestamp !== 'string') {
    throw new HandleRefusal(t('handle.refusal.noBlock'));
  }
  return { number: BigInt(block.number), timestamp: BigInt(block.timestamp) };
}

function uintWord(raw: unknown): bigint {
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new HandleRefusal(t('handle.refusal.noBlock'));
  return BigInt(raw);
}

/** USDC balance of `owner` (latest). */
export async function readUsdcBalance(node: JsonRpcTransport, owner: string): Promise<bigint> {
  return uintWord(await node('eth_call', [{ to: ENS_V2_SEPOLIA_USDC.address, data: toHex(encodeErc20BalanceOf(owner)) }, 'latest']));
}

/** USDC the ENS registrar may still take from `owner` (latest). */
export async function readRegistrarAllowance(node: JsonRpcTransport, owner: string): Promise<bigint> {
  const data = encodeFunctionCall('allowance(address,address)', [
    { kind: 'address', value: owner },
    { kind: 'address', value: ENS_V2_SEPOLIA.ethRegistrar },
  ]);
  return uintWord(await node('eth_call', [{ to: ENS_V2_SEPOLIA_USDC.address, data: toHex(data) }, 'latest']));
}

/** Everything the review shows before Prepare: the quote, the owner's resolver and its USDC. */
export interface HandleQuote {
  quote: EnsRegistrationQuote;
  resolver: EnsOwnedResolverState;
  usdcBalance: bigint;
}

/**
 * Quotes a handle for `owner`: the engine's quote (chain, configuration,
 * availability, the registrar's price equal to the wallet's mirror, no
 * premium), the owner's resolver, and the owner's USDC, which must cover
 * the fee (the registrar pulls it from the owner itself).
 */
export async function quoteHandle(node: JsonRpcTransport, input: { label: string; owner: string; ownerLabel: string }): Promise<HandleQuote> {
  assertHandleOffered(HANDLE_CHAIN);
  const quote = await quoteEnsRegistration(node, { label: input.label, owner: input.owner, duration: HANDLE_DURATION_SECONDS });
  const resolver = await readEnsOwnedResolver(node, input.owner);
  const usdcBalance = await readUsdcBalance(node, input.owner);
  if (usdcBalance < quote.total) {
    throw new HandleRefusal(
      t('handle.refusal.usdc', {
        fee: formatUsdc(quote.total),
        who: input.ownerLabel,
        have: formatUsdc(usdcBalance),
        short: formatUsdc(quote.total - usdcBalance),
      }),
    );
  }
  return { quote, resolver, usdcBalance };
}

// ---------------------------------------------------------------------------
// The pending registration (the one stored record, with the secret)
// ---------------------------------------------------------------------------

/** What is kept between Prepare and Register. `secret` is never shown, logged or put in a sentence. */
export interface PendingHandle {
  v: 1;
  chain: string;
  /** The regular account whose key signs (the owner itself, or the smart account's owner key). */
  signer: string;
  /** The name's owner: the regular account or its smart account. */
  owner: string;
  ownerKind: HandleOwnerKind;
  label: string;
  name: string;
  resolver: string;
  deploysResolver: boolean;
  /** Decimal strings (bigints in JSON). */
  duration: string;
  total: string;
  /** 0x + 64 hex. Kept until register is mined; then the record is deleted. */
  secret: string;
  commitment: string;
  setsReverse: boolean;
  /** The setAddress transaction when the owner's resolver already existed (regular owner only), for resuming. */
  recordTx: string | null;
  /** When it was prepared (this phone's clock; bookkeeping only, never used for the wait). */
  createdAt: number;
}

const PENDING_KEYS = [
  'v', 'chain', 'signer', 'owner', 'ownerKind', 'label', 'name', 'resolver', 'deploysResolver', 'duration', 'total',
  'secret', 'commitment', 'setsReverse', 'recordTx', 'createdAt',
] as const;

/** The storage key (store-keys.ts; per wallet, so a decoy profile keeps its own). */
export const HANDLE_PENDING_KEY = STORE_KEYS.handlePending.name;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,30})$/;

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Strict parse of one record; null when anything is off. */
export function parsePendingHandle(raw: unknown): PendingHandle | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const keys = Object.keys(r);
  if (keys.length !== PENDING_KEYS.length || !PENDING_KEYS.every((k) => keys.includes(k))) return null;
  if (r.v !== 1 || r.chain !== HANDLE_CHAIN) return null;
  for (const k of ['signer', 'owner', 'resolver'] as const) if (typeof r[k] !== 'string' || !ADDRESS.test(r[k] as string)) return null;
  if (r.ownerKind !== 'regular' && r.ownerKind !== 'smart') return null;
  if (r.ownerKind === 'regular' && !sameAddress(r.owner as string, r.signer as string)) return null;
  if (typeof r.label !== 'string' || typeof r.name !== 'string') return null;
  const label = checkEnsHandleLabel(r.label);
  if (!label.ok || label.label !== r.label || label.name !== r.name) return null;
  if (typeof r.deploysResolver !== 'boolean' || typeof r.setsReverse !== 'boolean') return null;
  if (typeof r.duration !== 'string' || !DECIMAL.test(r.duration) || typeof r.total !== 'string' || !DECIMAL.test(r.total)) return null;
  if (BigInt(r.total) <= 0n || BigInt(r.duration) < ENS_V2_SEPOLIA_REGISTRAR_LIMITS.minRegisterDuration) return null;
  if (typeof r.secret !== 'string' || !HASH.test(r.secret) || /^0x0{64}$/.test(r.secret)) return null;
  if (typeof r.commitment !== 'string' || !HASH.test(r.commitment)) return null;
  if (r.recordTx !== null && (typeof r.recordTx !== 'string' || !HASH.test(r.recordTx))) return null;
  if (typeof r.createdAt !== 'number' || !Number.isFinite(r.createdAt)) return null;
  const record = r as unknown as PendingHandle;
  // The commitment must be the one the stored fields produce (a tamper and
  // consistency check: the screen never trusts a stored hash on its own).
  try {
    if (planFromPending(record).commitment.toLowerCase() !== record.commitment.toLowerCase()) return null;
  } catch {
    return null;
  }
  return record;
}

export interface PendingHandles {
  records: PendingHandle[];
  /** True when the stored document could not be read in full: nothing is written until it is reset. */
  damaged: boolean;
}

/** Reads the wallet's prepared registrations (through the storage seam). */
export async function loadPendingHandles(store: KeyValueStore): Promise<PendingHandles> {
  const raw = await readStoreItem(store, HANDLE_PENDING_KEY);
  if (raw === null) return { records: [], damaged: false };
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { records: [], damaged: true };
  }
  if (typeof doc !== 'object' || doc === null || (doc as { v?: unknown }).v !== 1 || !Array.isArray((doc as { pending?: unknown }).pending)) {
    return { records: [], damaged: true };
  }
  const list = (doc as { pending: unknown[] }).pending;
  if (Object.keys(doc).length !== 2 || list.length > MAX_PENDING_HANDLES) return { records: [], damaged: true };
  const records: PendingHandle[] = [];
  for (const item of list) {
    const parsed = parsePendingHandle(item);
    if (!parsed) return { records, damaged: true };
    records.push(parsed);
  }
  return { records, damaged: false };
}

/** The prepared registration of `signer` on Sepolia, or null. */
export function pendingFor(list: PendingHandles, signer: string): PendingHandle | null {
  return list.records.find((r) => sameAddress(r.signer, signer) && r.chain === HANDLE_CHAIN) ?? null;
}

async function writeAll(store: KeyValueStore, records: PendingHandle[]): Promise<void> {
  await writeStoreItem(store, HANDLE_PENDING_KEY, JSON.stringify({ v: 1, pending: records }));
}

/** Adds or replaces the record of `record.signer` (one per account). Refuses on a damaged store. */
export async function savePendingHandle(store: KeyValueStore, record: PendingHandle): Promise<void> {
  if (!parsePendingHandle(record)) throw new HandleRefusal(t('handle.refusal.recordInvalid'));
  const current = await loadPendingHandles(store);
  if (current.damaged) throw new HandleRefusal(t('handle.store.damaged'));
  const others = current.records.filter((r) => !sameAddress(r.signer, record.signer));
  if (others.length >= MAX_PENDING_HANDLES) throw new HandleRefusal(t('handle.store.full', { max: MAX_PENDING_HANDLES }));
  await writeAll(store, [...others, record]);
}

/** Deletes the record of `signer` (Forget, or after the name is registered). */
export async function forgetPendingHandle(store: KeyValueStore, signer: string): Promise<void> {
  const current = await loadPendingHandles(store);
  if (current.damaged) throw new HandleRefusal(t('handle.store.damaged'));
  await writeAll(store, current.records.filter((r) => !sameAddress(r.signer, signer)));
}

/** Removes the whole document (a damaged store's reset, and the wallet wipe). */
export async function resetPendingHandles(store: RemovableKeyValueStore): Promise<void> {
  if (store.removeItem) await removeStoreItem(store, HANDLE_PENDING_KEY);
  else await writeStoreItem(store, HANDLE_PENDING_KEY, JSON.stringify({ v: 1, pending: [] }));
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/**
 * The engine's plan for a fresh registration (a new secret every time),
 * with the reverse record always set (the handle is the address's primary
 * name), and the record to store before anything is sent.
 */
export function newHandlePlan(input: {
  quoted: HandleQuote;
  signer: string;
  ownerKind: HandleOwnerKind;
  /** This phone's clock (bookkeeping only); now when omitted. */
  createdAt?: number;
  random?: (n: number) => Uint8Array;
}): { plan: EnsRegistrationPlan; record: PendingHandle } {
  const { quote, resolver } = input.quoted;
  if (input.ownerKind === 'regular' && !sameAddress(quote.owner, input.signer)) {
    throw new HandleRefusal(t('handle.refusal.recordInvalid'));
  }
  const secret = input.random ? newEnsCommitSecret(input.random) : newEnsCommitSecret();
  const plan = planEnsRegistration({ quote, resolver, secret, setReverse: true });
  secret.fill(0);
  const record: PendingHandle = {
    v: 1,
    chain: HANDLE_CHAIN,
    signer: input.signer,
    owner: plan.owner,
    ownerKind: input.ownerKind,
    label: plan.label,
    name: plan.name,
    resolver: plan.resolver,
    deploysResolver: plan.deploysResolver,
    duration: plan.duration.toString(),
    total: plan.total.toString(),
    secret: plan.secret,
    commitment: plan.commitment,
    setsReverse: plan.setsReverse,
    recordTx: null,
    createdAt: input.createdAt ?? Date.now(),
  };
  return { plan, record };
}

/**
 * Rebuilds the engine plan from a stored record (after a restart): the same
 * label, owner, resolver, duration, fee and secret give the same calls and
 * the same commitment. The quote fields the plan does not read are zero.
 */
export function planFromPending(record: PendingHandle): EnsRegistrationPlan {
  const quote: EnsRegistrationQuote = {
    label: record.label,
    name: record.name,
    node: toHex(namehash(record.name)),
    owner: record.owner,
    duration: BigInt(record.duration),
    paymentToken: ENS_V2_SEPOLIA_USDC,
    base: BigInt(record.total),
    premium: 0n,
    total: BigInt(record.total),
    expiryIfRegisteredNow: 0n,
    blockNumber: 0n,
    quoteTimestamp: 0n,
    config: {
      rentPriceOracle: ENS_V2_SEPOLIA.rentPriceOracle,
      ethRegistry: ENS_V2_SEPOLIA.ethRegistry,
      ...ENS_V2_SEPOLIA_REGISTRAR_LIMITS,
    },
  };
  const resolver: EnsOwnedResolverState = {
    address: record.resolver,
    salt: ensOwnedResolverSalt(record.owner),
    deployed: !record.deploysResolver,
  };
  const secret = toBytes(record.secret);
  try {
    return planEnsRegistration({ quote, resolver, secret, setReverse: record.setsReverse });
  } finally {
    secret.fill(0);
  }
}

/** The exact-zero approval that removes what the registrar may still take (Forget's "Remove the USDC approval"). */
export function revokeRegistrarApprovalCall(): Call {
  return { to: ENS_V2_SEPOLIA_USDC.address, value: 0n, data: encodeErc20Approve(ENS_V2_SEPOLIA.ethRegistrar, 0n) };
}

// ---------------------------------------------------------------------------
// Readiness (from the latest block, never this phone's clock)
// ---------------------------------------------------------------------------

export type HandleReadiness =
  | { state: 'too-new'; readyAt: bigint; secondsLeft: bigint; expiresAt: bigint }
  | { state: 'ready'; expiresAt: bigint }
  | { state: 'expired'; expiresAt: bigint };

/**
 * Whether register may be sent now, judged from `latestTimestamp` (the
 * latest block on the sending endpoint): ready only once that block is at
 * least one slot past notBefore (so the next block surely is), and only
 * while the next block is still before the window closes.
 */
export function handleRegisterReadiness(
  window: EnsRegisterWindow,
  latestTimestamp: bigint,
  margin: bigint = HANDLE_READY_MARGIN_SECONDS,
): HandleReadiness {
  const readyAt = window.notBefore + margin;
  if (latestTimestamp + margin >= window.expiresAt) return { state: 'expired', expiresAt: window.expiresAt };
  if (latestTimestamp < readyAt) return { state: 'too-new', readyAt, secondsLeft: readyAt - latestTimestamp, expiresAt: window.expiresAt };
  return { state: 'ready', expiresAt: window.expiresAt };
}

export type HandleProgress =
  /** Prepare is not finished: `next` is the first call of the prepare step not yet on-chain (0 record, 1 approval, 2 commit). */
  | { kind: 'prepare'; next: 0 | 1 | 2; done: number }
  | { kind: 'wait'; readiness: Extract<HandleReadiness, { state: 'too-new' }>; latest: bigint }
  | { kind: 'ready'; expiresAt: bigint; latest: bigint }
  | { kind: 'expired'; expiresAt: bigint }
  /** Registered to the owner; the reverse record is still missing. */
  | { kind: 'reverse' }
  /** Registered to the owner and shown for it. */
  | { kind: 'done' }
  /** Registered or reserved by someone else (or otherwise unavailable). */
  | { kind: 'taken' };

/**
 * Where a prepared registration stands, from the chain only: registered
 * (and to whom), then the prepare calls (the resolver's code or the
 * setAddress receipt, the allowance, commitmentAt), then the wait measured
 * on the latest block of `node` — the endpoint the next step is sent
 * through.
 */
export async function readHandleProgress(node: JsonRpcTransport, record: PendingHandle): Promise<HandleProgress> {
  const chainId = BigInt((await node('eth_chainId', [])) as string);
  if (chainId !== HANDLE_CHAIN_ID) throw new HandleRefusal(t('handle.refusal.wrongChain', { detail: `chain ${chainId.toString()}` }));
  const state = await readEnsNameState(node, record.label);
  if (state.status === 2) {
    if (!sameAddress(state.latestOwner, record.owner)) return { kind: 'taken' };
    if (!record.setsReverse) return { kind: 'done' };
    const primary = await readEnsPrimaryName(node, record.owner, HANDLE_CHAIN_ID);
    return primary.status === 'ok' && primary.name === record.name ? { kind: 'done' } : { kind: 'reverse' };
  }
  if (state.status !== 0) return { kind: 'taken' };
  const plan = planFromPending(record);
  const committedAt = await readEnsCommitmentAt(node, toBytes(plan.commitment));
  const total = BigInt(record.total);
  // The prepare calls, in order; the first not on-chain is next. A smart
  // owner's prepare step is one all-or-nothing operation, so its progress
  // is the commitment alone.
  let recordDone: boolean;
  let approvalDone: boolean;
  if (record.ownerKind === 'smart') {
    recordDone = committedAt > 0n;
    approvalDone = committedAt > 0n && (await readRegistrarAllowance(node, record.owner)) >= total;
  } else {
    if (record.deploysResolver) {
      const code = await node('eth_getCode', [record.resolver, 'latest']);
      recordDone = typeof code === 'string' && code !== '0x' && code !== '0x0';
    } else {
      recordDone = record.recordTx !== null && (await readTxStatus(node, record.recordTx)) === 'success';
    }
    approvalDone = (await readRegistrarAllowance(node, record.owner)) >= total;
  }
  const done = [recordDone, approvalDone, committedAt > 0n];
  const next = done.findIndex((d) => !d);
  if (next !== -1) return { kind: 'prepare', next: next as 0 | 1 | 2, done: done.filter(Boolean).length };
  const latest = await readLatestBlock(node);
  const readiness = handleRegisterReadiness(ensRegisterWindow(committedAt), latest.timestamp);
  if (readiness.state === 'expired') return { kind: 'expired', expiresAt: readiness.expiresAt };
  if (readiness.state === 'too-new') return { kind: 'wait', readiness, latest: latest.timestamp };
  return { kind: 'ready', expiresAt: readiness.expiresAt, latest: latest.timestamp };
}

/** One transaction's outcome: mined successfully, mined but reverted, or not mined yet. */
export async function readTxStatus(node: JsonRpcTransport, hash: string): Promise<'success' | 'reverted' | 'pending'> {
  const receipt = (await node('eth_getTransactionReceipt', [hash])) as { status?: unknown } | null;
  if (!receipt) return 'pending';
  return receipt.status === '0x1' ? 'success' : 'reverted';
}

/** Polls a transaction's receipt until it is mined or the time is up. */
export async function waitForTx(
  node: JsonRpcTransport,
  hash: string,
  options: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<'success' | 'reverted' | 'timeout'> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const pollMs = options.pollMs ?? 4_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let waited = 0; ; waited += pollMs) {
    let status: 'success' | 'reverted' | 'pending' = 'pending';
    try {
      status = await readTxStatus(node, hash);
    } catch {
      status = 'pending';
    }
    if (status !== 'pending') return status;
    if (waited >= timeoutMs) return 'timeout';
    await sleep(pollMs);
  }
}

/**
 * How often, and for how long at most, the screen re-reads where a prepared
 * registration stands after one of its steps was included (pass p23-handle
 * finding 3). Before, the screen read again at most 4 times, 4 s apart, and
 * then returned to the card, which re-reads the chain only while it shows
 * the wait: a step whose inclusion the endpoint had not caught up with left
 * the card behind until the user tapped Check now. Now it keeps reading
 * every HANDLE_STEP_POLL_MS for up to HANDLE_STEP_POLL_MAX_MS (both
 * judgements: one read per third of a Sepolia slot, and two minutes, the
 * same order as the receipt wait in waitForTx), showing "Waiting for it to
 * be included…" meanwhile.
 */
export const HANDLE_STEP_POLL_MS = 4_000;
export const HANDLE_STEP_POLL_MAX_MS = 120_000;

/**
 * Reads `read()` until `stale(progress)` is false or `maxMs` has passed,
 * sleeping `intervalMs` between reads. A read that throws counts as stale
 * (a load-balanced endpoint can fail one read); if no read ever succeeded,
 * the last error is thrown. Returns the last progress read and whether it
 * is still stale, with the number of reads (for the checks).
 */
export async function readProgressUntil(
  read: () => Promise<HandleProgress>,
  stale: (p: HandleProgress) => boolean,
  options: { intervalMs?: number; maxMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ progress: HandleProgress; stale: boolean; reads: number }> {
  const intervalMs = options.intervalMs ?? HANDLE_STEP_POLL_MS;
  const maxMs = options.maxMs ?? HANDLE_STEP_POLL_MAX_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let last: HandleProgress | null = null;
  let lastError: unknown = null;
  let reads = 0;
  for (let waited = 0; ; waited += intervalMs) {
    reads += 1;
    try {
      last = await read();
      if (!stale(last)) return { progress: last, stale: false, reads };
    } catch (e) {
      lastError = e;
    }
    if (waited + intervalMs > maxMs) break;
    await sleep(intervalMs);
  }
  if (last === null) throw lastError instanceof Error ? lastError : new Error(String(lastError));
  return { progress: last, stale: true, reads };
}

// ---------------------------------------------------------------------------
// The register pre-flight (before the device prompt)
// ---------------------------------------------------------------------------

export type RegisterPreflight =
  | { kind: 'ok' }
  /** The latest block is not late enough yet (CommitmentTooNew): wait and read again. */
  | { kind: 'too-new' }
  | { kind: 'expired' }
  | { kind: 'taken' }
  | { kind: 'failed'; reason: string };

/**
 * eth_call of register() FROM THE OWNER against the latest block. A
 * CommitmentTooNew answer is a wait, not an error. `node` must keep the
 * JSON-RPC error's `data` (simulation.ts simulationTransport does; the
 * engine's plain httpTransport drops it).
 */
export async function preflightRegister(node: JsonRpcTransport, record: PendingHandle): Promise<RegisterPreflight> {
  const plan = planFromPending(record);
  const call = plan.register.calls[0]!;
  try {
    await node('eth_call', [{ from: record.owner, to: call.to, value: '0x0', data: toHex(call.data) }, 'latest']);
    return { kind: 'ok' };
  } catch (e) {
    const revert = revertDataOf(e);
    if (revert === undefined) {
      const text = e instanceof Error ? e.message : String(e);
      // A node that reports the revert only in its message.
      if (/CommitmentTooNew/.test(text)) return { kind: 'too-new' };
      return { kind: 'failed', reason: text };
    }
    const kind = classifyEnsRegisterRevert(revert);
    if (kind === 'commitmentTooNew') return { kind: 'too-new' };
    if (kind === 'commitmentTooOld') return { kind: 'expired' };
    if (kind === 'nameNotAvailable' || kind === 'labelAlreadyRegistered') return { kind: 'taken' };
    return { kind: 'failed', reason: `${kind} (${revert.slice(0, 10)})` };
  }
}

export type RegisterGateOutcome =
  | { kind: 'authorized' }
  | { kind: 'wait'; progress: HandleProgress }
  | { kind: 'stopped'; text: string }
  | { kind: 'not-authorized' };

/**
 * The order every register (and the regular account's setName after it)
 * goes through before signing: the progress from the latest block, the
 * pre-flight, THEN the device prompt. The prompt is never shown while the
 * chain says "too new" or the pre-flight fails; a CommitmentTooNew
 * pre-flight returns a wait so the screen re-reads instead of erroring.
 */
export async function gateRegister(deps: {
  progress: () => Promise<HandleProgress>;
  preflight: () => Promise<RegisterPreflight>;
  authorize: () => Promise<boolean>;
  name: string;
}): Promise<RegisterGateOutcome> {
  const progress = await deps.progress();
  if (progress.kind === 'wait') return { kind: 'wait', progress };
  if (progress.kind === 'expired') return { kind: 'stopped', text: t('handle.card.expired', { name: deps.name }) };
  if (progress.kind === 'taken') return { kind: 'stopped', text: t('handle.card.taken', { name: deps.name }) };
  if (progress.kind !== 'ready') return { kind: 'stopped', text: t('handle.refusal.notReady', { name: deps.name }) };
  const pre = await deps.preflight();
  if (pre.kind === 'too-new') return { kind: 'wait', progress };
  if (pre.kind === 'expired') return { kind: 'stopped', text: t('handle.card.expired', { name: deps.name }) };
  if (pre.kind === 'taken') return { kind: 'stopped', text: t('handle.card.taken', { name: deps.name }) };
  if (pre.kind === 'failed') return { kind: 'stopped', text: t('handle.preflight.failed', { reason: pre.reason }) };
  return (await deps.authorize()) ? { kind: 'authorized' } : { kind: 'not-authorized' };
}

// ---------------------------------------------------------------------------
// The card's sentences (no sentence ever carries the secret)
// ---------------------------------------------------------------------------

/** The waiting card: the CTO's sentence, every figure from block times. */
export function waitingSentence(name: string, readiness: Extract<HandleReadiness, { state: 'too-new' }>): string {
  return t('handle.card.waiting', {
    name,
    readyAt: formatBlockTime(readiness.readyAt),
    seconds: readiness.secondsLeft.toString(),
    until: formatBlockTime(readiness.expiresAt),
  });
}

/** One line per prepare / register call, for the confirm screens. */
export function handleCallLines(record: PendingHandle, step: 'prepare' | 'register'): string[] {
  const amount = formatUsdc(BigInt(record.total));
  if (step === 'prepare') {
    return [
      record.deploysResolver
        ? t('handle.call.createResolver', { resolver: record.resolver, factory: ENS_V2_SEPOLIA.verifiableFactory, name: record.name, owner: record.owner })
        : t('handle.call.setAddress', { name: record.name, owner: record.owner, resolver: record.resolver }),
      t('handle.call.approve', { amount, base: record.total, registrar: ENS_V2_SEPOLIA.ethRegistrar }),
      t('handle.call.commit', { registrar: ENS_V2_SEPOLIA.ethRegistrar }),
    ];
  }
  return [
    t('handle.call.register', { name: record.name, owner: record.owner, days: HANDLE_DURATION_DAYS, registrar: ENS_V2_SEPOLIA.ethRegistrar, amount }),
    ...(record.setsReverse ? [t('handle.call.setName', { name: record.name, owner: record.owner, reverse: ENS_V2_SEPOLIA.v1ReverseRegistrar })] : []),
  ];
}

/**
 * The numbered text of a step's call lines (pass p23-handle finding 4): a
 * step that sends ONE call (each transaction of a regular account) shows
 * its line without a number, so transaction 2 of 3 no longer reads "1.";
 * a step that sends several calls in one operation (a smart account's
 * batch) numbers them 1, 2, 3 in the order they run.
 */
export function callLineTexts(lines: readonly string[]): string[] {
  return lines.length === 1 ? [...lines] : lines.map((line, i) => `${i + 1}. ${line}`);
}

/**
 * The ENS and USDC contracts this wallet pins on Sepolia, which stay in full
 * when a call line is spoken (the project rule since pass p20d: a confirm
 * screen's contract addresses are read in full on purpose).
 */
export const HANDLE_PINNED_CONTRACT_ADDRESSES: readonly string[] = [
  ENS_V2_SEPOLIA.ethRegistrar,
  ENS_V2_SEPOLIA.verifiableFactory,
  ENS_V2_SEPOLIA.v1ReverseRegistrar,
  ENS_V2_SEPOLIA_USDC.address,
];

/**
 * What a screen reader says for `text` (pass p23-handle finding 12): every
 * address is said short ("0x772e…F44F", a11y.ts spokenShortAddress) except
 * the contract addresses in `keepFull` (case-insensitive), which stay in
 * full. The visible text is unchanged.
 */
export function spokenWithShortAddresses(text: string, keepFull: readonly string[] = []): string {
  if (keepFull.length === 0) return withShortAddresses(text);
  const keep = new Set(keepFull.map((a) => a.toLowerCase()));
  return text.replace(/0x[0-9a-fA-F]{40}\b/g, (a) => (keep.has(a.toLowerCase()) ? a : spokenShortAddress(a)));
}

/** The spoken form of a call line: the pinned contracts and the owner's resolver in full, accounts short. */
export function spokenCallLine(text: string, resolver: string | null = null): string {
  return spokenWithShortAddresses(text, resolver ? [...HANDLE_PINNED_CONTRACT_ADDRESSES, resolver] : HANDLE_PINNED_CONTRACT_ADDRESSES);
}

/** "Transaction id 0x1234…abcd" (pass p23-handle finding 12: the 64 hex digits were read out one by one). */
export function spokenTxId(hash: string): string {
  const short = /^0x[0-9a-fA-F]{64}$/.test(hash) ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash;
  return t('handle.spoken.txId', { id: short });
}

/**
 * The text of the card's polite live region (pass p23-handle finding 11),
 * or null when the card has none. While the registration waits it is the
 * same short sentence for the whole wait — the countdown below it is a
 * plain Text, so TalkBack no longer re-announces it every 12-second block
 * step — and it changes once, to "… can be registered now", when the wait
 * ends; that change is what TalkBack announces (the Bridge screen's
 * live-status pattern, BridgeScreen bridgeLiveStatusText).
 */
export function handleCardLiveText(progress: HandleProgress | null, name: string): string | null {
  if (progress?.kind === 'wait') return t('handle.card.waitingLive', { name });
  if (progress?.kind === 'ready') return t('handle.card.ready', { name, until: formatBlockTime(progress.expiresAt) });
  return null;
}

/** The device-prompt titles. */
export function handlePromptTitle(
  kind: 'prepare' | 'register' | 'reverse' | 'subname' | 'targetReverse' | 'revoke',
  args: { name: string; smart?: boolean; index?: number; count?: number },
): string {
  switch (kind) {
    case 'prepare':
      return args.smart
        ? t('handle.prompt.prepareSmart', { name: args.name })
        : t('handle.prompt.prepare', { name: args.name, index: args.index ?? 1, count: args.count ?? 3 });
    case 'register':
      return args.smart ? t('handle.prompt.registerSmart', { name: args.name }) : t('handle.prompt.register', { name: args.name });
    case 'reverse':
      return t('handle.prompt.reverse', { name: args.name });
    case 'subname':
      return t('handle.prompt.subname', { name: args.name });
    case 'targetReverse':
      return t('handle.prompt.targetReverse', { name: args.name });
    case 'revoke':
      return t('handle.prompt.revoke');
  }
}

// ---------------------------------------------------------------------------
// The sub-name for the smart account (record-only)
// ---------------------------------------------------------------------------

/**
 * The record-only sub-name (the CTO's choice; the live shape
 * smart.shibawalletdemo.eth → the dev Kernel, AGENTS.md phase 23 item 6
 * addendum): one setAddress on the parent owner's resolver, sent by the
 * parent's owner. The target's own reverse record (setName from the smart
 * account) is planned too; the screen offers it only when this wallet can
 * send a smart-account operation for the target.
 */
export async function planHandleSubname(
  node: JsonRpcTransport,
  input: { parentLabel: string; subLabel: string; owner: string; target: string },
): Promise<EnsSubnamePlan> {
  const state = await readEnsNameState(node, input.parentLabel);
  if (state.status !== 2 || !sameAddress(state.latestOwner, input.owner)) {
    throw new HandleRefusal(t('handle.sub.parentNotOwned', { name: `${input.parentLabel}.eth` }));
  }
  const resolver = await readEnsOwnedResolver(node, input.owner);
  return planEnsSubname({
    parentLabel: input.parentLabel,
    subLabel: input.subLabel,
    owner: input.owner,
    target: input.target,
    resolver,
    mode: 'record-only',
    targetReverse: true,
  });
}

/** Whether a sub-name already points somewhere (pass p23-handle finding 10). */
export type SubnameState = { kind: 'points' } | { kind: 'elsewhere'; address: string } | { kind: 'none' };

/**
 * Reads where `subName` (for example smart.alice.eth) points now, forward,
 * through the Universal Resolver (the engine's resolveEnsAddress, the read
 * the emulator pass checked smart.qzv7hk2wmt.eth with): 'points' when its
 * Ethereum address is `target`, 'elsewhere' with the address it has, or
 * 'none' when it has no resolver or no address record. Any other failure
 * (a transport error, an off-chain or malformed answer) is thrown, and the
 * screen then keeps offering "Add the sub-name".
 */
export async function readSubnameState(node: JsonRpcTransport, subName: string, target: string): Promise<SubnameState> {
  try {
    const r = await resolveEnsAddress(node, subName, HANDLE_CHAIN_ID);
    return sameAddress(r.address, target) ? { kind: 'points' } : { kind: 'elsewhere', address: r.address };
  } catch (e) {
    const reason = (e as { name?: unknown; reason?: unknown } | null)?.name === 'EnsResolutionError' ? (e as { reason?: unknown }).reason : null;
    if (reason === 'no-resolver' || reason === 'no-address') return { kind: 'none' };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// The primary name (Home and Receive)
// ---------------------------------------------------------------------------

/** The line Home and Receive show for a primary name, or null for none. */
export function primaryNameLine(primary: EnsPrimaryName | null): string | null {
  if (!primary) return null;
  switch (primary.status) {
    case 'ok':
      return t('handle.primary.ok', { name: primary.name });
    case 'offchain':
      return t('handle.primary.offchain');
    case 'unsupported':
      return t('handle.primary.unsupported');
    case 'none':
      return null;
  }
}

/** The chains whose primary names the wallet reads (the Universal Resolver's reverse on mainnet and Sepolia). */
export function primaryNameChainId(caip2: string): bigint | null {
  if (caip2 === 'eip155:1') return 1n;
  if (caip2 === HANDLE_CHAIN) return HANDLE_CHAIN_ID;
  return null;
}

/**
 * A small cache of primary names by network and address, so Home and
 * Receive show the last answer at once and re-read on focus. A failed read
 * keeps the previous answer (or none); nothing is stored on the phone.
 */
export function createPrimaryNameCache(read: (caip2: string, address: string) => Promise<EnsPrimaryName>) {
  const answers = new Map<string, EnsPrimaryName>();
  const listeners = new Set<() => void>();
  const key = (caip2: string, address: string) => `${caip2}|${address.toLowerCase()}`;
  return {
    get(caip2: string, address: string): EnsPrimaryName | null {
      return answers.get(key(caip2, address)) ?? null;
    },
    async refresh(caip2: string, address: string): Promise<EnsPrimaryName | null> {
      if (primaryNameChainId(caip2) === null) return null;
      try {
        const answer = await read(caip2, address);
        const k = key(caip2, address);
        const before = answers.get(k);
        answers.set(k, answer);
        if (JSON.stringify(before) !== JSON.stringify(answer)) for (const l of [...listeners]) l();
        return answer;
      } catch {
        return answers.get(key(caip2, address)) ?? null;
      }
    },
    forget(caip2: string, address: string): void {
      answers.delete(key(caip2, address));
      for (const l of [...listeners]) l();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
export type PrimaryNameCache = ReturnType<typeof createPrimaryNameCache>;

/**
 * Re-reads the primary name of `address` right after a registration (pass
 * p23-handle finding 1): the screen used to clear the cache and wait for
 * the next focus, so the sub-name section, which needs the name, appeared
 * only after leaving and reopening the screen. Reads up to `attempts`
 * times, `intervalMs` apart, until the answer is `name` (a load-balanced
 * endpoint can lag the block that set it); every answer goes into the
 * cache, whose listeners re-render the screen. Returns the last answer.
 */
export async function refreshPrimaryNameUntil(
  cache: Pick<PrimaryNameCache, 'refresh'>,
  caip2: string,
  address: string,
  name: string,
  options: { attempts?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<EnsPrimaryName | null> {
  const attempts = options.attempts ?? 4;
  const intervalMs = options.intervalMs ?? 4_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let answer: EnsPrimaryName | null = null;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(intervalMs);
    answer = await cache.refresh(caip2, address);
    if (answer?.status === 'ok' && answer.name === name) return answer;
  }
  return answer;
}
