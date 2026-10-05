import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  NodeClient,
  decodeUint256,
  encodeErc20Approve,
  encodeFunctionCall,
  httpTransport as evmHttpTransport,
  toBytes,
  toHex,
  zeroExSwapProvider,
  type Call,
  type SwapQuote,
  type SwapQuoteResult,
} from '@shiba-wallet/chains-evm';
// Explicit .ts extensions: this module is imported by scripts/check-swap.mjs
// under Node's type stripping, which resolves relative specifiers literally
// (same pattern as aa.ts, erc20.ts and send-erc20.ts).
import { prepareEvmSend, type EvmSendQuote } from './send.ts';
import { prepareAaCalls, type AaClientBundle, type AaSendQuote } from './aa.ts';
import { USDC_MAINNET } from './erc20.ts';
import { formatUnits } from './balances.ts';
import type { KeyValueStore } from './tokens.ts';
import { suggestFeesRetryingOnce } from './fee-read.ts';

/**
 * Swap glue for the app (phase 5, item 1): 0x API-key configuration with
 * mandatory verify-before-save, quote fetching through the engine's
 * vendor-neutral SwapQuoteProvider seam (packages/chains-evm/src/swap.ts,
 * zeroExSwapProvider), the ERC-20 allowance check + exact-amount approve
 * step, and the reshaping of a 0x quote into the EXISTING EVM send path
 * (prepareEvmSend / sendEvm) — there is deliberately no second signing or
 * broadcast path here.
 *
 * The API key is user-pasted runtime configuration. It lives in
 * AsyncStorage on this device only and is sent only to api.0x.org (as the
 * 0x-api-key header the engine adapter attaches); it is never bundled,
 * committed, or sent anywhere else. It stays out of expo-secure-store on
 * purpose: wallet/storage.ts remains the only module touching the secure
 * store, which holds only the mnemonic (same reasoning as indexer.ts,
 * whose URLs also embed a user key).
 *
 * Deliberately free of React Native imports (beyond the AsyncStorage
 * default parameter, the aa.ts precedent) so scripts/check-swap.mjs can
 * exercise this exact code under plain Node with fake fetch/transports.
 * All amounts are bigints in base units end to end.
 */

const SWAP_CONFIG_KEY = 'shiba-wallet.swap-config.v1';

/**
 * The 0x Swap API v2 placeholder address for the chain's NATIVE token
 * (ETH). Verified 2026-09-28 from the official documentation page
 * docs.0x.org/evm/0x-swap-api/additional-topics/handling-native-tokens.md:
 * "The sentinel address for Ethereum's native token is
 * 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", used as sellToken or
 * buyToken. The same page states native tokens need NO allowance or
 * approval step — only ERC-20 sells go through the approve flow below.
 * (Mantle and Arc deviate from this convention per the docs; neither is a
 * chain this wallet targets.)
 */
export const NATIVE_TOKEN_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

/**
 * A 0x quote older than this is considered stale at execute time: the
 * calldata embeds the priced route and minBuyAmount, so acting on old
 * numbers either reverts or fills at a price the user did not review.
 * ~60 s is the horizon the flow re-quotes past (and says so).
 */
export const QUOTE_MAX_AGE_MS = 60_000;

export const DEFAULT_SLIPPAGE_BPS = 50; // 0.5%
/** Preset choices offered by the slippage selector. */
export const SLIPPAGE_CHOICES_BPS = [50, 100] as const;
export const MIN_SLIPPAGE_BPS = 1; // 0.01%
/**
 * Upper bound for the custom slippage input. 10% is already a painful
 * worst case for a wallet swap; anything above it is far more likely a
 * typo (or a sandwich-attack gift) than an intent.
 */
export const MAX_SLIPPAGE_BPS = 1000;

// ---------------------------------------------------------------------------
// API-key store (verify-before-save, the aa.ts / indexer.ts discipline)
// ---------------------------------------------------------------------------

export interface SwapConfig {
  apiKey: string | null;
  /** ISO timestamp of the successful save-time verification. */
  verifiedAt: string | null;
}

async function loadRawConfig(store: KeyValueStore): Promise<Record<string, unknown>> {
  try {
    const raw = await store.getItem(SWAP_CONFIG_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    // Corrupt JSON or unavailable storage: behave as unconfigured rather
    // than break Settings or the Swap screen (aa.ts discipline).
    return {};
  }
}

/** The stored swap configuration (nulls when unset). */
export async function getSwapConfig(store: KeyValueStore = AsyncStorage): Promise<SwapConfig> {
  const entry = await loadRawConfig(store);
  const apiKey = typeof entry.apiKey === 'string' && entry.apiKey !== '' ? entry.apiKey : null;
  return {
    apiKey,
    verifiedAt:
      apiKey && typeof entry.verifiedAt === 'string' && entry.verifiedAt !== ''
        ? entry.verifiedAt
        : null,
  };
}

/**
 * Verifies and saves a 0x API key; throws (persisting nothing) when any
 * check fails. Verification is ONE live allowance-holder quote request
 * through the engine's zeroExSwapProvider for a canonical pair with
 * minimal parameters: chain 1, 0.001 ETH (the native sentinel) into USDC
 * (the address verified in ./erc20.ts), taker = the wallet's own address.
 * The canonical pair is pinned to mainnet regardless of test mode because
 * this checks the KEY, which is chain-independent, and the pair must be
 * one that verifiably exists; swap-screen quotes always use the ACTIVE
 * chain id.
 *
 * Outcome mapping (0x answers auth failures with 401/403 per its API
 * reference — docs.0x.org/api-reference/evm-ap-is/swap/
 * allowanceholder-getquote.md lists 403 for authorization failures; 401 is
 * handled identically for safety):
 *  - quote ok, or an honest no-liquidity answer: the key works — persist;
 *  - HTTP 401/403: the key was rejected — refuse with a key message;
 *  - any other failure (HTTP 5xx, malformed response, network error):
 *    refuse with a retryable message; the key might be fine, but an
 *    unverified key is never persisted.
 */
export async function setSwapApiKey(
  key: string,
  taker: string,
  options: { store?: KeyValueStore; fetchFn?: typeof fetch } = {},
): Promise<void> {
  const store = options.store ?? AsyncStorage;
  const trimmed = key.trim();
  if (!/^\S+$/.test(trimmed)) {
    throw new Error('Enter the 0x API key (a single token with no spaces).');
  }

  const provider = zeroExSwapProvider({
    apiKey: trimmed,
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
  });
  let result: SwapQuoteResult;
  try {
    result = await provider.getQuote({
      chainId: 1n,
      sellToken: NATIVE_TOKEN_ADDRESS,
      buyToken: USDC_MAINNET.assetId.reference,
      sellAmount: 1_000_000_000_000_000n, // 0.001 ETH — a quote, nothing is traded
      taker,
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Could not reach the swap service to verify the key (${detail}). ` +
        'Nothing was saved — check your connection and try again.',
    );
  }
  if (!result.ok && result.reason === 'error') {
    if (result.detail && /HTTP (401|403) /.test(result.detail)) {
      throw new Error(
        'The swap service rejected this API key (authorization failed). ' +
          'Nothing was saved — check the key on your 0x dashboard and paste it again.',
      );
    }
    throw new Error(
      `The verification quote failed (${result.detail ?? 'unknown error'}). ` +
        'Nothing was saved — the key may still be valid; try again in a moment.',
    );
  }
  // ok, or no-liquidity: either way the service accepted the key.
  await store.setItem(
    SWAP_CONFIG_KEY,
    JSON.stringify({ apiKey: trimmed, verifiedAt: new Date().toISOString() }),
  );
}

/** Removes the stored 0x API key. */
export async function clearSwapApiKey(store: KeyValueStore = AsyncStorage): Promise<void> {
  await store.setItem(SWAP_CONFIG_KEY, JSON.stringify({}));
}

// ---------------------------------------------------------------------------
// Quotes (engine seam) and their display arithmetic
// ---------------------------------------------------------------------------

export interface SwapQuoteParams {
  apiKey: string;
  /** ACTIVE chain id, decimal string from the EVM chain profile. */
  chainIdDecimal: string;
  /** Sell asset: an ERC-20 contract address or NATIVE_TOKEN_ADDRESS. */
  sellToken: string;
  buyToken: string;
  /** Exact input in the sell asset's base units. */
  sellAmount: bigint;
  /** The wallet address holding the sell asset and sending the swap tx. */
  taker: string;
  slippageBps: number;
  fetchFn?: typeof fetch;
}

export interface SwapQuoteView {
  result: SwapQuoteResult;
  /** Date.now() when the quote came back; drives the staleness check. */
  quotedAt: number;
}

/**
 * One quote through the engine's zeroExSwapProvider. The chain id comes
 * from the ACTIVE profile (config/evm-chain.ts) — never hardcoded — so
 * Sepolia test mode sends chainId 11155111. Note recorded from the docs
 * check on 2026-09-28: 0x's published supported-chain list
 * (docs.0x.org/docs/introduction/supported-chains.md) contains mainnets
 * only and does NOT list Sepolia, so test-mode quotes are expected to come
 * back as an error result, which the screen renders honestly.
 */
export async function fetchSwapQuote(params: SwapQuoteParams): Promise<SwapQuoteView> {
  const provider = zeroExSwapProvider({
    apiKey: params.apiKey,
    ...(params.fetchFn ? { fetchFn: params.fetchFn } : {}),
  });
  const result = await provider.getQuote({
    chainId: BigInt(params.chainIdDecimal),
    sellToken: params.sellToken,
    buyToken: params.buyToken,
    sellAmount: params.sellAmount,
    taker: params.taker,
    slippageBps: params.slippageBps,
  });
  return { result, quotedAt: Date.now() };
}

/** Plain language for the two failure arms of the SwapQuoteResult union. */
export function describeSwapFailure(result: { ok: false; reason: 'no-liquidity' | 'error'; detail?: string }): string {
  if (result.reason === 'no-liquidity') {
    return (
      'No liquidity is available for this pair and amount right now — the ' +
      'swap service found no route. Try a different amount or pair.'
    );
  }
  return `The quote failed: ${result.detail ?? 'unknown error from the swap service'}.`;
}

/** True when a quote is too old to act on and must be refreshed first. */
export function isQuoteStale(quotedAt: number, now: number = Date.now()): boolean {
  return now - quotedAt > QUOTE_MAX_AGE_MS;
}

/**
 * Validates the custom-slippage input: an integer number of basis points
 * within [MIN_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS]. Throws with a plain message
 * otherwise — slippage silently clamped would misrepresent the guarantee
 * the minBuyAmount line makes.
 */
export function validateSlippageBps(text: string): number {
  const trimmed = text.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error('Slippage must be a whole number of basis points (100 bps = 1%).');
  }
  const bps = Number(trimmed);
  if (bps < MIN_SLIPPAGE_BPS || bps > MAX_SLIPPAGE_BPS) {
    throw new Error(
      `Slippage must be between ${MIN_SLIPPAGE_BPS} and ${MAX_SLIPPAGE_BPS} bps ` +
        `(${MAX_SLIPPAGE_BPS / 100}%). Very high slippage invites being front-run.`,
    );
  }
  return bps;
}

/**
 * The implied rate as "buy units per 1 sell unit", exact-bigint arithmetic:
 * scale buyAmount by 10^sellDecimals, divide by sellAmount, format with
 * the buy asset's decimals. Integer division truncates toward zero, which
 * for a displayed rate is the honest direction (never overstate what a
 * unit buys). Display-only; nothing signs or checks against this number.
 */
export function impliedRate(
  sellAmount: bigint,
  buyAmount: bigint,
  sellDecimals: number,
  buyDecimals: number,
): string {
  if (sellAmount <= 0n) return '—';
  // Multiplication loop, not 10n ** BigInt(n): same Hermes-conservatism as
  // formatUnits/parseUnits in ./balances.ts.
  let scale = 1n;
  for (let i = 0; i < sellDecimals; i++) scale *= 10n;
  return formatUnits((buyAmount * scale) / sellAmount, buyDecimals);
}

/**
 * The sell-side balance refusal, shared by screen and script: refuse
 * before quoting when the sell amount exceeds what the wallet holds.
 * (Fees are checked later by prepareEvmSend: in ETH, on top of the value
 * for native sells, alongside a zero value for token sells.)
 */
export function assertSellBalance(sellAmount: bigint, balance: bigint, symbol: string): void {
  if (sellAmount > balance) {
    throw new Error(
      `Selling ${sellAmount} base units of ${symbol} exceeds the balance ` +
        `of ${balance} base units.`,
    );
  }
}

/**
 * Our own worst-case ETH fee for the 0x transaction, alongside the 0x gas
 * figure: gas (the quote's own estimate) × maxFeePerGas from the SAME
 * NodeClient.suggestFees the send flow prices with. Null when the quote
 * carried no gas estimate — never a guessed number.
 */
export async function estimateSwapFee(
  url: string,
  quote: SwapQuote,
): Promise<{ zeroExGas: bigint | null; maxFeePerGas: bigint; worstCaseFee: bigint | null }> {
  const node = new NodeClient(evmHttpTransport(url));
  const fees = await suggestFeesRetryingOnce(node);
  const zeroExGas = quote.transaction.gas ?? null;
  return {
    zeroExGas,
    maxFeePerGas: fees.maxFeePerGas,
    worstCaseFee: zeroExGas === null ? null : zeroExGas * fees.maxFeePerGas,
  };
}

// ---------------------------------------------------------------------------
// ERC-20 sell allowance: check + exact-amount approve (no second send path)
// ---------------------------------------------------------------------------

const ALLOWANCE_SIGNATURE = 'allowance(address,address)';

/**
 * allowance(owner, spender) via eth_call, engine encodeFunctionCall +
 * decodeUint256 end to end. The spender the swap flow checks is exactly
 * the quote's transaction.to (the 0x allowance-holder contract the quoted
 * calldata pulls funds through).
 */
export async function fetchErc20Allowance(
  url: string,
  token: string,
  owner: string,
  spender: string,
): Promise<bigint> {
  const transport = evmHttpTransport(url);
  const data = encodeFunctionCall(ALLOWANCE_SIGNATURE, [
    { kind: 'address', value: owner },
    { kind: 'address', value: spender },
  ]);
  const result = (await transport('eth_call', [{ to: token, data: toHex(data) }, 'latest'])) as string;
  return decodeUint256(result);
}

/** Allowance state for the confirm flow's approve gating. */
export async function checkAllowance(
  url: string,
  token: string,
  owner: string,
  spender: string,
  sellAmount: bigint,
): Promise<{ allowance: bigint; sufficient: boolean }> {
  const allowance = await fetchErc20Allowance(url, token, owner, spender);
  return { allowance, sufficient: allowance >= sellAmount };
}

/**
 * Builds the approve transaction as an ordinary EvmSendQuote through
 * prepareEvmSend: value 0, `to` = the token contract, `data` =
 * approve(spender, amount) from the engine's encodeErc20Approve — so the
 * fee quoting, chain-id verification, eth_call simulation and (later)
 * signing/broadcast are byte-for-byte the existing send path.
 *
 * DELIBERATE: the approval is for EXACTLY the sell amount, never
 * unlimited. An unlimited approval would let the spender contract move the
 * user's whole balance forever if it were ever compromised; approving the
 * exact amount costs one approve per swap and caps the exposure at what
 * the user already chose to trade. The UI says this out loud.
 */
export async function prepareApproveSend(
  url: string,
  from: string,
  token: string,
  spender: string,
  amount: bigint,
  expectedCaip2: string,
): Promise<EvmSendQuote> {
  const data = encodeErc20Approve(spender, amount);
  return prepareEvmSend(url, from, token, 0n, data, expectedCaip2);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls allowance(owner, spender) until it covers `min` (the approve has
 * mined and taken effect) or the timeout passes. Waiting matters twice:
 * the swap's eth_call pre-flight runs against latest state and would fail
 * while the approve is pending, and a mined approve also means the next
 * nonce is unambiguous. Returns false on timeout — the caller states it
 * plainly instead of proceeding into a doomed simulation.
 */
export async function waitForAllowance(
  url: string | (() => Promise<string>),
  token: string,
  owner: string,
  spender: string,
  min: bigint,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    sleepFn?: (ms: number) => Promise<void>;
    /**
     * Called with each failed poll's error and the URL it went to (null
     * when resolving the URL itself failed). The app reports default-
     * endpoint failures here, so the next poll's URL resolution moves to a
     * healthy candidate (phase 9 item 5).
     */
    onPollError?: (error: unknown, url: string | null) => void;
  } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollMs = options.pollMs ?? 3_000;
  const sleepFn = options.sleepFn ?? sleep;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // A function URL is resolved on every poll: the allowance is chain
    // state, so any healthy endpoint of the same chain gives a valid answer,
    // and a dead one must not stall the whole waiting window.
    let pollUrl: string | null = null;
    try {
      pollUrl = typeof url === 'string' ? url : await url();
      if ((await fetchErc20Allowance(pollUrl, token, owner, spender)) >= min) return true;
    } catch (error) {
      // Transient RPC failures just mean "not confirmed yet" here.
      options.onPollError?.(error, pollUrl);
    }
    if (Date.now() >= deadline) return false;
    await sleepFn(pollMs);
  }
}

// ---------------------------------------------------------------------------
// Execute: the 0x transaction through the EXISTING send machinery
// ---------------------------------------------------------------------------

/**
 * Reshapes the quoted 0x transaction {to, data, value} into the existing
 * EVM send pipeline: prepareEvmSend re-verifies the endpoint's chain id
 * against the ACTIVE profile, prices the gas, checks the ETH balance
 * (value + worst-case fee) and runs the eth_call pre-flight over the 0x
 * calldata — and the resulting EvmSendQuote is later signed and broadcast
 * by send.ts's sendEvm, exactly like any other send. No second path.
 */
export async function prepareSwapSend(
  url: string,
  from: string,
  quote: SwapQuote,
  expectedCaip2: string,
): Promise<EvmSendQuote> {
  return prepareEvmSend(
    url,
    from,
    quote.transaction.to,
    quote.transaction.value,
    toBytes(quote.transaction.data),
    expectedCaip2,
  );
}

// ---------------------------------------------------------------------------
// Smart-account swaps (phase 7 item 2): ONE atomic batch
// ---------------------------------------------------------------------------

/**
 * The calls a smart-account swap executes as ONE UserOperation, in order:
 *  - ERC-20 sell: [approve(spender = the quote's transaction.to, exactly
 *    the sell amount), the quoted 0x call];
 *  - native sell: [the quoted 0x call] (native ETH needs no approval per
 *    the 0x docs cited at NATIVE_TOKEN_ADDRESS).
 * The approve is included for every ERC-20 sell, even when an allowance
 * already exists: approve() SETS the allowance, so the batch leaves exactly
 * the sell amount approved for the swap to consume — never more, and
 * never an unlimited allowance. Both calls run in the account's single
 * execute, so if the swap reverts the approve is undone with it.
 *
 * The quote must have been requested with the SMART ACCOUNT as taker (it
 * holds the sell asset and executes the call).
 */
export function aaSwapCalls(sellToken: string | null, quote: SwapQuote): Call[] {
  const swapCall: Call = {
    to: quote.transaction.to,
    value: quote.transaction.value,
    data: toBytes(quote.transaction.data),
  };
  if (sellToken === null) return [swapCall];
  return [
    { to: sellToken, value: 0n, data: encodeErc20Approve(quote.transaction.to, quote.sellAmount) },
    swapCall,
  ];
}

/**
 * Smart-account swap quote: the batch above through the shared AA quote
 * (prepareAaCalls) — chain-id check, smart-account native balance against
 * value + worst-case fee (fee 0 when sponsored), the smart account's token
 * balance against the sell amount for ERC-20 sells, and the bundler's
 * eth_estimateUserOperationGas as the pre-flight gate (a reverting swap
 * fails estimation with the bundler's message).
 */
export async function prepareAaSwap(
  bundle: AaClientBundle,
  ownerAddress: string,
  sell: { token: string; symbol: string } | null,
  quote: SwapQuote,
): Promise<AaSendQuote> {
  return prepareAaCalls(bundle, ownerAddress, aaSwapCalls(sell?.token ?? null, quote), {
    displayTo: quote.transaction.to,
    ...(sell ? { tokenSpend: { contract: sell.token, amount: quote.sellAmount, symbol: sell.symbol } } : {}),
  });
}
