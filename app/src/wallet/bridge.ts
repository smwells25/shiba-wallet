import {
  CCTP_DEPOSIT_FOR_BURN_SELECTOR,
  CCTP_FINALITY_STANDARD,
  CCTP_RECEIVE_MESSAGE_SELECTOR,
  CCTP_V2_PROVIDER_ID,
  CCTP_V2_TESTNET,
  CCTP_V2_TESTNET_DOMAINS,
  CCTP_V2_TESTNET_USDC,
  CCTP_V2_TRUST,
  LAYERZERO_OFT_PROVIDER_ID,
  LAYERZERO_OFT_TRUST,
  LAYERZERO_V2_TESTNET,
  MAX_EXACT_APPROVAL,
  OFT_SEND_LAYOUT,
  OFT_SEND_SELECTOR,
  STARGATE_RETRY_RECEIVE_TOKEN_SELECTOR,
  STARGATE_V2_TESTNET_NATIVE_POOLS,
  addressToBytes32,
  createBridgeRegistry,
  createCctpV2Provider,
  createLayerZeroOftProvider,
  decodeCctpBurnMessage,
  encodeReceiveMessage,
  httpTransport as evmHttpTransport,
  layerZeroEidFor,
  cctpTimeEstimate,
  oftTimeEstimate,
  toHex,
  type BridgeAttestation,
  type BridgeEventLogReader,
  type BridgeLog,
  type BridgeProvider,
  type BridgeQuote,
  type BridgeReceiptLogReader,
  type BridgeRegistry,
  type BridgeRoute,
  type BridgeTimeEstimate,
  type BridgeTransferStatus,
  type BridgeTrustStatement,
  type Call,
  type CctpAttestationFetcher,
  type JsonRpcTransport,
  type LayerZeroMessageStatusReader,
  type OftDeployment,
} from '@shiba-wallet/chains-evm';
// Explicit .ts extensions: this module is loaded by scripts/check-bridge.mjs
// under Node's type stripping, which resolves relative specifiers literally
// (the staking.ts / swap.ts precedent).
import { L1_DATA_FEE_HEADROOM_PERCENT, prepareEvmSend, type EvmSendQuote } from './send.ts';
import {
  AsyncStorage,
  readStoreItem,
  removeStoreItem,
  storeProfileOf,
  writeStoreItem,
  STORE_KEYS,
  type KeyValueStore,
  type RemovableKeyValueStore,
} from './store-keys.ts';
import { prepareAaCalls, summarizeAaReceipt, type AaClientBundle, type AaSendQuote } from './aa.ts';
import { formatUnits } from './balances.ts';
import { assertFeatureAllowed } from '../config/readiness.ts';
import { evmProfileByCaip2, isBuiltInEvmChain, type EvmChainProfile } from '../config/evm-chain.ts';
import { isEndpointFailure } from '../config/endpoint-probe.ts';

/**
 * Bridge glue (feature 35, phase 21 item 1, the in-app slice). The
 * providers live in the engine (packages/chains-evm/src/bridge/: the
 * BridgeProvider interface, the registry, the LayerZero OFT adapter with
 * Stargate V2's native pools, and the Circle CCTP V2 adapter); the design
 * is docs/BRIDGE_PROVIDERS.md and the research docs/BRIDGING.md sections
 * 4 and 15–16. This module decides what the Bridge screen OFFERS on which
 * network, supplies the network readers the adapters need (they make no
 * request of their own), checks every quote independently before it is
 * shown, and reshapes the quoted call into the EXISTING send paths —
 * prepareEvmSend for the regular account and prepareAaCalls for a Kernel
 * smart account. There is no second signing or broadcast path here.
 *
 * DECISIONS (phase 21 item 1, the in-app slice):
 *  - The user chooses the provider (the Chairperson's decision of
 *    2026-10-14). Every registered provider is listed with its own trust
 *    statement, in registration order; the wallet never picks one.
 *  - Two assets, each with its own provider (phase 23 item 4, the app
 *    half): test ETH through LayerZero (Stargate's native pools, Ethereum,
 *    Arbitrum and OP Sepolia) and USDC through Circle CCTP V2 (Standard
 *    Transfers only, between the four CCTP test networks; proven live by
 *    scripts/testnet/cctp-smoke.mjs on 2026-10-25, docs/BRIDGING.md section
 *    17). The user picks the asset; the provider rows list the providers
 *    that move it; the wallet never picks a provider.
 *  - Test ETH: the recipient is always the active account's REGULAR
 *    address on the receiving network, also when the smart account sends:
 *    Stargate hands ETH over with a 2,300-gas transfer, which a deployed
 *    smart account cannot accept (docs/BRIDGING.md section 15.8), so the
 *    ETH would wait in the pool for a retryReceiveToken. When the regular
 *    address itself holds code on the receiving network, the confirm says
 *    so, and the tracking panel offers the retry call when the chain shows
 *    the cache.
 *  - USDC: the recipient is the regular account by default, and the smart
 *    account may be chosen: CCTP mints USDC with an ordinary ERC-20 mint,
 *    which needs no code at the recipient and has no 2,300-gas limit. The
 *    regular account sends two transactions (the exact approval, then the
 *    burn once the approval is confirmed), each with its own device prompt;
 *    the smart account sends both as ONE self-paid operation (one prompt).
 *    Circle's USDC-fee paymaster is not offered on this path. After
 *    Circle's attestation the screen offers the mint (receiveMessage) from
 *    the regular account when the receiving network is the active one;
 *    anyone with gas there may send it instead.
 *  - Transfer records are STORED on the phone (shiba-wallet.bridge-
 *    transfers.v1, a per-wallet key of the storage seam, store-keys.ts), the
 *    newest 64, so tracking survives a restart: what was sent, a CCTP
 *    transfer's attested message once Circle signed it (so the mint can be
 *    offered again without asking Circle), and, once known, the final
 *    status (delivered or failed). A status that is not final is not
 *    stored; the screen asks again. The attested message is one more
 *    record key; a record written before it (without the key) still loads,
 *    and the document stays version 1 (see BRIDGE_STORE_VERSION). The store is parsed
 *    strictly: a damaged document is read-only (the valid records are
 *    shown, nothing is written, "Reset the transfer list" clears it), as
 *    for the pending-transaction registry. The source transaction itself is
 *    recorded by the existing pending registry (sendEvm's listener, or
 *    sendAa's operation listener, kind 'bridge'), so Speed up / Cancel
 *    cover a stuck bridge send.
 *
 * Every entry point calls assertFeatureAllowed('bridge', chain) before any
 * network request (readiness row 'bridge', test networks only, enforced).
 * Deliberately free of React Native imports so scripts/check-bridge.mjs
 * runs this exact code under Node with fakes. Amounts are bigints in wei.
 */

/**
 * A plain refusal from this module: its message is the whole sentence to
 * show, and nothing was quoted, signed or sent. Errors from the adapters
 * (the engine's refusals) and from the send paths keep their own types and
 * words; the screen shows the engine's sentences verbatim.
 */
export class BridgeRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeRefusal';
  }
}

/** The readiness row this feature is gated by (config/readiness.ts). */
export const BRIDGE_FEATURE = 'bridge' as const;

/** The label the LayerZero adapter is registered under in the app. */
export const LAYERZERO_APP_LABEL = 'LayerZero (Stargate)';

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export const BRIDGE_INTRO =
  'Bridging moves test ETH or USDC from this network to another test network. A bridge provider carries the transfer, and ' +
  'you trust the provider’s contracts and verifiers while it is on its way, so each provider below says who that is. ' +
  'These are test networks: the coins have no value.';

/** Under the provider list: the wallet does not choose. */
export const BRIDGE_CHOICE_NOTE =
  'You choose the provider. The wallet lists every provider it knows for this asset and this pair of networks and never picks one for you.';

/**
 * The note under the provider list for the network the form is on (the
 * p21b follow-up): BRIDGE_CHOICE_NOTE where some provider can send from it
 * (the destination chips are shown, so "this pair" exists); where none can
 * (Base Sepolia: the chips are hidden and every row says why it cannot
 * serve the network) a sentence naming only the source network; and no note
 * where no provider is listed at all (Hoodi, a network the user added: the
 * warning above already says no provider serves it).
 */
export function bridgeChoiceNote(offer: Pick<BridgeOffer, 'unavailable' | 'sourceLabel'>, rowCount: number): string | null {
  if (rowCount === 0) return null;
  if (bridgeFormInputsShown(offer)) return BRIDGE_CHOICE_NOTE;
  return `The wallet lists every provider it knows, each with the reason it cannot send from ${offer.sourceLabel}, and never picks one for you.`;
}

/** The label the CCTP adapter is registered under (the engine's own). */
export const CCTP_APP_LABEL = 'Circle CCTP (USDC)';

/** A provider that does not serve the chosen pair of networks. */
export function noRouteNote(sourceLabel: string, destinationLabel: string): string {
  return `Does not serve ${sourceLabel} → ${destinationLabel} in this wallet.`;
}

/**
 * A provider that does not serve this network at all, on a network where no
 * destination can be chosen (Base Sepolia today: the destination chips are
 * hidden, so a sentence naming a destination would point at something the
 * user cannot see or pick).
 */
export function noSourceRouteNote(sourceLabel: string): string {
  return `Does not serve ${sourceLabel} in this wallet.`;
}

/** The recipient sentence for a send from the regular account. */
export function regularRecipientNote(recipient: string, destinationLabel: string): string {
  return `The test ETH arrives at your regular account ${recipient} on ${destinationLabel}, the same address as on this network.`;
}

/**
 * The recipient sentence for a send from the smart account (shown on the
 * form before Review and on the confirm): the funds go to the REGULAR
 * account on purpose.
 */
export function smartAccountRecipientNote(recipient: string, destinationLabel: string): string {
  return (
    `Sent from your smart account, the test ETH arrives at your regular account ${recipient} on ${destinationLabel}, not at ` +
    'the smart account. Stargate hands ETH over with a 2,300-gas transfer, which a deployed smart account cannot accept, ' +
    'so the ETH would wait in Stargate’s pool until someone sent a second transaction there. This wallet therefore ' +
    'offers only your regular account as the recipient.'
  );
}

/**
 * The recipient sentence for a send from an account upgraded with EIP-7702
 * (accountType 'kernel-7702'): its "smart account" is the regular address
 * itself, so the sender and the recipient are one address.
 */
export function upgradedAccountRecipientNote(recipient: string, destinationLabel: string): string {
  return (
    `Your smart account is this same address (upgraded with EIP-7702), so the test ETH arrives at ${recipient} on ` +
    `${destinationLabel}, the same address as on this network. An upgrade on this network does not carry over: whether ` +
    'the address has code there is read when you review.'
  );
}

/** The recipient sentence for a plan or a form state (regular, smart account, or an EIP-7702 account). */
export function bridgeRecipientNote(
  senderKind: 'regular' | 'smart-account',
  sender: string,
  recipient: string,
  destinationLabel: string,
): string {
  if (senderKind === 'regular') return regularRecipientNote(recipient, destinationLabel);
  return sender.toLowerCase() === recipient.toLowerCase()
    ? upgradedAccountRecipientNote(recipient, destinationLabel)
    : smartAccountRecipientNote(recipient, destinationLabel);
}

/**
 * The recipient sentence for USDC through CCTP (the regular account, or the
 * smart account when the user chose it). Unlike Stargate's ETH, CCTP mints
 * USDC with an ordinary ERC-20 mint (MintAndWithdraw, then the token's
 * mint), which needs no code at the recipient and has no 2,300-gas limit,
 * so a smart account, deployed there or not, can receive it.
 */
export function usdcRecipientNote(recipientKind: 'regular' | 'smart-account', recipient: string | null, destinationLabel: string): string {
  if (recipientKind === 'regular') {
    return `The USDC is minted to your regular account${recipient ? ` ${recipient}` : ''} on ${destinationLabel}, the same address as on this network.`;
  }
  return (
    `The USDC is minted to your smart account${recipient ? ` ${recipient}` : ''} on ${destinationLabel}, the same address as on this network${recipient ? '' : ' (shown when you review)'}. ` +
    'It does not need to be deployed there: CCTP mints USDC with an ordinary token mint, which needs no code at the ' +
    'recipient, unlike Stargate’s 2,300-gas ETH transfer.'
  );
}

/**
 * The form's sentence when the smart account would receive USDC but cannot
 * be offered as the recipient on that network (its Kernel factory is not
 * verified there, so its address there is not known to be the same).
 */
export function usdcSmartRecipientUnavailable(destinationLabel: string): string {
  return `Your smart account cannot be chosen as the recipient on ${destinationLabel}: the wallet has not verified the smart-account contracts there, so it cannot say the address is the same. Your regular account receives.`;
}

/** What the confirm says about the recipient's code on the receiving network. */
export type RecipientCodeState = 'none' | 'code' | 'unknown';

export function recipientCodeNote(state: RecipientCodeState, destinationLabel: string): string | null {
  if (state === 'none') return null;
  if (state === 'code') {
    return (
      `Your regular account has contract code on ${destinationLabel} (an account upgrade, for example). Stargate’s ` +
      '2,300-gas delivery may not be accepted there; the ETH would then wait in Stargate’s pool, and the tracking ' +
      'below offers the transaction that delivers it.'
    );
  }
  return `Whether your regular account has contract code on ${destinationLabel} could not be read just now.`;
}

/** The confirm's line about the pinned pool (the risk card does not know Stargate's pools by name). */
export function pinnedPoolLine(pool: string, sourceLabel: string): string {
  return (
    `This transaction goes to Stargate’s native ETH pool on ${sourceLabel} (${pool}), pinned by this wallet from ` +
    'Stargate’s published test-network deployments and checked on-chain on 2026-10-15. The risk card below does not ' +
    'know Stargate’s pools by name.'
  );
}

/** The amount field's hint for USDC (6 decimals; the exact-amount rule, never rounded). */
export function bridgeAmountHint(asset: 'usdc'): string {
  return asset === 'usdc' ? 'USDC has 6 decimal places; an amount with more is refused, not rounded.' : '';
}

/** The "not a promise" framing every time figure carries. */
export const BRIDGE_TIME_NOT_PROMISE =
  'A time measured once is not a promise: delivery waits for the verifiers and the executor, and either can take longer.';

/** Shown under a provider row before a live quote exists. */
export const BRIDGE_FEE_BEFORE_QUOTE = 'Fee: quoted live from the provider’s contracts when you tap Get quotes or Review.';

/**
 * Shown under the provider list when exactly one provider can be chosen
 * (emulator pass p21b, finding 2): the wallet still does not pick it, so
 * the user is told why nothing is selected yet.
 */
export const BRIDGE_SINGLE_PROVIDER_NOTE = 'One provider serves this route; choose it to continue.';

/**
 * The amount field's placeholder (pass p21b, finding 9). Android gives a
 * TextInput's placeholder to the EditText as its hint, and TalkBack reads
 * the hint of an EMPTY field where a value would be ("0.0002. Edit box for
 * Amount (test ETH)" sounded like a filled-in amount). A worded example
 * cannot be mistaken for a value.
 */
export const BRIDGE_AMOUNT_PLACEHOLDER = 'Amount, for example 0.0002';

/**
 * The provider the form uses (pass p21b, finding 2): the user's own choice,
 * and only while that provider can be chosen for the current pair of
 * networks. NEVER a default — not even when a single provider is offered —
 * because the screen says the wallet "never picks one for you". Null until
 * the user taps a row; Get quotes and Review stay disabled until then.
 */
export function chosenBridgeProvider(
  rows: readonly Pick<BridgeProviderRow, 'id' | 'selectable'>[],
  picked: string | null,
): string | null {
  return picked !== null && rows.some((r) => r.id === picked && r.selectable) ? picked : null;
}

/** BRIDGE_SINGLE_PROVIDER_NOTE when exactly one row can be chosen and none is chosen yet, else null. */
export function bridgeProviderChoiceHint(
  rows: readonly Pick<BridgeProviderRow, 'selectable'>[],
  chosen: string | null,
): string | null {
  return chosen === null && rows.filter((r) => r.selectable).length === 1 ? BRIDGE_SINGLE_PROVIDER_NOTE : null;
}

/**
 * Whether the form shows the destination chips and the amount field (pass
 * p21b, finding 7): only when some provider can send from this network.
 * Where none can (Base Sepolia: Stargate has no pool there), the
 * explanatory sentence and the disabled provider rows stay, so the user
 * still sees every provider and who it would trust, but there is nothing to
 * fill in.
 */
export function bridgeFormInputsShown(offer: Pick<BridgeOffer, 'unavailable'>): boolean {
  return offer.unavailable === null;
}

/**
 * What a screen reader says for a provider's radio control (pass p21b,
 * findings 3 and the CCTP row's double period): the label, what it moves,
 * and either "not available" or the fee once quoted. The trust statement,
 * the reason a row cannot be chosen, the fee line and the measured time are
 * separate text items right after the control (BridgeViews.tsx
 * ProviderRadioRow), so they are reachable before Review. Never ends in a
 * period: TalkBack adds its own pause before the role ("…, Radio button"),
 * and a sentence ending in "." was read with a doubled period.
 */
export function providerRowSpokenLabel(
  row: Pick<BridgeProviderRow, 'label' | 'asset' | 'selectable'>,
  quote: { fee: string } | null,
): string {
  const head = `${row.label}${row.asset ? `, moves ${row.asset}` : ''}`;
  const tail = !row.selectable ? ', not available' : quote ? `, fee ${quote.fee}` : '';
  return `${head}${tail}`.replace(/[.\s]+$/, '');
}

/**
 * Runs a broadcast and stamps the time it returned (pass p21b, finding 8).
 * A transfer's "sent" time is the moment the network (or the bundler) took
 * it, measured right where the broadcast resolves — inside the signing
 * callback, before signWith zeroes the seed, before the screen re-renders
 * and before any receipt wait (the smart account's waitForAaReceipt runs
 * after the record is made). The time between the device prompt and this
 * moment is spent BEFORE the broadcast: signWith turns the phrase into the
 * seed (BIP-39's 2,048 PBKDF2 rounds, mnemonicToSeedSync, in JavaScript on
 * the phone) and the transaction is signed; the recorded time cannot and
 * should not include that.
 */
export async function broadcastStamped<T>(broadcast: () => Promise<T>, now: () => number = Date.now): Promise<{ value: T; sentAt: number }> {
  const value = await broadcast();
  return { value, sentAt: now() };
}

/** The record note. */
export const BRIDGE_RECORDS_NOTE =
  'Transfers sent from this screen are kept on this phone (the newest 64) and followed here whenever this screen is open. ' +
  'The sending transaction also appears in Activity.';

/** Shown when the stored transfer list could not be read (it is then read-only). */
export const BRIDGE_RECORDS_READ_ONLY_MESSAGE =
  'The list of bridge transfers on this phone could not be read in full, so it is not changed: transfers sent now are followed only until the app is closed. ' +
  'Reset the transfer list to start a new one; nothing on the network changes.';

// ---------------------------------------------------------------------------
// The registry (providers in registration order: LayerZero, then CCTP)
// ---------------------------------------------------------------------------

/** The network readers the adapters need, supplied by the screen (or by the checks' fakes). */
export interface BridgeReaders {
  /** A JSON-RPC transport for an EIP-155 chain id. For the source, the endpoint the quote is pinned to. */
  transportFor(chainId: number): JsonRpcTransport;
  /** fetch for LayerZero Scan's keyless testnet API; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * The configured bundler's eth_getUserOperationReceipt for an operation
   * sent on `chainId` (null while it is not included). Used only for a
   * smart-account transfer whose bundle transaction is not known yet (the
   * app closed before the receipt arrived); the screen builds it from
   * aa.ts fetchUserOpReceipt. Without it such a transfer waits, as before.
   */
  userOpReceipt?: (request: { chainId: number; userOpHash: string }) => Promise<unknown>;
}

/** Whether a provider can be chosen for sending in this build. */
export type BridgeProviderStatus = 'offered' | 'coming';

/**
 * Providers the screen may send through. Both are offered since phase 23
 * item 4 (CCTP's Standard Transfers were proven live by script on
 * 2026-10-25); a provider registered later starts as 'coming' until it has
 * been proven the same way.
 */
export const BRIDGE_PROVIDER_STATUS: Readonly<Record<string, BridgeProviderStatus>> = Object.freeze({
  [LAYERZERO_OFT_PROVIDER_ID]: 'offered',
  [CCTP_V2_PROVIDER_ID]: 'offered',
});

/**
 * Errors thrown by the network readers (a node or endpoint answered badly or
 * not at all), as opposed to the adapters' own refusals. quoteBridge passes
 * reader errors through unchanged (so the screen's endpoint failover and
 * the send screens' wording apply) and turns every other adapter error into
 * a BridgeRefusal carrying the adapter's sentence verbatim.
 */
const readerErrors = new WeakSet<object>();

function asReaderError(e: unknown): Error {
  const error = e instanceof Error ? e : new Error(String(e));
  readerErrors.add(error);
  return error;
}

/** True for an error a network reader threw (see readerErrors). */
export function isBridgeReaderError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && readerErrors.has(e);
}

const NO_READER = (): never => {
  throw new BridgeRefusal('This provider was built for listing only; nothing can be quoted with it.');
};

/**
 * Builds the app's registry: LayerZero OFT over Stargate V2's native pools
 * and Circle CCTP V2, each with the readers when given (CCTP: Circle's
 * sandbox attestation API, the source receipt and the receiving chain's
 * logs, so its tracking follows the chains' own events). With no readers
 * the registry still lists every provider and route (both lists are pure).
 */
export function createAppBridgeRegistry(
  readers: BridgeReaders | null = null,
  options: { estimateGas?: boolean; destinationFromBlock?: bigint | null; nowMs?: () => number } = {},
): BridgeRegistry {
  const layerZero = createLayerZeroOftProvider({
    deployments: STARGATE_V2_TESTNET_NATIVE_POOLS,
    label: LAYERZERO_APP_LABEL,
    readContract: readers
      ? async ({ chainId, to, data }) => {
          let answer: unknown;
          try {
            answer = await readers.transportFor(chainId)('eth_call', [{ to, data }, 'latest']);
          } catch (e) {
            throw asReaderError(e);
          }
          if (typeof answer !== 'string') throw asReaderError(new Error('The node answered eth_call with something other than hex.'));
          return answer;
        }
      : NO_READER,
    ...(readers
      ? {
          fetchMessageStatus: layerZeroScanReader(readers.fetchImpl),
          readSourceReceipt: sourceReceiptReader(readers),
          readDestinationLogs: destinationLogReader(readers, options.destinationFromBlock ?? null),
        }
      : {}),
    ...(readers && options.estimateGas
      ? {
          estimateGas: async ({ chainId, from, to, value, data }: { chainId: number; from: string; to: string; value: bigint; data: string }) => {
            const answer = await readers.transportFor(chainId)('eth_estimateGas', [{ from, to, value: `0x${value.toString(16)}`, data }]);
            if (typeof answer !== 'string' || !/^0x[0-9a-fA-F]+$/.test(answer)) throw new Error('The node answered eth_estimateGas with something other than a quantity.');
            return BigInt(answer);
          },
        }
      : {}),
  });
  const cctp = createCctpV2Provider(
    readers
      ? {
          fetchAttestation: circleIrisReader(readers.fetchImpl),
          readSourceReceipt: sourceReceiptReader(readers),
          readDestinationLogs: destinationLogReader(readers, options.destinationFromBlock ?? null, BRIDGE_LOG_TOO_OLD_CCTP),
        }
      : {},
  );
  return createBridgeRegistry([layerZero, cctp]);
}

/** The Stargate deployment the wallet pins on a chain, or undefined. */
export function stargatePoolOn(chainId: number): OftDeployment | undefined {
  return STARGATE_V2_TESTNET_NATIVE_POOLS.find((d) => d.chainId === chainId);
}

function chainIdOf(caip2: string): number {
  const m = /^eip155:(\d{1,15})$/.exec(caip2);
  if (!m) throw new BridgeRefusal('Bridging works only on Ethereum networks.');
  return Number(m[1]);
}

function profileOfChain(chainId: number): EvmChainProfile | undefined {
  return evmProfileByCaip2(`eip155:${chainId}`);
}

function labelOfChain(chainId: number): string {
  return profileOfChain(chainId)?.label ?? `chain ${chainId}`;
}

// ---------------------------------------------------------------------------
// What is offered on the active network
// ---------------------------------------------------------------------------

/** What the Bridge screen moves: the network's own coin (test ETH) or Circle's USDC. */
export type BridgeAssetChoice = 'native' | 'usdc';

/** The asset chips, in this order. */
export const BRIDGE_ASSETS: readonly BridgeAssetChoice[] = Object.freeze(['native', 'usdc']);

/** The asset's name on the screen ("test ETH" for the native coin on a test network). */
export function bridgeAssetLabel(asset: BridgeAssetChoice, nativeSymbol = 'test ETH'): string {
  return asset === 'native' ? nativeSymbol : 'USDC';
}

/** The asset's decimals (18 for the coin, 6 for USDC). */
export function bridgeAssetDecimals(asset: BridgeAssetChoice): number {
  return asset === 'native' ? 18 : 6;
}

/** Which asset a route moves. */
export function routeAsset(route: BridgeRoute): BridgeAssetChoice {
  return route.sourceAsset.kind === 'native' ? 'native' : 'usdc';
}

export interface BridgeDestination {
  chainId: number;
  caip2: string;
  label: string;
  /** True when at least one provider can be chosen for sending the asset to it. */
  sendable: boolean;
}

/** One provider row for a chosen destination. */
export interface BridgeProviderRow {
  id: string;
  label: string;
  trust: BridgeTrustStatement;
  /** True when the user may choose it for sending. */
  selectable: boolean;
  /** What it moves on this route, e.g. "test ETH" or "USDC". */
  asset: string | null;
  /** Why it cannot be chosen, or null. */
  note: string | null;
  route: BridgeRoute | null;
  /** The measured delivery time line, or null when this route was never measured. */
  measured: string | null;
  /** The provider's own time sentence (its source, ending in "not a promise"), or null. */
  timeSource: string | null;
}

export interface BridgeOffer {
  caip2: string;
  sourceChainId: number;
  sourceLabel: string;
  /** The asset this offer is for. */
  asset: BridgeAssetChoice;
  destinations: BridgeDestination[];
  /** Every registered provider that moves this asset (in registration order), for the comparison list. */
  providers: { id: string; label: string; trust: BridgeTrustStatement; status: BridgeProviderStatus }[];
  /** A plain sentence when nothing can be sent from this network, else null. */
  unavailable: string | null;
}

/** True when a provider moves the asset on any of its routes. */
function providerMoves(provider: BridgeProvider, asset: BridgeAssetChoice): boolean {
  return provider.supportedRoutes().some((r) => routeAsset(r) === asset);
}

/**
 * What the Bridge screen offers on `caip2` for one asset (pure: no
 * request). Refused on a network the readiness switchboard does not allow,
 * before anything else. Only the built-in test profiles take part: a
 * network the user added has no pinned bridge contracts. Destinations and
 * providers are those of the chosen asset only.
 */
export function bridgeOfferFor(caip2: string, asset: BridgeAssetChoice = 'native'): BridgeOffer {
  assertFeatureAllowed(BRIDGE_FEATURE, caip2);
  const sourceChainId = chainIdOf(caip2);
  const sourceLabel = labelOfChain(sourceChainId);
  const registry = createAppBridgeRegistry();
  const providers = registry
    .list()
    .filter((p) => providerMoves(p, asset))
    .map((p) => ({ id: p.id, label: p.label, trust: p.trust, status: BRIDGE_PROVIDER_STATUS[p.id] ?? 'coming' }));
  const assetName = bridgeAssetLabel(asset, profileOfChain(sourceChainId)?.displaySymbol ?? 'test ETH');
  if (!isBuiltInEvmChain(caip2)) {
    return {
      caip2,
      sourceChainId,
      sourceLabel,
      asset,
      destinations: [],
      providers,
      unavailable: `No bridge provider in this wallet serves ${sourceLabel}: bridging is offered only between the built-in test networks.`,
    };
  }
  const byChain = new Map<number, BridgeDestination>();
  for (const route of registry.routes({ sourceChainId })) {
    if (routeAsset(route) !== asset) continue;
    const profile = profileOfChain(route.destinationChainId);
    if (!profile || !profile.testnet || !isBuiltInEvmChain(profile.caip2)) continue;
    const sendable = BRIDGE_PROVIDER_STATUS[route.providerId] === 'offered';
    const existing = byChain.get(route.destinationChainId);
    if (existing) existing.sendable = existing.sendable || sendable;
    else byChain.set(route.destinationChainId, { chainId: route.destinationChainId, caip2: profile.caip2, label: profile.label, sendable });
  }
  // Destinations in the order the profiles list them, sendable ones first.
  const destinations = [...byChain.values()].sort((a, b) => Number(b.sendable) - Number(a.sendable));
  let unavailable: string | null = null;
  const anyRoute = registry.routes({ sourceChainId }).some((r) => isBuiltInEvmChain(`eip155:${r.destinationChainId}`));
  if (!anyRoute) {
    unavailable = `No bridge provider in this wallet serves ${sourceLabel}.`;
  } else if (destinations.length === 0) {
    unavailable =
      asset === 'native'
        ? `No provider in this wallet can bridge ${assetName} from ${sourceLabel}: Stargate has no pool there.${bridgeAssetSendableFrom(caip2, 'usdc') ? ' Choose USDC above to bridge USDC with Circle CCTP.' : ''}`
        : `No provider in this wallet can bridge USDC from ${sourceLabel}: Circle CCTP is not deployed there.`;
  } else if (!destinations.some((d) => d.sendable)) {
    unavailable = `No provider in this wallet can bridge ${assetName} from ${sourceLabel} yet.`;
  }
  return { caip2, sourceChainId, sourceLabel, asset, destinations, providers, unavailable };
}

/** Whether some offered provider can send the asset from `caip2` (pure). */
export function bridgeAssetSendableFrom(caip2: string, asset: BridgeAssetChoice): boolean {
  if (!isBuiltInEvmChain(caip2)) return false;
  const sourceChainId = chainIdOf(caip2);
  return createAppBridgeRegistry()
    .routes({ sourceChainId })
    .some((r) => routeAsset(r) === asset && BRIDGE_PROVIDER_STATUS[r.providerId] === 'offered' && isBuiltInEvmChain(`eip155:${r.destinationChainId}`));
}

/**
 * The asset the form starts on: test ETH where some provider can send it
 * from this network, else USDC where one can, else test ETH (whose
 * sentence then says why nothing can be sent). The asset is the user's
 * input like the destination chip; the PROVIDER is never chosen for the
 * user.
 */
export function defaultBridgeAsset(caip2: string): BridgeAssetChoice {
  if (bridgeAssetSendableFrom(caip2, 'native')) return 'native';
  if (bridgeAssetSendableFrom(caip2, 'usdc')) return 'usdc';
  return 'native';
}

/** The measured-time line for a route, or null when it was never measured. */
export function measuredTimeLine(time: BridgeTimeEstimate): string | null {
  if (!time.measured) return null;
  return `Measured once on ${time.measured.date}: ${time.measured.seconds} s on this route, from the sending block to the delivery block.`;
}

/**
 * The provider rows for one destination: every registered provider that
 * moves the offer's asset, the offered ones selectable where they have a
 * route, the others with the sentence saying why not. Pure.
 */
export function bridgeProviderRows(offer: BridgeOffer, destinationChainId: number): BridgeProviderRow[] {
  const registry = createAppBridgeRegistry();
  const destinationLabel = labelOfChain(destinationChainId);
  const assetName = bridgeAssetLabel(offer.asset, profileOfChain(offer.sourceChainId)?.displaySymbol ?? 'test ETH');
  return registry
    .list()
    .filter((p) => providerMoves(p, offer.asset))
    .map((p) => {
      const route =
        registry
          .routes({ sourceChainId: offer.sourceChainId, destinationChainId })
          .find((r) => r.providerId === p.id && routeAsset(r) === offer.asset) ?? null;
      const status = BRIDGE_PROVIDER_STATUS[p.id] ?? 'coming';
      let measured: string | null = null;
      let timeSource: string | null = null;
      if (route && p.id === LAYERZERO_OFT_PROVIDER_ID) {
        const pool = stargatePoolOn(offer.sourceChainId);
        const pathway = pool?.pathways[destinationChainId];
        if (pool && pathway) {
          const time = oftTimeEstimate(pool, destinationChainId, pathway.confirmations);
          measured = measuredTimeLine(time);
          timeSource = time.source;
        }
      }
      if (route && p.id === CCTP_V2_PROVIDER_ID) {
        const time = cctpTimeEstimate(offer.sourceChainId, destinationChainId);
        measured = measuredTimeLine(time);
        timeSource = time.source;
      }
      // Where the form hides the destination chips (no provider can send from
      // this network), the reason names only the source network.
      const noRoute = bridgeFormInputsShown(offer) ? noRouteNote(offer.sourceLabel, destinationLabel) : noSourceRouteNote(offer.sourceLabel);
      const note = status === 'coming' ? BRIDGE_PROVIDER_COMING_NOTE : route === null ? noRoute : null;
      return {
        id: p.id,
        label: p.label,
        trust: p.trust,
        selectable: status === 'offered' && route !== null,
        asset: assetName,
        note,
        route,
        measured,
        timeSource,
      };
    });
}

/** A provider registered but not yet offered for sending (none today; see BRIDGE_PROVIDER_STATUS). */
export const BRIDGE_PROVIDER_COMING_NOTE = 'Listed for comparison; not offered for sending in this version.';

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/** LayerZero Scan's keyless testnet API (docs/BRIDGING.md section 15.9; OpenAPI `security: []`). */
export const LAYERZERO_SCAN_TESTNET_API = 'https://scan-testnet.layerzero-api.com/v1';
/** How long one Scan request may take before it is abandoned (as in the live smoke script). */
export const SCAN_TIMEOUT_MS = 15_000;
/** The largest Scan answer read (a message list is a few kilobytes). */
export const SCAN_MAX_BYTES = 256 * 1024;

/**
 * The LayerZero message reader over Scan: GET /messages/tx/{hash}. A 404
 * means "not indexed yet" (null). Only https, a fixed host, a validated
 * hash, a timeout and a size limit; the answer's status and destination
 * hash are validated before use. Scan is supporting evidence only: the
 * adapter decides from the chains' own events (layerzero-oft.ts track()).
 */
export function layerZeroScanReader(fetchImpl?: typeof fetch): LayerZeroMessageStatusReader {
  return async ({ sourceTxHash }) => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(sourceTxHash)) throw new Error('The source transaction hash must be 32 bytes of hex.');
    const fetchFn = fetchImpl ?? fetch;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS) : null;
    try {
      const response = await fetchFn(`${LAYERZERO_SCAN_TESTNET_API}/messages/tx/${sourceTxHash.toLowerCase()}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`LayerZero Scan answered HTTP ${response.status}`);
      const declared = Number(response.headers?.get?.('content-length') ?? NaN);
      if (Number.isFinite(declared) && declared > SCAN_MAX_BYTES) throw new Error('LayerZero Scan sent an answer larger than expected.');
      const body = (await response.json()) as { data?: unknown };
      const messages = Array.isArray(body?.data) ? (body.data as unknown[]) : [];
      const m = messages[0] as { status?: { name?: unknown }; destination?: { tx?: { txHash?: unknown } } } | undefined;
      if (!m) return null;
      const status = typeof m.status?.name === 'string' && /^[A-Z_]{1,40}$/.test(m.status.name) ? m.status.name : 'UNKNOWN';
      const dest = m.destination?.tx?.txHash;
      return {
        status,
        ...(typeof dest === 'string' && /^0x[0-9a-fA-F]{64}$/.test(dest) ? { destinationTxHash: dest } : {}),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

/**
 * Circle's sandbox attestation API (the test networks' host; keyless:
 * the API reference for GET /v2/messages/{sourceDomainId} declares
 * `security: []`, https://developers.circle.com/api-reference/cctp/all/
 * get-messages-v2.md, fetched 2026-10-25, sha256 aba0444f…a478, the same
 * text docs/BRIDGING.md section 17 recorded). The mainnet host
 * iris-api.circle.com is never used: bridging is test-networks-only.
 */
export const CIRCLE_IRIS_SANDBOX_API = 'https://iris-api-sandbox.circle.com';
/** How long one Iris request may take (as in scripts/testnet/cctp-smoke.mjs). */
export const IRIS_TIMEOUT_MS = 15_000;
/** The largest Iris answer read (one message is under 2 KB). */
export const IRIS_MAX_BYTES = 64 * 1024;

/**
 * The attestation reader over Circle's sandbox API: GET
 * /v2/messages/{sourceDomain}?transactionHash={hash}. Read as the API
 * reference documents it (MessagesV2Response: `messages`, an array of
 * MessageV2 with `message` — "0x" until available — `attestation` —
 * "PENDING" until available — and `status` "complete" or
 * "pending_confirmations"; `sourceTxHash` the burn's hash): a 404 or no
 * message yet is pending; exactly one message is required (a burn of this
 * wallet emits one); "complete" with a hex message and a hex attestation is
 * complete; anything else pending. Only https, a fixed host, a validated
 * hash, a timeout and a size limit. The attestation is verified on-chain at
 * the mint (and by the adapter against the burn), so the API can withhold
 * one but cannot redirect funds.
 */
export function circleIrisReader(fetchImpl?: typeof fetch): CctpAttestationFetcher {
  return async ({ sourceDomain, sourceTxHash }) => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(sourceTxHash)) throw new Error('The source transaction hash must be 32 bytes of hex.');
    if (!Number.isInteger(sourceDomain) || sourceDomain < 0 || sourceDomain > 0xffffffff) throw new Error('The CCTP source domain is not a uint32.');
    const fetchFn = fetchImpl ?? fetch;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), IRIS_TIMEOUT_MS) : null;
    try {
      const response = await fetchFn(`${CIRCLE_IRIS_SANDBOX_API}/v2/messages/${sourceDomain}?transactionHash=${sourceTxHash.toLowerCase()}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (response.status === 404) return { status: 'pending' };
      if (!response.ok) throw new Error(`Circle’s attestation service answered HTTP ${response.status}`);
      const declared = Number(response.headers?.get?.('content-length') ?? NaN);
      if (Number.isFinite(declared) && declared > IRIS_MAX_BYTES) throw new Error('Circle’s attestation service sent an answer larger than expected.');
      const body = (await response.json()) as { messages?: unknown; sourceTxHash?: unknown };
      if (typeof body !== 'object' || body === null || !Array.isArray(body.messages)) {
        throw new Error('Circle’s attestation service answered in an unexpected shape.');
      }
      if (typeof body.sourceTxHash === 'string' && body.sourceTxHash.toLowerCase() !== sourceTxHash.toLowerCase()) {
        throw new Error('Circle’s attestation service answered for another transaction.');
      }
      if (body.messages.length === 0) return { status: 'pending' };
      if (body.messages.length !== 1) {
        throw new Error(`Circle’s attestation service returned ${body.messages.length} messages for one burn; the wallet does not pick one.`);
      }
      const m = body.messages[0] as { status?: unknown; message?: unknown; attestation?: unknown };
      if (
        m?.status === 'complete' &&
        typeof m.message === 'string' &&
        /^0x([0-9a-fA-F]{2})+$/.test(m.message) &&
        typeof m.attestation === 'string' &&
        /^0x([0-9a-fA-F]{2})+$/.test(m.attestation)
      ) {
        return { status: 'complete', message: m.message, attestation: m.attestation };
      }
      return { status: 'pending' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

/** The source receipt reader: eth_getTransactionReceipt on the source chain. */
export function sourceReceiptReader(readers: BridgeReaders): BridgeReceiptLogReader {
  return async ({ chainId, txHash }) => {
    const receipt = (await readers.transportFor(chainId)('eth_getTransactionReceipt', [txHash])) as {
      status?: unknown;
      logs?: unknown;
    } | null;
    if (receipt === null || receipt === undefined) return null;
    if (typeof receipt !== 'object' || !Array.isArray(receipt.logs)) throw new Error('The node answered the receipt request in an unexpected shape.');
    const status = receipt.status === '0x1' ? 'success' : receipt.status === '0x0' ? 'reverted' : null;
    if (status === null) throw new Error('The receipt carries no success or failure status.');
    return { status, logs: receipt.logs as BridgeLog[] };
  };
}

/**
 * eth_getLogs windows (blocks per request). 9,000 blocks is the window the
 * risk card already uses against the same public endpoints (risk.ts
 * RISK_LOG_WINDOW_BLOCKS); it is a judgement, not a documented limit.
 */
export const BRIDGE_LOG_WINDOW_BLOCKS = 9_000n;
/** At most this many windows per search: older transfers are left to an explorer (judgement). */
export const BRIDGE_LOG_MAX_WINDOWS = 12;
/** Without a recorded starting block, how far back the search reaches (one window; judgement). */
export const BRIDGE_LOG_FALLBACK_BLOCKS = 9_000n;

export const BRIDGE_LOG_TOO_OLD =
  'This transfer was sent too long ago for the wallet to search the receiving network for it; look up the sending transaction in LayerZero Scan or an explorer.';

/** The same for a CCTP transfer: the mint is searched by the message's nonce. */
export const BRIDGE_LOG_TOO_OLD_CCTP =
  'This transfer was sent too long ago for the wallet to search the receiving network for its mint; look up the recipient on that network in an explorer. If the USDC was never minted, anyone can still send the mint with Circle’s attested message.';

/**
 * The destination log reader: eth_getLogs on the receiving chain for one
 * contract, from `fromBlock` (the receiving chain's head when the transfer
 * was quoted, which is no later than its head when the transfer was sent)
 * to the current head, in windows of BRIDGE_LOG_WINDOW_BLOCKS.
 */
export function destinationLogReader(readers: BridgeReaders, fromBlock: bigint | null, tooOld: string = BRIDGE_LOG_TOO_OLD): BridgeEventLogReader {
  return async ({ chainId, address, topics }) => {
    const transport = readers.transportFor(chainId);
    const headHex = await transport('eth_blockNumber', []);
    if (typeof headHex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(headHex)) throw new Error('The node answered eth_blockNumber with something other than a quantity.');
    const head = BigInt(headHex);
    let start = fromBlock ?? (head > BRIDGE_LOG_FALLBACK_BLOCKS ? head - BRIDGE_LOG_FALLBACK_BLOCKS : 0n);
    if (start > head) return [];
    if (head - start + 1n > BRIDGE_LOG_WINDOW_BLOCKS * BigInt(BRIDGE_LOG_MAX_WINDOWS)) throw new BridgeRefusal(tooOld);
    const out: BridgeLog[] = [];
    while (start <= head) {
      const end = start + BRIDGE_LOG_WINDOW_BLOCKS - 1n < head ? start + BRIDGE_LOG_WINDOW_BLOCKS - 1n : head;
      const logs = await transport('eth_getLogs', [
        { address, fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}`, topics },
      ]);
      if (!Array.isArray(logs)) throw new Error('The node answered eth_getLogs with something other than a list.');
      out.push(...(logs as BridgeLog[]));
      start = end + 1n;
    }
    return out;
  };
}

/**
 * A transport over a built-in profile's keyless default endpoints, in
 * order, for the networks that are NOT the active one (the receiving
 * network; the sending network once the user switched away). Each URL's
 * eth_chainId is checked once before it is used; an endpoint failure
 * (isEndpointFailure: transport errors, timeouts, rate limits, server
 * errors) moves to the next URL, while an answer (a revert, an RPC error)
 * is returned as is. User endpoint overrides apply to the ACTIVE network
 * only (config/networks.ts), so they are not used here; the screen uses
 * the active endpoint for the active network.
 */
export function defaultChainTransport(chainId: number, fetchImpl?: typeof fetch): JsonRpcTransport {
  const profile = profileOfChain(chainId);
  if (!profile || !isBuiltInEvmChain(profile.caip2)) throw new BridgeRefusal(`The wallet has no built-in endpoints for chain ${chainId}.`);
  const urls = profile.defaultRpcUrls;
  const verified = new Set<string>();
  return async (method, params) => {
    let lastError: unknown = new Error(`No endpoint answered for ${profile.label}.`);
    for (const url of urls) {
      const transport = fetchImpl ? evmHttpTransport(url, fetchImpl) : evmHttpTransport(url);
      try {
        if (!verified.has(url)) {
          const id = await transport('eth_chainId', []);
          if (typeof id !== 'string' || BigInt(id) !== BigInt(chainId)) {
            lastError = new Error(`An endpoint for ${profile.label} answered for another chain.`);
            continue;
          }
          verified.add(url);
        }
        return await transport(method, params);
      } catch (e) {
        if (!isEndpointFailure(e)) throw e;
        lastError = e;
      }
    }
    throw lastError;
  };
}

// ---------------------------------------------------------------------------
// The quote, checked independently
// ---------------------------------------------------------------------------

export interface BridgeQuoteRequestApp {
  /** CAIP-2 of the active (source) network. */
  caip2: string;
  destinationChainId: number;
  providerId: string;
  amount: bigint;
  /** The address that signs: the regular account, or the smart account's address. */
  sender: string;
  senderKind: 'regular' | 'smart-account';
  /**
   * The address that receives. Test ETH: always the active account's
   * regular address (see the module comment). USDC: the regular address, or
   * the smart account's when the user chose it (recipientKind).
   */
  recipient: string;
  /** Which of the account's addresses receives (default 'regular'). Only USDC may go to the smart account. */
  recipientKind?: 'regular' | 'smart-account';
  /** The profile's displaySymbol ("test ETH"). */
  nativeSymbol: string;
  readers: BridgeReaders;
}

/** A checked quote with everything the confirm, the send and the tracking need. */
export interface BridgePlan {
  quote: BridgeQuote;
  providerId: string;
  providerLabel: string;
  trust: BridgeTrustStatement;
  sourceCaip2: string;
  sourceLabel: string;
  destinationCaip2: string;
  destinationLabel: string;
  sender: string;
  senderKind: 'regular' | 'smart-account';
  recipient: string;
  recipientKind: 'regular' | 'smart-account';
  nativeSymbol: string;
  /** What moves: the network's coin or USDC. */
  asset: BridgeAssetChoice;
  /** The bridge call (the last call; for CCTP the burn). */
  call: Call;
  /** Every call signed on the source network, in order (CCTP: the exact approval, then the burn). */
  calls: Call[];
  /** The exact approval the bridge call needs (CCTP), or null (a native pool takes the coin itself). */
  approval: { token: string; spender: string; amount: bigint } | null;
  /** The messaging fee, exactly as the adapter quoted it (0 for CCTP: there is none). */
  messagingFee: bigint;
  /** The receiving chain's head when quoted (where tracking starts), or null when unreadable. */
  destinationFromBlock: bigint | null;
  recipientCode: RecipientCodeState;
}

function word32At(data: Uint8Array, offset: number): string | null {
  const start = 4 + offset;
  if (data.length < start + 32) return null;
  return toHex(data.slice(start, start + 32)).toLowerCase();
}

function uintWord(value: bigint | number): string {
  return '0x' + BigInt(value).toString(16).padStart(64, '0');
}

/** The checked parts of a quote, ready for the send paths. */
export interface CheckedBridgeQuote {
  /** The bridge call. */
  call: Call;
  /** Every source call, in order. */
  calls: Call[];
  messagingFee: bigint;
  approval: { token: string; spender: string; amount: bigint } | null;
}

/**
 * The words of CCTP's depositForBurn this wallet signs, by offset (the
 * engine's depositForBurnPins; docs/BRIDGING.md section 4.4), as the
 * checker re-reads them: every one of the seven.
 */
export const CCTP_BURN_WORD_OFFSETS = Object.freeze({
  amount: 0,
  destinationDomain: 32,
  mintRecipient: 64,
  burnToken: 96,
  destinationCaller: 128,
  maxFee: 160,
  minFinalityThreshold: 192,
} as const);

/**
 * The wallet's own checks of a quote before it is shown or signed,
 * independent of the adapter that built it. Throws BridgeRefusal.
 * Common: the route and amount are the ones asked for; every approval is
 * exact (more than zero, at most the amount, below the "unlimited" bound,
 * and its calldata says exactly that); there is exactly one bridge call,
 * last. LayerZero: the call goes to the pinned Stargate pool of the sending
 * chain with the OFT send selector, needs no approval, its value is
 * exactly the amount plus the quoted messaging fee and equals its value
 * limit, and the pinned words carry the destination's endpoint id, the
 * recipient, the amount, the fee and the refund address (the sender).
 * CCTP: exactly two calls — approve(TokenMessengerV2, exactly the amount)
 * on the sending network's USDC, then depositForBurn on TokenMessengerV2 —
 * both with value 0 and value limit 0; the burn is exactly the seven words
 * (228 bytes) and EVERY word is re-read against what the wallet expects
 * (the amount, the destination domain, the recipient, the USDC, a zero
 * destination caller, a zero maximum fee, finality 2000) and against its
 * own equal pin; one fee line, Circle's, of zero; expected and minimum
 * arrival equal to the amount.
 */
export function checkBridgeQuote(
  quote: BridgeQuote,
  expect: { sourceChainId: number; destinationChainId: number; amount: bigint; recipient: string; sender: string },
): CheckedBridgeQuote {
  const fail = (why: string): never => {
    throw new BridgeRefusal(`The quote did not pass the wallet’s own checks (${why}). Nothing was signed.`);
  };
  if (quote.route.sourceChainId !== expect.sourceChainId || quote.route.destinationChainId !== expect.destinationChainId) fail('another route');
  if (quote.amountIn !== expect.amount) fail('another amount');
  for (const a of quote.approvals) {
    if (a.amount <= 0n || a.amount > expect.amount || a.amount > MAX_EXACT_APPROVAL) fail('an approval that is not exact');
  }
  const approves = quote.calls.filter((c) => c.purpose === 'approve');
  for (const c of approves) {
    const hex = toHex(c.data).toLowerCase();
    const amountWord = BigInt('0x' + hex.slice(2 + 8 + 64, 2 + 8 + 128));
    if (!hex.startsWith('0x095ea7b3') || hex.length !== 2 + 8 + 128 || amountWord <= 0n || amountWord > expect.amount) {
      fail('an approval that is not exact');
    }
    if (!quote.approvals.some((a) => a.token.toLowerCase() === c.to.toLowerCase() && a.amount === amountWord)) fail('an approval the quote does not list');
  }
  const bridgeCalls = quote.calls.filter((c) => c.purpose === 'bridge');
  if (bridgeCalls.length !== 1 || quote.calls[quote.calls.length - 1] !== bridgeCalls[0]) fail('not exactly one bridge call, last');
  const call = bridgeCalls[0]!;
  if (quote.providerId === CCTP_V2_PROVIDER_ID) return checkCctpQuote(quote, expect, call, fail);
  if (quote.providerId !== LAYERZERO_OFT_PROVIDER_ID) fail('a provider this screen does not send through');
  const pool = stargatePoolOn(expect.sourceChainId);
  if (!pool || call.to.toLowerCase() !== pool.address.toLowerCase()) fail('a contract other than the pinned Stargate pool');
  if (quote.route.sourceAsset.kind !== 'native') fail('an asset other than the network’s coin');
  if (approves.length > 0 || quote.approvals.length > 0) fail('an approval for a pool that takes the coin itself');
  if (toHex(call.data).slice(0, 10).toLowerCase() !== OFT_SEND_SELECTOR) fail('another function');
  const messaging = quote.fees.filter((f) => f.kind === 'messaging');
  if (messaging.length !== 1 || messaging[0]!.amount === null || messaging[0]!.amount <= 0n) fail('no single messaging fee');
  const messagingFee = messaging[0]!.amount as bigint;
  if (call.value !== expect.amount + messagingFee) fail('a value that is not the amount plus the messaging fee');
  if (call.valueLimit !== call.value) fail('a value limit that differs from the value');
  const want: [number, string][] = [
    [OFT_SEND_LAYOUT.dstEid, '0x' + BigInt(layerZeroEidFor(expect.destinationChainId)).toString(16).padStart(64, '0')],
    [OFT_SEND_LAYOUT.to, addressToBytes32(expect.recipient).toLowerCase()],
    [OFT_SEND_LAYOUT.amountLD, '0x' + expect.amount.toString(16).padStart(64, '0')],
    [OFT_SEND_LAYOUT.nativeFee, '0x' + messagingFee.toString(16).padStart(64, '0')],
    [OFT_SEND_LAYOUT.refundAddress, addressToBytes32(expect.sender).toLowerCase()],
  ];
  for (const [offset, value] of want) {
    if (word32At(call.data, offset) !== value) fail(`the word at byte ${offset} of the call`);
    const pin = call.pins.find((p) => p.rule.offset === offset);
    if (!pin || pin.rule.condition !== 'equal' || pin.rule.params[0]?.toLowerCase() !== value) fail(`the pin at byte ${offset}`);
  }
  if (quote.minAmountOut > quote.expectedAmountOut || quote.minAmountOut > expect.amount) fail('a minimum above what is expected to arrive');
  return { call: { to: call.to, value: call.value, data: call.data }, calls: [{ to: call.to, value: call.value, data: call.data }], messagingFee, approval: null };
}

/** The CCTP half of checkBridgeQuote (see its comment). */
function checkCctpQuote(
  quote: BridgeQuote,
  expect: { sourceChainId: number; destinationChainId: number; amount: bigint; recipient: string; sender: string },
  call: BridgeQuote['calls'][number],
  fail: (why: string) => never,
): CheckedBridgeQuote {
  const usdc = CCTP_V2_TESTNET_USDC[expect.sourceChainId];
  const domain = CCTP_V2_TESTNET_DOMAINS[expect.destinationChainId];
  const tm = CCTP_V2_TESTNET.tokenMessengerV2;
  if (!usdc || domain === undefined || CCTP_V2_TESTNET_DOMAINS[expect.sourceChainId] === undefined) fail('a network Circle CCTP does not serve in this wallet');
  if (quote.route.sourceAsset.kind !== 'erc20' || quote.route.sourceAsset.address.toLowerCase() !== usdc!.toLowerCase()) fail('an asset other than this network’s USDC');
  if (quote.calls.length !== 2 || quote.calls[0]!.purpose !== 'approve') fail('not exactly the approval and the burn');
  const approve = quote.calls[0]!;
  if (approve.to.toLowerCase() !== usdc!.toLowerCase()) fail('an approval on another token than USDC');
  const approveHex = toHex(approve.data).toLowerCase();
  if (approveHex.slice(10, 74) !== addressToBytes32(tm).toLowerCase().slice(2)) fail('an approval for another spender than Circle’s TokenMessengerV2');
  if (BigInt('0x' + approveHex.slice(74, 138)) !== expect.amount) fail('an approval that is not exactly the amount');
  if (
    quote.approvals.length !== 1 ||
    quote.approvals[0]!.token.toLowerCase() !== usdc!.toLowerCase() ||
    quote.approvals[0]!.spender.toLowerCase() !== tm.toLowerCase() ||
    quote.approvals[0]!.amount !== expect.amount
  ) {
    fail('an approval the quote does not list');
  }
  if (approve.value !== 0n || approve.valueLimit !== 0n) fail('an approval that carries a value');
  if (call.to.toLowerCase() !== tm.toLowerCase()) fail('a contract other than Circle’s pinned TokenMessengerV2');
  if (call.value !== 0n || call.valueLimit !== 0n) fail('a burn that carries a value');
  const hex = toHex(call.data).toLowerCase();
  if (hex.slice(0, 10) !== CCTP_DEPOSIT_FOR_BURN_SELECTOR) fail('another function');
  if (call.data.length !== 4 + 7 * 32) fail('a burn that is not exactly seven words');
  const O = CCTP_BURN_WORD_OFFSETS;
  const want: [number, string][] = [
    [O.amount, uintWord(expect.amount)],
    [O.destinationDomain, uintWord(domain!)],
    [O.mintRecipient, addressToBytes32(expect.recipient).toLowerCase()],
    [O.burnToken, addressToBytes32(usdc!).toLowerCase()],
    [O.destinationCaller, uintWord(0)],
    [O.maxFee, uintWord(0)],
    [O.minFinalityThreshold, uintWord(CCTP_FINALITY_STANDARD)],
  ];
  for (const [offset, value] of want) {
    if (word32At(call.data, offset) !== value) fail(`the word at byte ${offset} of the burn`);
    const pin = call.pins.find((p) => p.rule.offset === offset);
    if (!pin || pin.rule.condition !== 'equal' || pin.rule.params[0]?.toLowerCase() !== value) fail(`the pin at byte ${offset} of the burn`);
  }
  if (call.pins.length !== 7 || call.unpinnable.length !== 0) fail('a burn that is not fully pinned');
  if (quote.fees.length !== 1 || quote.fees[0]!.kind !== 'protocol' || quote.fees[0]!.amount !== 0n) fail('a Circle fee that is not zero');
  if (quote.expectedAmountOut !== expect.amount || quote.minAmountOut !== expect.amount) fail('an arrival other than the amount');
  const plain = (c: Call): Call => ({ to: c.to, value: c.value, data: c.data });
  return {
    call: plain(call),
    calls: [plain(approve), plain(call)],
    messagingFee: 0n,
    approval: { token: usdc!, spender: tm, amount: expect.amount },
  };
}

/** The refusal for test ETH sent to the smart account (Stargate's 2,300-gas delivery). */
export const BRIDGE_NATIVE_SMART_RECIPIENT_REFUSAL =
  'Test ETH is bridged only to your regular account: Stargate hands ETH over with a 2,300-gas transfer, which a deployed smart account cannot accept. Nothing was quoted.';

/** The USDC balance refusal (exact amounts, never rounded). */
export function usdcBalanceRefusal(balance: bigint, amount: bigint, sourceLabel: string): string {
  return `You hold ${formatUnits(balance, 6, 6)} USDC on ${sourceLabel}, and this transfer needs ${formatUnits(amount, 6, 6)} USDC. Nothing was quoted.`;
}

/** USDC.balanceOf(owner) on the source network through the quote's transport. */
async function readUsdcBalance(transport: JsonRpcTransport, token: string, owner: string): Promise<bigint> {
  const data = '0x70a08231' + addressToBytes32(owner).slice(2);
  let answer: unknown;
  try {
    answer = await transport('eth_call', [{ to: token, data }, 'latest']);
  } catch (e) {
    throw asReaderError(e);
  }
  if (typeof answer !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(answer)) throw asReaderError(new Error('The node answered balanceOf with something other than one word.'));
  return BigInt(answer);
}

/**
 * Whether the sender still has to approve the bridge's spender: reads
 * USDC.allowance(sender, TokenMessengerV2) on the sending network. True
 * while the allowance is below the amount (an earlier, unused approval of
 * at least the amount is used as it is and nothing new is approved).
 */
export async function bridgeNeedsApproval(transport: JsonRpcTransport, plan: Pick<BridgePlan, 'approval' | 'sender'>): Promise<boolean> {
  if (!plan.approval) return false;
  const data = '0xdd62ed3e' + addressToBytes32(plan.sender).slice(2) + addressToBytes32(plan.approval.spender).slice(2);
  const answer = await transport('eth_call', [{ to: plan.approval.token, data }, 'latest']);
  if (typeof answer !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(answer)) throw new Error('The node answered allowance with something other than one word.');
  return BigInt(answer) < plan.approval.amount;
}

/**
 * Quotes one transfer through the chosen provider and checks it. Refused
 * on a network readiness does not allow (before any request), for a
 * provider that is not offered for sending, for a destination the provider
 * does not serve, for test ETH to the smart account, and for USDC above the
 * sender's balance. Reads, besides the provider's own quote reads: the
 * sender's USDC balance (CCTP), the receiving chain's head (where tracking
 * starts) and whether the recipient has code there (best effort; neither
 * failure blocks a quote).
 */
export async function quoteBridge(request: BridgeQuoteRequestApp): Promise<BridgePlan> {
  assertFeatureAllowed(BRIDGE_FEATURE, request.caip2);
  const sourceChainId = chainIdOf(request.caip2);
  const status = BRIDGE_PROVIDER_STATUS[request.providerId];
  if (status !== 'offered') throw new BridgeRefusal('This bridge provider is not offered in this wallet.');
  const destinationProfile = profileOfChain(request.destinationChainId);
  if (!destinationProfile || !destinationProfile.testnet || !isBuiltInEvmChain(destinationProfile.caip2)) {
    throw new BridgeRefusal('Bridging is offered only to the built-in test networks.');
  }
  const recipientKind = request.recipientKind ?? 'regular';
  const registry = createAppBridgeRegistry(request.readers, { estimateGas: request.senderKind === 'regular' });
  const provider: BridgeProvider = registry.require(request.providerId);
  const route = registry.routes({ sourceChainId, destinationChainId: request.destinationChainId }).find((r) => r.providerId === request.providerId);
  if (!route) throw new BridgeRefusal(noRouteNote(labelOfChain(sourceChainId), destinationProfile.label));
  const asset = routeAsset(route);
  if (asset === 'native' && recipientKind !== 'regular') throw new BridgeRefusal(BRIDGE_NATIVE_SMART_RECIPIENT_REFUSAL);
  if (request.amount <= 0n) throw new BridgeRefusal('Enter an amount greater than zero.');
  if (asset === 'usdc' && route.sourceAsset.kind === 'erc20') {
    // Above the balance: refused before quoting, with both exact figures.
    const balance = await readUsdcBalance(request.readers.transportFor(sourceChainId), route.sourceAsset.address, request.sender);
    if (request.amount > balance) throw new BridgeRefusal(usdcBalanceRefusal(balance, request.amount, labelOfChain(sourceChainId)));
  }
  let quote: BridgeQuote;
  try {
    quote = await provider.quote({
      route,
      amount: request.amount,
      sender: request.sender,
      recipient: request.recipient,
      nativeSymbol: request.nativeSymbol,
    });
  } catch (e) {
    // A node's answer keeps its own error (endpoint failover and the send
    // screens' wording apply); the adapter's refusals are shown verbatim.
    if (isBridgeReaderError(e)) throw e;
    throw new BridgeRefusal(e instanceof Error ? e.message : String(e));
  }
  const checked = checkBridgeQuote(quote, {
    sourceChainId,
    destinationChainId: request.destinationChainId,
    amount: request.amount,
    recipient: request.recipient,
    sender: request.sender,
  });
  const destination = request.readers.transportFor(request.destinationChainId);
  let destinationFromBlock: bigint | null = null;
  let recipientCode: RecipientCodeState = 'unknown';
  await Promise.all([
    destination('eth_blockNumber', []).then(
      (h) => {
        if (typeof h === 'string' && /^0x[0-9a-fA-F]+$/.test(h)) destinationFromBlock = BigInt(h);
      },
      () => undefined,
    ),
    destination('eth_getCode', [request.recipient, 'latest']).then(
      (code) => {
        if (typeof code === 'string') recipientCode = /^0x0*$/i.test(code) ? 'none' : 'code';
      },
      () => undefined,
    ),
  ]);
  return {
    quote,
    providerId: provider.id,
    providerLabel: provider.label,
    trust: provider.trust,
    sourceCaip2: request.caip2,
    sourceLabel: labelOfChain(sourceChainId),
    destinationCaip2: destinationProfile.caip2,
    destinationLabel: destinationProfile.label,
    sender: request.sender,
    senderKind: request.senderKind,
    recipient: request.recipient,
    recipientKind,
    nativeSymbol: request.nativeSymbol,
    asset,
    call: checked.call,
    calls: checked.calls,
    approval: checked.approval,
    messagingFee: checked.messagingFee,
    destinationFromBlock,
    recipientCode,
  };
}

// ---------------------------------------------------------------------------
// Reshaping into the existing send paths
// ---------------------------------------------------------------------------

/**
 * The regular-account quote through prepareEvmSend (chain-id check, fee,
 * balance, eth_call pre-flight). The value is the call's value exactly as
 * the adapter built it (LayerZero: amount + messaging fee; CCTP's burn: 0);
 * a quote that would sign another value is refused. For CCTP this is the
 * SECOND transaction: its pre-flight passes only once the exact approval
 * (prepareBridgeApprove) is confirmed.
 */
export async function prepareBridgeSend(url: string, from: string, plan: BridgePlan): Promise<EvmSendQuote> {
  assertFeatureAllowed(BRIDGE_FEATURE, plan.sourceCaip2);
  if (plan.senderKind !== 'regular' || plan.sender.toLowerCase() !== from.toLowerCase()) {
    throw new BridgeRefusal('This quote was prepared for another account. Nothing was quoted.');
  }
  const quote = await prepareEvmSend(url, from, plan.call.to, plan.call.value, plan.call.data, plan.sourceCaip2);
  if (quote.amount !== plan.call.value || quote.to.toLowerCase() !== plan.call.to.toLowerCase()) {
    throw new BridgeRefusal('The transaction would not carry the quoted value. Nothing was signed.');
  }
  return quote;
}

function sameCall(a: Call, b: Call): boolean {
  return a.to.toLowerCase() === b.to.toLowerCase() && a.value === b.value && toHex(a.data) === toHex(b.data);
}

/**
 * The regular account's FIRST CCTP transaction: the exact approval of the
 * plan (approve(TokenMessengerV2, exactly the amount) on the sending
 * network's USDC, value 0), through prepareEvmSend with its pre-flight.
 */
export async function prepareBridgeApprove(url: string, from: string, plan: BridgePlan): Promise<EvmSendQuote> {
  assertFeatureAllowed(BRIDGE_FEATURE, plan.sourceCaip2);
  if (plan.senderKind !== 'regular' || plan.sender.toLowerCase() !== from.toLowerCase()) {
    throw new BridgeRefusal('This quote was prepared for another account. Nothing was quoted.');
  }
  const approve = plan.approval ? plan.calls[0] : undefined;
  if (!plan.approval || !approve || plan.calls.length !== 2 || approve.to.toLowerCase() !== plan.approval.token.toLowerCase()) {
    throw new BridgeRefusal('This transfer needs no token approval.');
  }
  const quote = await prepareEvmSend(url, from, approve.to, 0n, approve.data, plan.sourceCaip2);
  if (quote.amount !== 0n || quote.to.toLowerCase() !== approve.to.toLowerCase() || toHex(quote.data ?? new Uint8Array()) !== toHex(approve.data)) {
    throw new BridgeRefusal('The approval transaction would not be the exact approval quoted. Nothing was signed.');
  }
  return quote;
}

/** The device prompt for the exact approval (the regular account's step 1 of 2). */
export function bridgeApprovePromptTitle(plan: Pick<BridgePlan, 'approval' | 'asset' | 'nativeSymbol'>): string {
  const amount = plan.approval ? exactAsset(plan.approval.amount, plan.asset) : '0';
  return `Approve exactly ${amount} ${bridgeAssetLabel(plan.asset, plan.nativeSymbol)} for Circle’s TokenMessengerV2`;
}

/**
 * The smart-account quote through prepareAaCalls: every source call of the
 * plan as ONE operation (LayerZero: the bridge call; CCTP: the exact
 * approval and the burn, all-or-nothing, self-paid; the USDC the
 * operation spends is checked against the smart account's balance). The
 * quote must be for the smart account the plan was read for, and must
 * carry exactly the plan's calls and value.
 */
export async function prepareBridgeAa(bundle: AaClientBundle, ownerAddress: string, plan: BridgePlan): Promise<AaSendQuote> {
  assertFeatureAllowed(BRIDGE_FEATURE, plan.sourceCaip2);
  if (plan.senderKind !== 'smart-account') throw new BridgeRefusal('This quote was prepared for the regular account. Nothing was quoted.');
  if (`eip155:${bundle.chainId}` !== plan.sourceCaip2) {
    throw new BridgeRefusal('The smart-account setup is for another network than this quote. Nothing was quoted.');
  }
  // A plan with an approval is exactly [the approval on its token, the bridge call].
  if (plan.approval && (plan.calls.length !== 2 || plan.calls[0]!.to.toLowerCase() !== plan.approval.token.toLowerCase() || !sameCall(plan.calls[1]!, plan.call))) {
    throw new BridgeRefusal('The operation would not carry the quoted calls and value. Nothing was signed.');
  }
  const calls = plan.calls.map((c) => ({ to: c.to, value: c.value, data: c.data }));
  const quote = await prepareAaCalls(bundle, ownerAddress, calls, {
    displayTo: plan.call.to,
    ...(plan.approval ? { tokenSpend: { contract: plan.approval.token, amount: plan.approval.amount, symbol: 'USDC' } } : {}),
  });
  if (quote.sender.toLowerCase() !== plan.sender.toLowerCase()) {
    throw new BridgeRefusal('This quote was read for another address than the smart account. Nothing was quoted.');
  }
  const total = calls.reduce((sum, c) => sum + c.value, 0n);
  const same =
    quote.calls.length === calls.length &&
    quote.calls.every((c, i) => c.to.toLowerCase() === calls[i]!.to.toLowerCase() && c.value === calls[i]!.value && toHex(c.data) === toHex(calls[i]!.data));
  if (quote.amount !== total || !same) {
    throw new BridgeRefusal('The operation would not carry the quoted calls and value. Nothing was signed.');
  }
  return quote;
}

// ---------------------------------------------------------------------------
// The confirm model (every line is plain text; amounts never rounded)
// ---------------------------------------------------------------------------

/** Full precision for an 18-decimal amount. */
export function exactNative(amount: bigint): string {
  return formatUnits(amount, 18, 18);
}

/** Full precision for an amount of the asset (18 decimals for the coin, 6 for USDC). */
export function exactAsset(amount: bigint, asset: BridgeAssetChoice): string {
  const d = bridgeAssetDecimals(asset);
  return formatUnits(amount, d, d);
}

/** The device prompt (and the confirm button): "Bridge X test ETH to <network> through <provider>". */
export function bridgePromptTitle(
  plan: Pick<BridgePlan, 'quote' | 'nativeSymbol' | 'destinationLabel' | 'providerLabel' | 'senderKind'> & { asset?: BridgeAssetChoice },
): string {
  const asset = plan.asset ?? 'native';
  const base = `Bridge ${exactAsset(plan.quote.amountIn, asset)} ${bridgeAssetLabel(asset, plan.nativeSymbol)} to ${plan.destinationLabel} through ${plan.providerLabel}`;
  return plan.senderKind === 'smart-account' ? `${base} from your smart account` : base;
}

/**
 * The sending network's own fee lines for the regular account's confirm,
 * worded like the Send screen's: the worst-case sentence and, on an
 * OP-stack network (OP Sepolia, Base Sepolia), the layer 1 data fee and any
 * operator fee, which prepareEvmSend already includes in the max fee and
 * the total.
 */
export function bridgeSourceFeeLines(
  quote: Pick<EvmSendQuote, 'maxFeePerGas' | 'gasLimit' | 'opStack'>,
  symbol: string,
): { worstCase: string; rows: { label: string; value: string }[]; note: string | null } {
  const op = quote.opStack;
  const worstCase =
    `Worst case at ${formatUnits(quote.maxFeePerGas, 9, 9)} gwei max fee × ${quote.gasLimit.toString()} gas` +
    `${op ? ', plus the layer 1 data fee below' : ''}; the actual fee is usually lower.`;
  if (!op) return { worstCase, rows: [], note: null };
  const rows = [{ label: 'Layer 1 data fee (estimate)', value: `${exactNative(op.l1DataFee)} ${symbol}` }];
  if (op.operatorFee > 0n) rows.push({ label: 'Operator fee (worst case)', value: `${exactNative(op.operatorFee)} ${symbol}` });
  const note =
    'This is a layer-2 network: every transaction also pays for publishing its data on Ethereum. The network’s fee ' +
    `oracle estimates ${exactNative(op.l1DataFeeEstimate)} ${symbol} for this transaction; ${L1_DATA_FEE_HEADROOM_PERCENT.toString()}% ` +
    'more is reserved because this fee follows Ethereum’s fees and cannot be capped. It is included in the max network ' +
    'fee and the total.';
  return { worstCase, rows, note };
}

export interface BridgeConfirmModel {
  title: string;
  /** The source calls in plain words, in order (CCTP: the approval, then the burn), with how many prompts they take. */
  callLines: string[];
  youSend: string;
  arrives: string;
  minimum: string;
  feeLines: { label: string; value: string; note: string }[];
  /** "amount + fee" leaving the account, before the network fee. */
  total: string;
  timeLines: string[];
  trust: BridgeTrustStatement;
  destinationStep: string;
  approvalLine: string;
  pinnedSummary: string[];
  pinnedPool: string;
  recipientLines: string[];
  notes: string[];
}

/**
 * Everything the confirm shows for a plan, as plain lines: the fee lines in
 * the network's symbol, total = amount + fee, the measured time with the
 * "not a promise" sentence, the trust statement verbatim, the refund rule,
 * the pinned fields in plain words, and the approvals (none for a native
 * pool; when present, each states its exact amount).
 */
export function bridgeConfirmModel(plan: BridgePlan): BridgeConfirmModel {
  if (plan.providerId === CCTP_V2_PROVIDER_ID) return cctpConfirmModel(plan);
  const q = plan.quote;
  const sym = plan.nativeSymbol;
  const feeLines = q.fees.map((f) => ({
    label: f.kind === 'messaging' ? `LayerZero messaging fee (paid in ${sym})` : f.kind === 'pool' ? 'Pool fee (taken from the amount)' : `${f.kind} fee`,
    value: f.amount === null ? 'not known before sending' : `${exactNative(f.amount)} ${f.asset.kind === 'native' ? sym : f.asset.symbol}`,
    note: f.description,
  }));
  const timeLines: string[] = [];
  const measured = measuredTimeLine(q.time);
  if (measured) timeLines.push(measured);
  timeLines.push(q.time.source);
  // The adapter's own sentence already ends "Not a promise: …" when it says
  // where the figure comes from; the wallet's sentence is added otherwise.
  if (!/not a promise/i.test(q.time.source)) timeLines.push(BRIDGE_TIME_NOT_PROMISE);
  const eid = layerZeroEidFor(q.route.destinationChainId);
  const pinnedSummary = [
    `Receiving network: ${plan.destinationLabel} (LayerZero endpoint id ${eid}).`,
    `Recipient: ${plan.recipient}.`,
    `Amount: ${exactNative(q.amountIn)} ${sym}; at least ${exactNative(q.minAmountOut)} ${sym} must arrive, or the transfer reverts on this network and nothing leaves.`,
    `Messaging fee: ${exactNative(plan.messagingFee)} ${sym}, paid with this transaction; any part not used is refunded to ${plan.sender}.`,
    'No extra options and no compose message: the transfer cannot run code of its own on the receiving network.',
    `All of these are fixed words of the call (${q.calls[q.calls.length - 1]!.pins.length} of them). Before showing this screen the wallet re-read the receiving network, the recipient, the amount, the fee and the refund address from the call itself, with the value sent; the other words are fixed by how it builds the call.`,
  ];
  const approvalLine =
    q.approvals.length === 0
      ? `No token approval: the pool takes the ${sym} sent with the call itself.`
      : q.approvals.map((a) => `Exact approval only: this allows ${a.spender} to take exactly ${a.amount} base units of ${a.token}, nothing more.`).join(' ');
  const recipientLines = [bridgeRecipientNote(plan.senderKind, plan.sender, plan.recipient, plan.destinationLabel)];
  const codeNote = recipientCodeNote(plan.recipientCode, plan.destinationLabel);
  if (codeNote) recipientLines.push(codeNote);
  return {
    title: bridgePromptTitle(plan),
    callLines: [],
    youSend: `You send ${exactNative(q.amountIn)} ${sym} from ${plan.sourceLabel}`,
    arrives: `Expected to arrive on ${plan.destinationLabel}: ${exactNative(q.expectedAmountOut)} ${sym}`,
    minimum: `Least that may arrive (written into the call): ${exactNative(q.minAmountOut)} ${sym}`,
    feeLines,
    total: `${exactNative(plan.call.value)} ${sym} (amount ${exactNative(q.amountIn)} + messaging fee ${exactNative(plan.messagingFee)}), before this network’s own transaction fee`,
    timeLines,
    trust: plan.trust,
    destinationStep: q.destination.description,
    approvalLine,
    pinnedSummary,
    pinnedPool: pinnedPoolLine(plan.call.to, plan.sourceLabel),
    recipientLines,
    notes: q.notes,
  };
}

/** The confirm's line about Circle's pinned contract (the risk card does not know it by name). */
export function cctpPinnedContractLine(tokenMessenger: string, sourceLabel: string): string {
  return (
    `The burn goes to Circle’s TokenMessengerV2 on ${sourceLabel} (${tokenMessenger}), pinned by this wallet from Circle’s ` +
    'published test-network addresses and checked on-chain on 2026-10-25. The risk card below does not know Circle’s contracts by name.'
  );
}

/** Shown on the smart-account confirm: the fee is paid in the network's coin on this path. */
export function cctpSmartAccountFeeNote(symbol: string): string {
  return `The network fee is paid in ${symbol} from the smart account. Paying it in USDC through Circle’s paymaster is not offered for bridging in this version.`;
}

/**
 * What has to happen on the receiving network, in the wallet's words (the
 * adapter's own description is shown first).
 */
export function cctpMintStepLine(destinationLabel: string): string {
  return (
    `After Circle’s attestation (about 17 minutes in the measured runs) the USDC is minted on ${destinationLabel} by a transaction ` +
    `there. This wallet can send it from your regular account when ${destinationLabel} is the active network and that account ` +
    'holds test ETH there for gas; anyone else with gas there may send it too, and the USDC still goes only to the recipient written into the burn.'
  );
}

function cctpConfirmModel(plan: BridgePlan): BridgeConfirmModel {
  const q = plan.quote;
  const amount = `${exactAsset(q.amountIn, 'usdc')} USDC`;
  const approval = plan.approval!;
  const domain = CCTP_V2_TESTNET_DOMAINS[q.route.destinationChainId];
  const feeLines = q.fees.map((f) => ({
    label: 'Circle protocol fee (Standard Transfer)',
    value: f.amount === null ? 'not known before sending' : `${exactAsset(f.amount, 'usdc')} USDC`,
    note: f.description,
  }));
  const timeLines: string[] = [];
  const measured = measuredTimeLine(q.time);
  if (measured) timeLines.push(measured);
  timeLines.push(q.time.source);
  if (!/not a promise/i.test(q.time.source)) timeLines.push(BRIDGE_TIME_NOT_PROMISE);
  const callLines = [
    `1. approve on USDC (${approval.token}): allows Circle’s TokenMessengerV2 ${approval.spender} to take exactly ${amount}.`,
    `2. depositForBurn on Circle’s TokenMessengerV2 (${plan.call.to}): burns ${amount} on ${plan.sourceLabel} for minting on ${plan.destinationLabel}.`,
    plan.senderKind === 'smart-account'
      ? 'One smart-account operation carries both calls, all or nothing, so there is one device prompt.'
      : 'Two transactions, each with its own device prompt: first the approval, then, once it is confirmed, the burn.',
  ];
  const pinnedSummary = [
    `Receiving network: ${plan.destinationLabel} (CCTP domain ${domain}).`,
    `Recipient: ${plan.recipient} (your ${plan.recipientKind === 'smart-account' ? 'smart account' : 'regular account'}).`,
    `Amount: ${amount} (${q.amountIn} base units), burned here and minted there.`,
    `Burn token: USDC ${approval.token} on ${plan.sourceLabel}.`,
    'Destination caller: none (zero), so anyone may send the mint; it still goes only to the recipient above.',
    'Maximum fee 0 and finality 2000: a Standard Transfer, which Circle attests after the sending network’s hard finality. This wallet never builds a Fast Transfer.',
    `All seven words of the call are fixed (${q.calls[q.calls.length - 1]!.pins.length} pins), and before showing this screen the wallet re-read each of them from the call itself.`,
  ];
  return {
    title: bridgePromptTitle(plan),
    callLines,
    youSend: `You send ${amount} from ${plan.sourceLabel}`,
    arrives: `Expected to arrive on ${plan.destinationLabel}: ${exactAsset(q.expectedAmountOut, 'usdc')} USDC`,
    minimum: `Least that may arrive (written into the call as a maximum fee of 0): ${exactAsset(q.minAmountOut, 'usdc')} USDC`,
    feeLines,
    total: `${amount} (amount ${exactAsset(q.amountIn, 'usdc')} + Circle fee 0), before the network fees in ${plan.nativeSymbol}`,
    timeLines,
    trust: plan.trust,
    destinationStep: `${q.destination.description} ${cctpMintStepLine(plan.destinationLabel)}`,
    approvalLine:
      `Exact approval only: this allows Circle’s TokenMessengerV2 (${approval.spender}) to take exactly ${amount} ` +
      `(${approval.amount} base units) of USDC (${approval.token}), nothing more; the burn uses all of it, so nothing stays approved.`,
    pinnedSummary,
    pinnedPool: cctpPinnedContractLine(plan.call.to, plan.sourceLabel),
    recipientLines: [usdcRecipientNote(plan.recipientKind, plan.recipient, plan.destinationLabel)],
    notes: plan.senderKind === 'smart-account' ? [...q.notes, cctpSmartAccountFeeNote(plan.nativeSymbol)] : [...q.notes],
  };
}

// ---------------------------------------------------------------------------
// Transfer records (stored per wallet; see the module comment)
// ---------------------------------------------------------------------------

export interface BridgeTransferRecord {
  id: string;
  providerId: string;
  providerLabel: string;
  route: BridgeRoute;
  sourceCaip2: string;
  sourceLabel: string;
  destinationCaip2: string;
  destinationLabel: string;
  amountIn: bigint;
  recipient: string;
  sender: string;
  senderKind: 'regular' | 'smart-account';
  /** The source transaction (for a smart account: the bundle transaction, once its receipt is known). */
  sourceTxHash: string | null;
  userOpHash: string | null;
  destinationFromBlock: bigint | null;
  sentAt: number;
  status: BridgeTransferStatus | null;
  checkedAt: number | null;
  /** The last tracking error, as plain text, or null. */
  checkError: string | null;
  /**
   * The transaction this screen sent on the RECEIVING network for this
   * transfer, when one was sent: Stargate's retryReceiveToken, or CCTP's
   * mint (receiveMessage).
   */
  retryTxHash: string | null;
  /**
   * CCTP: Circle's attested message, once the adapter has checked it
   * against the burn (stored so the mint can be offered again after a
   * restart without asking Circle; re-checked by the adapter every time it
   * is used). Null for LayerZero and before the attestation.
   */
  attested: BridgeAttestation | null;
}

/** The storage key (store-keys.ts; per wallet). */
export const BRIDGE_TRANSFERS_KEY = STORE_KEYS.bridgeTransfers.name;
/**
 * The stored document's version. Still 1 after phase 23 item 4 added the
 * attested message: a record has exactly one of two key sets — the 18 keys
 * written before (read with no attested message) or those 18 plus
 * `attested` (what this version writes) — so the parse stays strict, a list
 * written before keeps loading, and the records backup, which writes a
 * restored list in the backup's own version (records-backup.ts), needs no
 * change.
 */
const BRIDGE_STORE_VERSION = 1;
/** At most this many transfers are kept (judgement, as the pending registry's 64); the oldest finished ones go first. */
export const MAX_BRIDGE_TRANSFERS = 64;

const records = new Map<string, BridgeTransferRecord>();
const recordListeners = new Set<() => void>();
let recordCounter = 0;
/** Where records are written: the store the last load read (null before a load), and whether it is read-only. */
let attached: { store: KeyValueStore; profileId: string; readOnly: boolean } | null = null;
let writeQueue: Promise<void> = Promise.resolve();

function notifyRecords(): void {
  for (const l of [...recordListeners]) {
    try {
      l();
    } catch {
      // Display only.
    }
  }
}

/** Subscribes to record changes; returns the unsubscribe function. */
export function subscribeBridgeTransfers(listener: () => void): () => void {
  recordListeners.add(listener);
  return () => {
    recordListeners.delete(listener);
  };
}

// ----- the stored form ------------------------------------------------------

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_HASH = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
const RECORD_ID = /^bridge-[0-9]{1,16}-[0-9]{1,9}$/;
const CAIP2 = /^eip155:[1-9][0-9]{0,15}$/;
const LABEL_MAX = 80;
const DETAIL_MAX = 4000;
const STORED_KEYS = [
  'id', 'providerId', 'providerLabel', 'route', 'sourceCaip2', 'sourceLabel', 'destinationCaip2', 'destinationLabel',
  'amountIn', 'recipient', 'sender', 'senderKind', 'sourceTxHash', 'userOpHash', 'destinationFromBlock', 'sentAt',
  'retryTxHash', 'final',
] as const;
/** Records written since phase 23 item 4 add the attested message (null until Circle attests a CCTP burn). */
const STORED_KEYS_WITH_ATTESTED = [...STORED_KEYS, 'attested'] as const;
/** The attested message's stored form: hex strings, the expiration block as a decimal string. */
const ATTESTED_KEYS = ['message', 'attestation', 'nonce', 'expirationBlock'] as const;
/** The longest attestation stored (65-byte signatures; judgement: 16 signatures, Circle uses 2). */
const ATTESTATION_MAX_BYTES = 65 * 16;

/** A finished transfer's status as stored (only delivered or failed are kept). */
interface StoredFinal {
  state: 'delivered' | 'failed';
  detail: string;
  destinationTxHash: string | null;
  checkedAt: number;
}

function finalOf(record: BridgeTransferRecord): StoredFinal | null {
  const st = record.status;
  if (!st || (st.state !== 'delivered' && st.state !== 'failed') || record.checkedAt === null) return null;
  return { state: st.state, detail: st.detail, destinationTxHash: st.destinationTxHash ?? null, checkedAt: record.checkedAt };
}

function assetToStored(a: BridgeRoute['sourceAsset']): Record<string, unknown> {
  return a.kind === 'native'
    ? { kind: 'native', symbol: a.symbol, decimals: a.decimals }
    : { kind: 'erc20', address: a.address, symbol: a.symbol, decimals: a.decimals };
}

/** The JSON form of one record (bigints as decimal strings; no status that is not final). */
export function bridgeRecordToStored(record: BridgeTransferRecord): Record<string, unknown> {
  return {
    id: record.id,
    providerId: record.providerId,
    providerLabel: record.providerLabel,
    route: {
      providerId: record.route.providerId,
      sourceChainId: record.route.sourceChainId,
      destinationChainId: record.route.destinationChainId,
      sourceAsset: assetToStored(record.route.sourceAsset),
      destinationAsset: assetToStored(record.route.destinationAsset),
    },
    sourceCaip2: record.sourceCaip2,
    sourceLabel: record.sourceLabel,
    destinationCaip2: record.destinationCaip2,
    destinationLabel: record.destinationLabel,
    amountIn: record.amountIn.toString(),
    recipient: record.recipient,
    sender: record.sender,
    senderKind: record.senderKind,
    sourceTxHash: record.sourceTxHash,
    userOpHash: record.userOpHash,
    destinationFromBlock: record.destinationFromBlock === null ? null : record.destinationFromBlock.toString(),
    sentAt: record.sentAt,
    retryTxHash: record.retryTxHash,
    final: finalOf(record),
    attested:
      record.attested === null
        ? null
        : {
            message: record.attested.message,
            attestation: record.attested.attestation,
            nonce: record.attested.nonce,
            expirationBlock: record.attested.expirationBlock.toString(),
          },
  };
}

/**
 * A stored attested message, checked: whole-byte hex, a message the CCTP
 * decoder accepts whose nonce equals the stored one (non-zero), an
 * attestation of whole 65-byte signatures, and the expiration block equal
 * to the message's own. Null when anything is off.
 */
function storedAttested(v: unknown): BridgeAttestation | null {
  if (!isObject(v) || !exactKeys(v, ATTESTED_KEYS)) return null;
  if (typeof v.message !== 'string' || !/^0x([0-9a-f]{2})+$/.test(v.message)) return null;
  if (typeof v.attestation !== 'string' || !/^0x([0-9a-f]{2})+$/.test(v.attestation)) return null;
  const sig = (v.attestation.length - 2) / 2;
  if (sig % 65 !== 0 || sig > ATTESTATION_MAX_BYTES) return null;
  if (typeof v.nonce !== 'string' || !HEX_HASH.test(v.nonce) || v.nonce !== v.nonce.toLowerCase() || BigInt(v.nonce) === 0n) return null;
  if (typeof v.expirationBlock !== 'string' || !DECIMAL.test(v.expirationBlock)) return null;
  try {
    const d = decodeCctpBurnMessage(v.message);
    if (d.nonce !== v.nonce || d.body.expirationBlock !== BigInt(v.expirationBlock)) return null;
  } catch {
    return null;
  }
  return { message: v.message, attestation: v.attestation, nonce: v.nonce, expirationBlock: BigInt(v.expirationBlock) };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function exactKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
}

function text(v: unknown, max = LABEL_MAX): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

function hashOrNull(v: unknown): v is string | null {
  return v === null || (typeof v === 'string' && HEX_HASH.test(v));
}

function timestamp(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

function storedAsset(v: unknown): BridgeRoute['sourceAsset'] | null {
  if (!isObject(v)) return null;
  const decimalsOk = typeof v.decimals === 'number' && Number.isInteger(v.decimals) && v.decimals >= 0 && v.decimals <= 36;
  if (!decimalsOk || !text(v.symbol, 20)) return null;
  if (v.kind === 'native' && exactKeys(v, ['kind', 'symbol', 'decimals'])) {
    return { kind: 'native', symbol: v.symbol as string, decimals: v.decimals as number };
  }
  if (v.kind === 'erc20' && exactKeys(v, ['kind', 'address', 'symbol', 'decimals']) && typeof v.address === 'string' && HEX_ADDRESS.test(v.address)) {
    return { kind: 'erc20', address: v.address, symbol: v.symbol as string, decimals: v.decimals as number };
  }
  return null;
}

/**
 * One stored record, checked field by field (exact key sets, formats,
 * chain ids that agree with the CAIP-2 ids); null when anything is off.
 */
export function bridgeRecordFromStored(value: unknown): BridgeTransferRecord | null {
  if (!isObject(value) || !(exactKeys(value, STORED_KEYS_WITH_ATTESTED) || exactKeys(value, STORED_KEYS))) return null;
  const v = value;
  let attested: BridgeAttestation | null = null;
  if (Object.prototype.hasOwnProperty.call(v, 'attested') && v.attested !== null) {
    attested = storedAttested(v.attested);
    // Only a CCTP transfer carries an attested message.
    if (attested === null || v.providerId !== CCTP_V2_PROVIDER_ID) return null;
  }
  if (typeof v.id !== 'string' || !RECORD_ID.test(v.id)) return null;
  if (!text(v.providerId, 40) || !/^[a-z0-9-]{2,40}$/.test(v.providerId) || !text(v.providerLabel)) return null;
  const route = v.route;
  if (!isObject(route) || !exactKeys(route, ['providerId', 'sourceChainId', 'destinationChainId', 'sourceAsset', 'destinationAsset'])) return null;
  if (route.providerId !== v.providerId) return null;
  const chainOk = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
  if (!chainOk(route.sourceChainId) || !chainOk(route.destinationChainId) || route.sourceChainId === route.destinationChainId) return null;
  const sourceAsset = storedAsset(route.sourceAsset);
  const destinationAsset = storedAsset(route.destinationAsset);
  if (!sourceAsset || !destinationAsset) return null;
  if (typeof v.sourceCaip2 !== 'string' || !CAIP2.test(v.sourceCaip2) || v.sourceCaip2 !== `eip155:${route.sourceChainId}`) return null;
  if (typeof v.destinationCaip2 !== 'string' || !CAIP2.test(v.destinationCaip2) || v.destinationCaip2 !== `eip155:${route.destinationChainId}`) return null;
  if (!text(v.sourceLabel) || !text(v.destinationLabel)) return null;
  if (typeof v.amountIn !== 'string' || !DECIMAL.test(v.amountIn) || v.amountIn === '0') return null;
  if (typeof v.recipient !== 'string' || !HEX_ADDRESS.test(v.recipient)) return null;
  if (typeof v.sender !== 'string' || !HEX_ADDRESS.test(v.sender)) return null;
  if (v.senderKind !== 'regular' && v.senderKind !== 'smart-account') return null;
  if (!hashOrNull(v.sourceTxHash) || !hashOrNull(v.userOpHash) || !hashOrNull(v.retryTxHash)) return null;
  // A regular send always knows its transaction; a smart-account one its operation.
  if (v.senderKind === 'regular' ? v.sourceTxHash === null || v.userOpHash !== null : v.userOpHash === null) return null;
  if (v.destinationFromBlock !== null && (typeof v.destinationFromBlock !== 'string' || !DECIMAL.test(v.destinationFromBlock))) return null;
  if (!timestamp(v.sentAt)) return null;
  let status: BridgeTransferStatus | null = null;
  let checkedAt: number | null = null;
  if (v.final !== null) {
    const f = v.final;
    if (!isObject(f) || !exactKeys(f, ['state', 'detail', 'destinationTxHash', 'checkedAt'])) return null;
    if (f.state !== 'delivered' && f.state !== 'failed') return null;
    if (!text(f.detail, DETAIL_MAX) || !hashOrNull(f.destinationTxHash) || !timestamp(f.checkedAt)) return null;
    status = { state: f.state, detail: f.detail, ...(f.destinationTxHash ? { destinationTxHash: f.destinationTxHash } : {}) };
    checkedAt = f.checkedAt;
  }
  return {
    id: v.id,
    providerId: v.providerId,
    providerLabel: v.providerLabel,
    route: {
      providerId: v.providerId,
      sourceChainId: route.sourceChainId,
      destinationChainId: route.destinationChainId,
      sourceAsset,
      destinationAsset,
    },
    sourceCaip2: v.sourceCaip2,
    sourceLabel: v.sourceLabel,
    destinationCaip2: v.destinationCaip2,
    destinationLabel: v.destinationLabel,
    amountIn: BigInt(v.amountIn),
    recipient: v.recipient,
    sender: v.sender,
    senderKind: v.senderKind,
    sourceTxHash: v.sourceTxHash,
    userOpHash: v.userOpHash,
    destinationFromBlock: v.destinationFromBlock === null ? null : BigInt(v.destinationFromBlock),
    sentAt: v.sentAt,
    status,
    checkedAt,
    checkError: null,
    retryTxHash: v.retryTxHash,
    attested,
  };
}

export interface BridgeTransferStore {
  records: BridgeTransferRecord[];
  /** True when the stored document could not be fully read; nothing is written then. */
  readOnly: boolean;
}

/** Parses the stored document: the valid records and whether anything was unreadable. */
export function parseBridgeTransfers(raw: string | null): BridgeTransferStore {
  if (raw === null) return { records: [], readOnly: false };
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { records: [], readOnly: true };
  }
  if (!isObject(doc) || doc.version !== BRIDGE_STORE_VERSION || !Array.isArray(doc.records) || Object.keys(doc).length !== 2) {
    return { records: [], readOnly: true };
  }
  const out: BridgeTransferRecord[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const item of doc.records) {
    const r = bridgeRecordFromStored(item);
    if (!r || seen.has(r.id)) {
      dropped += 1;
      continue;
    }
    seen.add(r.id);
    out.push(r);
  }
  if (out.length > MAX_BRIDGE_TRANSFERS) return { records: out.slice(0, MAX_BRIDGE_TRANSFERS), readOnly: true };
  return { records: out, readOnly: dropped > 0 };
}

/** The records to keep: newest first; over the cap, the oldest finished ones go first, then the oldest. */
export function pruneBridgeTransfers(list: readonly BridgeTransferRecord[]): BridgeTransferRecord[] {
  const newestFirst = [...list].sort((a, b) => b.sentAt - a.sentAt);
  if (newestFirst.length <= MAX_BRIDGE_TRANSFERS) return newestFirst;
  const drop = new Set<BridgeTransferRecord>();
  for (const r of [...newestFirst].reverse()) {
    if (newestFirst.length - drop.size <= MAX_BRIDGE_TRANSFERS) break;
    if (bridgeTransferFinal(r)) drop.add(r);
  }
  const kept = newestFirst.filter((r) => !drop.has(r));
  return kept.slice(0, MAX_BRIDGE_TRANSFERS);
}

function persist(): Promise<void> {
  const target = attached;
  if (!target || target.readOnly) return writeQueue;
  // Only records the strict parse would accept are written, so the wallet
  // never makes its own list read-only; any other stays in memory.
  const stored = listBridgeTransfers()
    .map(bridgeRecordToStored)
    .filter((r) => bridgeRecordFromStored(r) !== null);
  const doc = JSON.stringify({ version: BRIDGE_STORE_VERSION, records: stored });
  // One queue: writes land in the order the changes were made. A failed
  // write is not retried (the next change writes the whole list again).
  writeQueue = writeQueue.then(() => writeStoreItem(target.store, BRIDGE_TRANSFERS_KEY, doc)).catch(() => undefined);
  return writeQueue;
}

/**
 * Reads the open wallet's stored transfers into the screen's list (the
 * Bridge screen calls it when it opens). Records already in memory for the
 * SAME wallet are kept (they are the newest), stored ones are added; when
 * the list in memory belongs to another wallet (the PIN opened the other
 * one) it is replaced. Returns whether the stored list is read-only.
 */
export async function loadBridgeTransfers(store: KeyValueStore = AsyncStorage): Promise<{ readOnly: boolean }> {
  await writeQueue;
  const profileId = storeProfileOf(store).id;
  const parsed = parseBridgeTransfers(await readStoreItem(store, BRIDGE_TRANSFERS_KEY));
  if (attached?.profileId !== profileId) records.clear();
  for (const r of parsed.records) if (!records.has(r.id)) records.set(r.id, r);
  for (const r of pruneRecordsMap()) records.delete(r);
  attached = { store, profileId, readOnly: parsed.readOnly };
  notifyRecords();
  return { readOnly: parsed.readOnly };
}

function pruneRecordsMap(): string[] {
  const keep = new Set(pruneBridgeTransfers([...records.values()]).map((r) => r.id));
  return [...records.keys()].filter((id) => !keep.has(id));
}

/** Whether the stored list could not be read (writes are then skipped). */
export function bridgeTransfersReadOnly(): boolean {
  return attached?.readOnly === true;
}

/** Records a transfer the screen just sent and stores the list. `sentAt` defaults to now. */
export function recordBridgeTransfer(
  plan: BridgePlan,
  sentIn: { sourceTxHash: string | null; userOpHash: string | null; sentAt?: number },
): BridgeTransferRecord {
  const sent = { ...sentIn, sentAt: sentIn.sentAt ?? Date.now() };
  recordCounter += 1;
  const record: BridgeTransferRecord = {
    id: `bridge-${sent.sentAt}-${recordCounter}`,
    providerId: plan.providerId,
    providerLabel: plan.providerLabel,
    route: plan.quote.route,
    sourceCaip2: plan.sourceCaip2,
    sourceLabel: plan.sourceLabel,
    destinationCaip2: plan.destinationCaip2,
    destinationLabel: plan.destinationLabel,
    amountIn: plan.quote.amountIn,
    recipient: plan.recipient,
    sender: plan.sender,
    senderKind: plan.senderKind,
    sourceTxHash: sent.sourceTxHash,
    userOpHash: sent.userOpHash,
    destinationFromBlock: plan.destinationFromBlock,
    sentAt: sent.sentAt,
    status: null,
    checkedAt: null,
    checkError: null,
    retryTxHash: null,
    attested: null,
  };
  records.set(record.id, record);
  for (const id of pruneRecordsMap()) records.delete(id);
  notifyRecords();
  void persist();
  return record;
}

/** Updates fields of a record and stores the list (unknown ids are ignored). */
export function updateBridgeTransfer(id: string, patch: Partial<Omit<BridgeTransferRecord, 'id'>>): BridgeTransferRecord | null {
  const current = records.get(id);
  if (!current) return null;
  const next = { ...current, ...patch };
  records.set(id, next);
  notifyRecords();
  void persist();
  return next;
}

/** Every record of the open wallet, newest first. */
export function listBridgeTransfers(): BridgeTransferRecord[] {
  return [...records.values()].sort((a, b) => b.sentAt - a.sentAt);
}

/** Resolves when every write queued so far has finished (for the checks). */
export function bridgeTransfersWritten(): Promise<void> {
  return writeQueue;
}

/**
 * Forgets every record: the list in memory at once, and, with a store,
 * the stored list too (the wipe, "Reset the transfer list"). Nothing on the
 * network changes. Afterwards the store is writable again.
 */
export async function resetBridgeTransfers(store?: RemovableKeyValueStore): Promise<void> {
  records.clear();
  notifyRecords();
  if (!store) {
    attached = null;
    return;
  }
  await writeQueue;
  if (store.removeItem) await removeStoreItem(store, BRIDGE_TRANSFERS_KEY);
  else await writeStoreItem(store, BRIDGE_TRANSFERS_KEY, JSON.stringify({ version: BRIDGE_STORE_VERSION, records: [] }));
  if (attached && attached.store === store) attached = { ...attached, readOnly: false };
}

/** True when a record needs no more polling. */
export function bridgeTransferFinal(record: Pick<BridgeTransferRecord, 'status'>): boolean {
  return record.status?.state === 'delivered' || record.status?.state === 'failed';
}

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------

/** How often the screen asks while it is open (the brief: every 15 s). */
export const BRIDGE_TRACK_INTERVAL_MS = 15_000;

/** A smart-account transfer whose bundle transaction is not known and no bundler can be asked. */
export const BRIDGE_USEROP_WAITING =
  'Waiting for the bundle transaction that carries the smart-account operation; tracking starts once it is known.';
/** The bundler has no receipt for the operation yet (eth_getUserOperationReceipt answered null). */
export const BRIDGE_USEROP_NOT_INCLUDED =
  'The smart-account operation has not been included yet: the bundler has no receipt for it. Tracking starts once it is included in a bundle transaction.';
/** The operation was included but reverted (the receipt's success flag is false). */
export const BRIDGE_USEROP_REVERTED =
  'The smart-account operation was included but reverted, so nothing was bridged; its network fee was still charged.';
/** A receipt the wallet does not use (wrong shape, another operation or another sender). */
export const BRIDGE_USEROP_RECEIPT_MALFORMED =
  'The bundler’s receipt for the smart-account operation was not in the expected shape, so the wallet did not use it and will ask again.';
/** The longest revert reason quoted from a receipt (characters; judgement). */
const USEROP_REASON_MAX = 200;

/** What a bundler's receipt says about a recorded smart-account bridge operation. */
export type BridgeUserOpOutcome =
  | { kind: 'not-included' }
  | { kind: 'included'; txHash: string }
  | { kind: 'reverted'; txHash: string; reason: string | null };

/**
 * Reads an eth_getUserOperationReceipt answer for a recorded transfer.
 * null → not included yet. Otherwise the receipt must be an object whose
 * success flag and bundle transaction hash summarizeAaReceipt (aa.ts) can
 * read, and whose userOpHash and sender, when present, are this record's;
 * anything else is refused with BRIDGE_USEROP_RECEIPT_MALFORMED and the
 * record is left as it is. The revert reason is quoted only when it is
 * short hex or short printable text.
 */
export function readBridgeUserOpReceipt(
  raw: unknown,
  record: Pick<BridgeTransferRecord, 'userOpHash' | 'sender'>,
): BridgeUserOpOutcome {
  if (raw === null || raw === undefined) return { kind: 'not-included' };
  const refuse = (): never => {
    throw new BridgeRefusal(BRIDGE_USEROP_RECEIPT_MALFORMED);
  };
  if (!isObject(raw)) return refuse();
  if (raw.userOpHash !== undefined && (typeof raw.userOpHash !== 'string' || raw.userOpHash.toLowerCase() !== (record.userOpHash ?? '').toLowerCase())) refuse();
  if (raw.sender !== undefined && (typeof raw.sender !== 'string' || raw.sender.toLowerCase() !== record.sender.toLowerCase())) refuse();
  const summary = summarizeAaReceipt(raw);
  if (summary.success === null || summary.txHash === null) return refuse();
  if (summary.success) return { kind: 'included', txHash: summary.txHash };
  let reason: string | null = null;
  if (typeof raw.reason === 'string') {
    const r = raw.reason.trim();
    if (/^0x[0-9a-fA-F]+$/.test(r) && r.length > 2) reason = r.length <= USEROP_REASON_MAX ? r : `${r.slice(0, USEROP_REASON_MAX)}…`;
    else if (!/^0x/i.test(r) && r.length > 0 && r.length <= USEROP_REASON_MAX && /^[\x20-\x7e]+$/.test(r)) reason = r;
  }
  return { kind: 'reverted', txHash: summary.txHash, reason };
}

/** The failed transfer's sentence for a reverted operation, with the receipt's reason when it gave one. */
export function bridgeUserOpRevertedDetail(reason: string | null): string {
  return reason === null ? BRIDGE_USEROP_REVERTED : `${BRIDGE_USEROP_REVERTED} The bundler reported this reason: ${reason.replace(/[.\s]+$/, '')}.`;
}

/**
 * Asks the provider where a recorded transfer is. The LayerZero adapter
 * decides from the chains' own events (the source receipt's OFTSent and
 * PacketSent, then OFTReceived or UnreceivedTokenCached for the GUID on
 * the receiving network); Scan's status is supporting evidence. Refused on
 * a network the switchboard does not allow. A smart-account transfer whose
 * bundle transaction is not known yet is first resolved through the
 * bundler's receipt when `readers.userOpReceipt` is given, else reported
 * without a request.
 */
export async function trackBridgeTransfer(record: BridgeTransferRecord, readers: BridgeReaders): Promise<BridgeTransferStatus> {
  assertFeatureAllowed(BRIDGE_FEATURE, record.sourceCaip2);
  let sourceTxHash = record.sourceTxHash;
  if (sourceTxHash === null) {
    // A smart-account transfer whose bundle transaction was not known when
    // the app closed: ask the configured bundler for the operation's
    // receipt first. A found hash is stored through the record writer
    // (only what the strict parse accepts reaches storage) and tracking
    // continues by it in the same pass.
    if (record.userOpHash === null || !readers.userOpReceipt) return { state: 'unknown', detail: BRIDGE_USEROP_WAITING };
    const outcome = readBridgeUserOpReceipt(
      await readers.userOpReceipt({ chainId: record.route.sourceChainId, userOpHash: record.userOpHash }),
      record,
    );
    if (outcome.kind === 'not-included') return { state: 'unknown', detail: BRIDGE_USEROP_NOT_INCLUDED };
    updateBridgeTransfer(record.id, { sourceTxHash: outcome.txHash });
    if (outcome.kind === 'reverted') return { state: 'failed', detail: bridgeUserOpRevertedDetail(outcome.reason) };
    sourceTxHash = outcome.txHash;
  }
  const registry = createAppBridgeRegistry(readers, { destinationFromBlock: record.destinationFromBlock });
  const provider = registry.require(record.providerId);
  const transfer = {
    providerId: record.providerId,
    route: record.route,
    sourceTxHash,
    amountIn: record.amountIn,
    recipient: record.recipient,
  };
  if (record.providerId === CCTP_V2_PROVIDER_ID && record.attested) {
    // The stored attested message lets a restart continue without asking
    // Circle; the adapter re-checks it against the burn. If it no longer
    // matches (a damaged or stale store), Circle's API is asked instead.
    const stored = await provider.track({ ...transfer, attested: { message: record.attested.message, attestation: record.attested.attestation } });
    if (stored.state !== 'unknown' || stored.onChain?.status !== 'unknown' || stored.onChain.guid !== null || !/stored on this phone/.test(stored.detail)) {
      return stored;
    }
    updateBridgeTransfer(record.id, { attested: null });
  }
  return provider.track(transfer);
}

/**
 * The record fields a tracking answer changes: the status, when it was
 * learned, no error, and a CCTP transfer's attested message once the
 * adapter has checked one (kept when the answer carries none).
 */
export function trackedPatch(
  record: Pick<BridgeTransferRecord, 'attested'>,
  status: BridgeTransferStatus,
  now: number,
): Pick<BridgeTransferRecord, 'status' | 'checkedAt' | 'checkError' | 'attested'> {
  return { status, checkedAt: now, checkError: null, attested: status.attestation ?? record.attested };
}

/** The heading over the adapter's own detail sentence, for each state. */
export function bridgeStatusHeading(status: BridgeTransferStatus | null, destinationLabel: string, providerId?: string): string {
  if (providerId === CCTP_V2_PROVIDER_ID) {
    if (status?.state === 'in-flight') return 'Waiting for Circle’s attestation';
    if (status?.state === 'awaiting-destination-action' && status.onChain?.status === 'attested') return `Attested: waiting for the mint on ${destinationLabel}`;
  }
  switch (status?.state) {
    case undefined:
      return 'Not checked yet';
    case 'in-flight':
      return 'On its way';
    case 'delivered':
      return `Delivered on ${destinationLabel}`;
    case 'awaiting-destination-action':
      return `Waiting for a transaction on ${destinationLabel}`;
    case 'failed':
      return 'Failed';
    case 'unknown':
      return 'Not known yet';
  }
}

/**
 * The tracking line shown under the heading: the adapter's detail,
 * verbatim, except the two CCTP waiting states, which the wallet words
 * with the network names (the adapter's detail does not know them).
 */
export function bridgeStatusSentence(
  record: Pick<BridgeTransferRecord, 'status' | 'checkError' | 'destinationLabel'> & Partial<Pick<BridgeTransferRecord, 'providerId' | 'sourceLabel'>>,
): string {
  if (record.checkError && !record.status) return `The transfer could not be checked just now: ${record.checkError}`;
  if (!record.status) return 'The wallet has not asked where this transfer is yet.';
  if (record.providerId === CCTP_V2_PROVIDER_ID && record.sourceLabel) {
    const onChain = record.status.onChain;
    if (record.status.state === 'in-flight' && onChain?.status === 'in-flight') {
      return cctpBurnedSentence(record.sourceLabel, onChain.sourceBlock ?? null);
    }
    if (record.status.state === 'awaiting-destination-action' && onChain?.status === 'attested') {
      return cctpAttestedSentence(record.destinationLabel);
    }
  }
  return record.status.detail;
}

/** CCTP, burned and waiting for the attestation. */
export function cctpBurnedSentence(sourceLabel: string, block: bigint | null): string {
  return (
    `Burned on ${sourceLabel}${block === null ? '' : ` (block ${block})`}. Waiting for Circle’s attestation: it comes after the ` +
    'source chain’s hard finality, about 17 minutes in the measured runs.'
  );
}

/** CCTP, attested and not minted yet. */
export function cctpAttestedSentence(destinationLabel: string): string {
  return `Attested. The USDC can now be minted on ${destinationLabel}.`;
}

/**
 * Whether the attested message expires, in plain words, from Circle's own
 * documents: the technical guide (https://developers.circle.com/cctp/
 * references/technical-guide.md, fetched 2026-10-25, sha256
 * 0755271b…14f6, "Message body") says the attestation service writes "An
 * expiration block 24 hours in the future" into the message and "If the
 * burn expires, it must be re-signed", and that re-attestation through POST
 * /v2/reattest/{nonce} has "no deadline"; it also says that on Arbitrum the
 * expiration block "is an Ethereum (L1) block number". Circle's contract
 * accepts a message whose expiration block is 0 at any time
 * (TokenMessengerV2.sol lines 415-420 at evm-cctp-contracts 63ab1f0a:
 * `_expirationBlock == 0 || _expirationBlock > block.number`), and both
 * Standard Transfers of 2026-10-25 were attested with expiration block 0
 * (docs/BRIDGING.md section 17).
 */
export function cctpExpirySentence(attested: Pick<BridgeAttestation, 'expirationBlock'> | null, destinationLabel: string): string {
  if (attested === null) {
    return 'Circle’s attested message is valid until it is used, unless it carries an expiration block: Circle’s technical guide says an expired message must be re-attested by Circle (possible at any time) before it can be minted.';
  }
  if (attested.expirationBlock === 0n) {
    return 'The attested message carries no expiration block (0), so it stays valid until the mint is sent: Circle’s contract accepts such a message at any time, and only once.';
  }
  const arb = /arbitrum/i.test(destinationLabel) ? ' (on Arbitrum an Ethereum block number, as Circle’s guide notes)' : '';
  return (
    `The attested message expires after block ${attested.expirationBlock}${arb}. After that Circle’s contract refuses it until Circle ` +
    're-attests it, which Circle’s technical guide says can be requested at any time; this wallet does not request it.'
  );
}

/**
 * The mint call the tracking offers, checked: exactly one call, to Circle's
 * pinned MessageTransmitterV2, value 0, receiveMessage, and — when the
 * record holds the attested message — exactly receiveMessage(that message,
 * that attestation). Null when the status carries none or it fails a check.
 */
export function bridgeMintCall(record: Pick<BridgeTransferRecord, 'status' | 'providerId' | 'attested'>): Call | null {
  if (record.providerId !== CCTP_V2_PROVIDER_ID) return null;
  const st = record.status;
  if (st?.state !== 'awaiting-destination-action' || st.onChain?.status !== 'attested') return null;
  const calls = st.destinationCalls;
  if (!calls || calls.length !== 1) return null;
  const call = calls[0]!;
  if (call.to.toLowerCase() !== CCTP_V2_TESTNET.messageTransmitterV2.toLowerCase() || call.value !== 0n) return null;
  if (toHex(call.data).slice(0, 10).toLowerCase() !== CCTP_RECEIVE_MESSAGE_SELECTOR) return null;
  const attested = st.attestation ?? record.attested;
  if (!attested || toHex(call.data).toLowerCase() !== toHex(encodeReceiveMessage(attested.message, attested.attestation)).toLowerCase()) return null;
  return call;
}

/**
 * Why the mint cannot be sent from here right now, or null when it can:
 * the receiving network must be the active one, and the regular account
 * must hold some of its coin there (`nativeBalance`, read by the screen;
 * null while unread, which does not block: the quote checks the balance
 * again). Each sentence says that anyone with gas there can send it, and
 * whether the attested message expires.
 */
export function bridgeMintBlocker(
  activeCaip2: string,
  record: Pick<BridgeTransferRecord, 'destinationCaip2' | 'destinationLabel' | 'recipient' | 'attested'>,
  nativeBalance: bigint | null,
  nativeSymbol = 'test ETH',
): string | null {
  const expiry = cctpExpirySentence(record.attested, record.destinationLabel);
  if (activeCaip2 !== record.destinationCaip2) {
    return (
      `Anyone with ${nativeSymbol} on ${record.destinationLabel} can send this mint transaction, and the USDC still goes only to ` +
      `${record.recipient}. ${expiry} To send it from this wallet, switch to ${record.destinationLabel} (Settings → Developer) and ` +
      'come back to this screen; this transfer stays listed here.'
    );
  }
  if (nativeBalance === 0n) {
    return (
      `Your regular account holds no ${nativeSymbol} on ${record.destinationLabel} to pay for the mint transaction. Anyone with ` +
      `${nativeSymbol} there can send it, and the USDC still goes only to ${record.recipient}. ${expiry}`
    );
  }
  return null;
}

/** The regular-account quote for the mint, on the receiving network (the active one). */
export async function prepareBridgeMint(url: string, from: string, record: BridgeTransferRecord): Promise<EvmSendQuote> {
  assertFeatureAllowed(BRIDGE_FEATURE, record.destinationCaip2);
  const call = bridgeMintCall(record);
  if (!call) throw new BridgeRefusal('There is no mint transaction to send for this transfer.');
  return prepareEvmSend(url, from, call.to, 0n, call.data, record.destinationCaip2);
}

/** The device prompt for the mint. */
export function bridgeMintPromptTitle(record: Pick<BridgeTransferRecord, 'destinationLabel'>): string {
  return `Mint the bridged USDC on ${record.destinationLabel}`;
}

/**
 * The retry call the tracking offers, checked: exactly one call, to the
 * pinned Stargate pool of the RECEIVING chain, value 0, with the
 * retryReceiveToken selector. Null when the status carries none or it
 * fails a check.
 */
export function bridgeRetryCall(record: Pick<BridgeTransferRecord, 'status' | 'route'>): Call | null {
  if (record.status?.onChain?.status === 'attested') return null;
  const calls = record.status?.state === 'awaiting-destination-action' ? record.status.destinationCalls : undefined;
  if (!calls || calls.length !== 1) return null;
  const call = calls[0]!;
  const pool = stargatePoolOn(record.route.destinationChainId);
  if (!pool || call.to.toLowerCase() !== pool.address.toLowerCase()) return null;
  if (call.value !== 0n) return null;
  if (toHex(call.data).slice(0, 10).toLowerCase() !== STARGATE_RETRY_RECEIVE_TOKEN_SELECTOR) return null;
  return call;
}

/** Why the retry cannot be sent from here right now, or null when it can. */
export function bridgeRetryBlocker(activeCaip2: string, record: Pick<BridgeTransferRecord, 'destinationCaip2' | 'destinationLabel'>): string | null {
  if (activeCaip2 !== record.destinationCaip2) {
    return `Anyone can send this delivery transaction on ${record.destinationLabel}, paying the gas there. To send it from this wallet, switch to ${record.destinationLabel} (Settings → Developer) and come back to this screen; this transfer stays listed here.`;
  }
  return null;
}

/** The regular-account quote for the retry, on the receiving network (the active one). */
export async function prepareBridgeRetry(url: string, from: string, record: BridgeTransferRecord): Promise<EvmSendQuote> {
  assertFeatureAllowed(BRIDGE_FEATURE, record.destinationCaip2);
  const call = bridgeRetryCall(record);
  if (!call) throw new BridgeRefusal('There is no delivery transaction to send for this transfer.');
  return prepareEvmSend(url, from, call.to, 0n, call.data, record.destinationCaip2);
}

/** The device prompt for the retry. */
export function bridgeRetryPromptTitle(record: Pick<BridgeTransferRecord, 'destinationLabel'>): string {
  return `Deliver bridged test ETH waiting in Stargate’s pool on ${record.destinationLabel}`;
}

/** For the checks: LayerZero endpoint ids of the chains the screen offers. */
export function bridgeEidTable(): Record<number, number> {
  const out: Record<number, number> = {};
  for (const [chainId, entry] of Object.entries(LAYERZERO_V2_TESTNET)) out[Number(chainId)] = entry.eid;
  return out;
}

/** The trust statements, re-exported for the screen and the checks (verbatim from the engine). */
export const BRIDGE_TRUST: Readonly<Record<string, BridgeTrustStatement>> = Object.freeze({
  [LAYERZERO_OFT_PROVIDER_ID]: LAYERZERO_OFT_TRUST,
  [CCTP_V2_PROVIDER_ID]: CCTP_V2_TRUST,
});
