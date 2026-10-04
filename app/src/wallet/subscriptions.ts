import {
  ENTRYPOINT_V07,
  KERNEL_PERMISSION_MODULES,
  SUBSCRIPTION_NATIVE,
  describePeriod,
  describeSubscription,
  isNativeSubscription,
  nextPullAllowedAt,
  parseSessionKeyGrant,
  parseSubscription,
  readSubscriptionState,
  serializeSubscription,
  sessionNonceKey,
  subscriptionPeriodCount,
  subscriptionToGrant,
  type JsonRpcTransport,
  type NextPull,
  type SessionKeyGrant,
  type SubscriptionChainState,
  type SubscriptionDescription,
  type SubscriptionGrant,
} from '@shiba-wallet/chains-evm';
// Explicit .ts extensions: this module is imported by
// scripts/check-subscriptions.mjs under Node's type stripping.
import { formatUnits, parseUnits } from './balances.ts';
import { EVM_CHAIN_ID, validateRecipient } from './send.ts';
import { knownTokensForChain, type KeyValueStore } from './tokens.ts';
import {
  eip155Decimal,
  releaseSessionKey,
  sessionVaultId,
  type SessionKeyVault,
  type SessionRecord,
  type SessionSubscriptionMeta,
} from './sessions.ts';

/**
 * Subscriptions (phase 12 item 2, app half): a grant TEMPLATE on the
 * Sessions screen, on the engine's kernel-subscription.ts. A subscription is
 * an ordinary session (./sessions.ts) whose single allowed call pays one
 * merchant at most X of one token (or the native currency), with a rate limit
 * of one operation per period, a fee budget and an expiry, all enforced by
 * the subscriber's Kernel account on-chain. It is installed through the SAME
 * explicit, owner-signed path as any session (prepareSessionInstall →
 * installSession → the normal confirm with the biometric gate), and revoked
 * the same way.
 *
 * WHO HOLDS THE KEY. The session key is generated on this device and kept in
 * the secure vault only until the subscriber hands it to the merchant: the
 * key is shown ONCE (QR and text, buildSubscriptionKeyExport) and, when the
 * subscriber confirms the hand-over, deleted from the device
 * (markSubscriptionKeyExported → releaseSessionKey). After that the wallet
 * can no longer pull — only revoke. This mirrors the ERC-7715 pattern, where
 * the dApp holds its session key and the wallet keeps the public grant.
 *
 * WHAT IS AND IS NOT ENFORCED: see the engine's module header. The review
 * always shows the engine's caveats, first among them that one pull can hold
 * several transfers (the account checks each transfer against the cap but
 * cannot refuse a batch), so the per-period amount is NOT a hard on-chain
 * total.
 */

/** Period choices; the short ones exist because subscriptions are test-network-only (readiness gate). */
export const SUBSCRIPTION_PERIOD_PRESETS: readonly { label: string; seconds: number }[] = [
  { label: '2 minutes (testing)', seconds: 120 },
  { label: '1 hour', seconds: 3600 },
  { label: '1 day', seconds: 86400 },
  { label: '7 days', seconds: 7 * 86400 },
  { label: '30 days', seconds: 30 * 86400 },
];

/** Most payments one subscription may allow from the form (the engine allows more). */
export const SUBSCRIPTION_MAX_PAYMENTS = 120;

/**
 * Gas units budgeted per pull for the default fee budget. Measured on Sepolia
 * on 2026-10-03 (subscription-keeper.mjs live run through ZeroDev's bundler):
 * the three native pulls were signed with preVerificationGas +
 * verificationGasLimit + callGasLimit — what GasPolicy charges — of 367,706,
 * 302,094 and 302,094 gas (keeper padding included). An ERC-20 pull adds the
 * token transfer and two parameter checks (not measured live), so the default
 * rounds up to 500,000. A default, shown and editable, not a guarantee.
 */
export const SUBSCRIPTION_PULL_GAS_ALLOWANCE = 500_000n;

export const SUBSCRIPTION_KEY_EXPORT_TYPE = 'shiba-wallet:subscription-key';

export const SUBSCRIPTION_KEY_WARNING =
  'This is the subscription key. Whoever holds it can take payments from your account within the ' +
  'limits above until you revoke or it expires. Give it only to the merchant, over a channel you trust. ' +
  'It is shown once: after you confirm the hand-over it is deleted from this device.';

export const SUBSCRIPTION_AUDIT_NOTE =
  'Subscriptions use ZeroDev’s ECDSASigner, CallPolicy v0.0.4, TimestampPolicy, GasPolicy and ' +
  'RateLimitPolicy. No published audit names these modules (engine notes, kernel-permissions.ts).';

/** A token the form offers: the native currency, or a known ERC-20 on the active chain. */
export interface SubscriptionTokenChoice {
  /** SUBSCRIPTION_NATIVE or the ERC-20 address. */
  token: string;
  symbol: string;
  decimals: number;
}

/** Native first, then the chain's known tokens (tokens.ts: Circle-documented and on-chain checked). */
export function subscriptionTokenChoices(chainCaip2: string, nativeSymbol: string): SubscriptionTokenChoice[] {
  return [
    { token: SUBSCRIPTION_NATIVE, symbol: nativeSymbol, decimals: 18 },
    ...knownTokensForChain(chainCaip2).map((t) => ({ token: t.assetId.reference, symbol: t.symbol, decimals: t.decimals })),
  ];
}

/**
 * Default fee budget: payments × SUBSCRIPTION_PULL_GAS_ALLOWANCE × the
 * node's current maxFeePerGas × 2 (fees move). GasPolicy refuses a pull
 * that would exceed what is left, so the merchant then needs a new grant.
 */
export function defaultFeeBudgetWei(payments: number, maxFeePerGas: bigint): bigint {
  return BigInt(payments) * SUBSCRIPTION_PULL_GAS_ALLOWANCE * maxFeePerGas * 2n;
}

export interface SubscriptionDraft {
  merchant: string;
  /** One of subscriptionTokenChoices(). */
  choice: SubscriptionTokenChoice;
  /** Decimal amount per period in the token's units. */
  amount: string;
  periodSeconds: number;
  /** How many payments (periods) the grant covers. */
  payments: string;
  /** Total fee budget in the native currency (decimal). */
  feeBudget: string;
  label: string;
}

/**
 * Form → SubscriptionGrant. Input errors get plain messages; the engine's
 * validateSubscription then checks everything else and its text is shown
 * verbatim. The first period starts now, so the first payment can be taken
 * as soon as the grant is installed.
 */
export function buildSubscription(draft: SubscriptionDraft, context: { now: number; account?: string }): SubscriptionGrant {
  const merchant = validateRecipient(EVM_CHAIN_ID, draft.merchant);
  if (!merchant.ok) throw new Error(`Merchant: ${merchant.error}`);
  let amountPerPeriod: bigint;
  try {
    amountPerPeriod = parseUnits(draft.amount, draft.choice.decimals);
  } catch (e) {
    throw new Error(`Amount: ${(e as Error).message}`);
  }
  if (amountPerPeriod <= 0n) throw new Error('Amount: enter more than zero.');
  if (!SUBSCRIPTION_PERIOD_PRESETS.some((p) => p.seconds === draft.periodSeconds)) throw new Error('Choose a period.');
  const payments = Number(draft.payments.trim());
  if (!Number.isInteger(payments) || payments < 1 || payments > SUBSCRIPTION_MAX_PAYMENTS) {
    throw new Error(`Number of payments: a whole number from 1 to ${SUBSCRIPTION_MAX_PAYMENTS}.`);
  }
  let feeBudgetWei: bigint;
  try {
    feeBudgetWei = parseUnits(draft.feeBudget, 18);
  } catch (e) {
    throw new Error(`Fee budget: ${(e as Error).message}`);
  }
  const sub: SubscriptionGrant = {
    merchant: merchant.normalized,
    token: draft.choice.token,
    amountPerPeriod,
    periodSeconds: draft.periodSeconds,
    startAt: context.now,
    validUntil: context.now + payments * draft.periodSeconds,
    feeBudgetWei,
    label: draft.label.trim(),
  };
  return sub;
}

/** The engine's grant for the subscription (validates; throws the engine's sentence). */
export function subscriptionGrantFor(
  sub: SubscriptionGrant,
  sessionKey: string,
  context: { account: string; now: number },
): SessionKeyGrant {
  return subscriptionToGrant(sub, sessionKey, { account: context.account, now: context.now });
}

/** The meta stored with the session record (keyExportedAt null until the hand-over). */
export function subscriptionMeta(sub: SubscriptionGrant, choice: SubscriptionTokenChoice): SessionSubscriptionMeta {
  return { terms: serializeSubscription(sub), tokenSymbol: choice.symbol, tokenDecimals: choice.decimals, keyExportedAt: null };
}

/** The plain-language review: the engine's sentence, on-chain limits and caveats. */
export function subscriptionReview(
  sub: SubscriptionGrant,
  context: { tokenSymbol: string; tokenDecimals: number; nativeSymbol: string; merchantName?: string | null },
): SubscriptionDescription {
  return describeSubscription(sub, {
    symbol: context.tokenSymbol,
    decimals: context.tokenDecimals,
    nativeSymbol: context.nativeSymbol,
    merchantName: context.merchantName ?? null,
  });
}

/** The subscription records of a session list (source 'subscription' with valid terms). */
export function subscriptionRecords(records: readonly SessionRecord[]): SessionRecord[] {
  return records.filter((r) => r.source === 'subscription' && r.subscription);
}

export function termsOf(record: SessionRecord): SubscriptionGrant {
  if (!record.subscription) throw new Error('Not a subscription.');
  return parseSubscription(record.subscription.terms);
}

// ---------------------------------------------------------------------------
// Key hand-over (shown once)
// ---------------------------------------------------------------------------

export interface SubscriptionKeyExport {
  type: typeof SUBSCRIPTION_KEY_EXPORT_TYPE;
  version: 1;
  chainId: string;
  /** The subscriber's Kernel account (the sender of every pull). */
  account: string;
  entryPoint: string;
  kernelVersion: '0.3.3';
  permissionId: string;
  /** EntryPoint nonce key of the permission (hex). */
  nonceKey: string;
  signerModule: string;
  signatureFormat: string;
  /** The session private key (0x + 64 hex). */
  sessionPrivateKey: string;
  sessionKey: string;
  /** The terms (public), so the merchant's keeper can check every pull locally. */
  subscription: ReturnType<typeof serializeSubscription>;
}

/**
 * Reads the key from the vault and builds the hand-over payload. Refused when
 * the key was already handed over (it is no longer on the device) or the
 * install has not been confirmed on-chain yet.
 */
export async function buildSubscriptionKeyExport(record: SessionRecord, vault: SessionKeyVault): Promise<SubscriptionKeyExport> {
  if (record.source !== 'subscription' || !record.subscription) throw new Error('Not a subscription.');
  if (!record.keyHeld || record.subscription.keyExportedAt !== null) {
    throw new Error('The key was already handed over and is no longer on this device. Revoke and create a new subscription if it was lost.');
  }
  if (record.localStatus !== 'installed') {
    throw new Error('Wait until the subscription is confirmed on-chain before handing over its key.');
  }
  const stored = await vault.load(sessionVaultId(record.chain, record.account, record.permissionId));
  if (!stored || !/^0x[0-9a-fA-F]{64}$/.test(stored)) throw new Error('The subscription key is not on this device.');
  const grant = parseSessionKeyGrant(record.grant);
  return {
    type: SUBSCRIPTION_KEY_EXPORT_TYPE,
    version: 1,
    chainId: eip155Decimal(record.chain).toString(),
    account: record.account,
    entryPoint: ENTRYPOINT_V07,
    kernelVersion: '0.3.3',
    permissionId: record.permissionId,
    nonceKey: '0x' + sessionNonceKey(record.permissionId).toString(16),
    signerModule: KERNEL_PERMISSION_MODULES.ecdsaSigner,
    signatureFormat: '0xff || 65-byte EIP-191 signature of the userOpHash by the session key',
    sessionPrivateKey: stored.toLowerCase(),
    sessionKey: grant.sessionKey,
    subscription: record.subscription.terms,
  };
}

/**
 * After the subscriber confirms the hand-over: deletes the key from the vault
 * and records the time. From then on the wallet cannot pull or show the key
 * again; it can only revoke.
 */
export async function markSubscriptionKeyExported(
  record: SessionRecord,
  store: KeyValueStore,
  vault: SessionKeyVault,
  now: number = Date.now(),
): Promise<SessionRecord> {
  if (record.source !== 'subscription' || !record.subscription) throw new Error('Not a subscription.');
  return releaseSessionKey(record, store, vault, { subscription: { ...record.subscription, keyExportedAt: now } });
}

/** Key status in plain words. */
export function subscriptionKeyStatusText(record: SessionRecord): string {
  if (!record.subscription) return '';
  if (record.subscription.keyExportedAt !== null) {
    return `Key handed to the merchant ${new Date(record.subscription.keyExportedAt).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')} and deleted from this device.`;
  }
  if (record.keyHeld) return 'Key still on this device: hand it to the merchant (shown once).';
  return 'Key no longer on this device.';
}

// ---------------------------------------------------------------------------
// On-chain status: next pull, pulls left, fee budget left
// ---------------------------------------------------------------------------

export type SubscriptionStatus =
  | { kind: 'ok'; state: SubscriptionChainState; next: NextPull }
  | { kind: 'unknown'; reason: string };

export async function readSubscriptionStatus(
  node: JsonRpcTransport,
  record: SessionRecord,
  now: number = Math.floor(Date.now() / 1000),
): Promise<SubscriptionStatus> {
  try {
    const terms = termsOf(record);
    const state = await readSubscriptionState(node, record.account, record.permissionId, terms);
    return { kind: 'ok', state, next: nextPullAllowedAt(state, now) };
  } catch (e) {
    return { kind: 'unknown', reason: e instanceof Error ? e.message : String(e) };
  }
}

function utc(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

/** Status lines for the Subscriptions list. */
export function subscriptionStatusLines(record: SessionRecord, status: SubscriptionStatus, nativeSymbol: string): string[] {
  if (status.kind === 'unknown') return [`Status unknown: ${status.reason}`];
  const terms = termsOf(record);
  const total = subscriptionPeriodCount(terms);
  const used = total - status.state.remainingPulls;
  const lines: string[] = [];
  switch (status.next.kind) {
    case 'now':
      lines.push(`Next payment: due now (open since ${utc(status.next.at)}).`);
      break;
    case 'later':
      lines.push(`Next payment: not before ${utc(status.next.at)}.`);
      break;
    case 'used-up':
      lines.push('All payments taken.');
      break;
    case 'ended':
      lines.push(`Ended ${utc(terms.validUntil)}.`);
      break;
    case 'inactive':
      lines.push('Not active on-chain (revoked or never installed).');
      break;
  }
  if (status.next.kind !== 'inactive') {
    lines.push(`${used} of ${total} payment${total === 1 ? '' : 's'} taken.`);
    lines.push(`Fee budget left: ${formatUnits(status.state.feeBudgetLeftWei, 18, 18)} ${nativeSymbol}.`);
  }
  return lines;
}

/** One-line summary for a list card: "5 USDC every 30 days to <merchant>". */
export function subscriptionSummary(record: SessionRecord, merchantName?: string | null): string {
  const terms = termsOf(record);
  const meta = record.subscription!;
  const amount = `${formatUnits(terms.amountPerPeriod, meta.tokenDecimals, meta.tokenDecimals)} ${meta.tokenSymbol}`;
  const who = merchantName ? `${merchantName} (${terms.merchant})` : terms.merchant;
  return `${amount} every ${describePeriod(terms.periodSeconds)} to ${who}${isNativeSubscription(terms) ? '' : ` (token ${terms.token})`}`;
}
