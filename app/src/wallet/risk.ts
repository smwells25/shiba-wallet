import { toChecksumAddress } from '@shiba-wallet/core';
import {
  CCTP_V2_TESTNET,
  CCTP_V2_TESTNET_DOMAINS,
  CCTP_V2_TESTNET_USDC,
  ENS_V2_SEPOLIA,
  LIDO_DEPLOYMENTS,
  MAX_UINT256,
  ROCKET_POOL_DEPLOYMENTS,
  SET_APPROVAL_FOR_ALL_SELECTOR,
  classifyRecipient,
  encodeErc20Approve,
  encodeErc20Transfer,
  ensOwnedResolverSalt,
  findCodeDeploymentBlock,
  isFirstInteraction,
  predictVerifiableProxyAddress,
  resolveRocketPool,
  riskSignals,
  rocketPoolDeploymentFor,
  toBytes,
  toHex,
  type AssetChange,
  type DeploymentSearchResult,
  type FirstInteractionResult,
  type JsonRpcTransport,
  type RecipientClass,
  type RiskSignalType,
} from '@shiba-wallet/chains-evm';
// Explicit .ts extension: this module is imported by
// scripts/check-approvals.mjs under Node's type stripping, which resolves
// relative specifiers literally.
import { groupThousands, sanitizeSymbol, simulationTransport } from './simulation.ts';
import { WALLET_7702_DELEGATE } from './delegation.ts';
import { walletAddressesFor, type AaAddressFacts } from './activity-sentences.ts';
import { ownMultisigAddresses } from './multisig.ts';
import { evmProfileByCaip2 } from '../config/evm-chain.ts';
import { knownStakingTokensForChain } from './tokens.ts';

/**
 * Risk warnings for EVM confirm screens (phase 7, item 5, app half). The
 * facts come from the engine's contract-risk.ts over plain JSON-RPC against
 * the ACTIVE chain's endpoint; the engine's riskSignals aggregator turns them
 * into typed signals, and computeRiskLines (pure) orders them for display.
 * There are no scores, reputation lists or vendors involved.
 *
 * What is checked, and the honesty rules for each:
 *  - Recipient class (classifyRecipient on the transaction's `to`): ordinary
 *    account, contract, or EIP-7702 delegated account. A failed lookup
 *    produces no signal.
 *  - Approvals: taken from the balance-change preview's asset changes when
 *    the caller has them; otherwise decoded from the calldata of a DIRECT
 *    approve(address,uint256) or setApprovalForAll(address,bool) call (see
 *    approvalChangesFromCalldata for the exact rule and its limits).
 *  - Recipient class: always shown as a line when known (or a line saying
 *    it could not be checked), so a confirm screen with an endpoint never
 *    shows an empty risk card.
 *  - First interaction: token transfers are searched with
 *    isFirstInteraction over the tracked tokens plus the known test-network
 *    tokens (the free public endpoints refuse log filters without a
 *    contract address), and plain ETH transfers through the history indexer
 *    when one is configured (searchNativeInteraction). The notice always
 *    names what was searched; when nothing could be searched it says so
 *    ("could not be checked") instead of staying silent — the wallet never
 *    claims "first time" without having looked.
 *  - New contract (findCodeDeploymentBlock): needs historical eth_getCode,
 *    which free endpoints refuse beyond about 64 blocks (engine live probe,
 *    2026-10-01). The search is bounded to the per-chain threshold window
 *    below; when the endpoint refuses that depth, a shallower probe finds
 *    the depth it does serve and searches inside it (contractAgeFacts). A
 *    contract whose age still cannot be compared with the threshold gets
 *    the neutral CONTRACT_AGE_UNKNOWN_LINE, never a "new contract" warning.
 *
 *  - Token transfers (the transaction is transfer(recipient, amount) on an
 *    ERC-20 contract the wallet tracks or knows on the ACTIVE chain, and
 *    that contract holds code): the card is about the RECIPIENT, exactly as
 *    for a plain ETH send — "This sends USDC through its token contract
 *    0x… to …" — and the class, age and delegation checks run on the
 *    recipient. The token contract itself gets no contract-age or
 *    "goes to a contract" line, because the user chose to track it (or the
 *    wallet pins it) on this very chain. Any other contract — an untracked
 *    token, a tracked token's address on another chain, a call that is not
 *    a plain transfer to the named recipient, or a "token" address without
 *    code — keeps every existing line about the contract (see
 *    tokenTransferTarget).
 *
 *  - Staking contracts (phase 18): a transaction whose `to` is one of the
 *    staking contracts the engine pins for the ACTIVE chain (staking.ts
 *    LIDO_DEPLOYMENTS and ROCKET_POOL_DEPLOYMENTS: Lido's stETH, wstETH and
 *    withdrawal queue on Ethereum Sepolia and Hoodi, Rocket Pool's rETH on
 *    Hoodi; docs/STAKING.md 4.1 and 5.3), and that holds code, gets one line
 *    naming the protocol and the contract — "This transaction goes to
 *    Lido's stETH contract on Ethereum Sepolia (0x…), pinned by this
 *    wallet…" — instead of "goes to a contract", the contract-age line and
 *    the first-interaction line, the same way the pinned Universal Router
 *    addresses are named in the engine's activity-decode.ts. The match is on
 *    the exact (chain, address) pair (address compared case-insensitively,
 *    all 40 hex digits); a look-alike address or the same address on
 *    another chain keeps every generic line. Approval warnings decoded from
 *    the calldata are kept. Rocket Pool's deposit pool is NOT pinned (the
 *    wallet resolves it from RocketStorage at every quote), so it is
 *    re-resolved HERE, at the check, from the pinned RocketStorage through
 *    the same endpoint (engine resolveRocketPool, which also refuses a
 *    registry whose rETH differs from the pinned one): only when `to`
 *    equals the address RocketStorage names right now does the card say
 *    "This transaction goes to Rocket Pool's deposit pool (0x…), resolved
 *    just now from Rocket Pool's pinned RocketStorage contract on Hoodi."
 *    (finding 4 of the phase 20 item 0 pass); a different address, a failed
 *    read or another chain keeps every generic line, and nothing resolved
 *    earlier is reused. RocketStorage itself is never a transaction target
 *    of the wallet and is not listed.
 *
 *  - Bridge contracts (phase 23, pass p23-cctp finding 4): Circle's
 *    TokenMessengerV2, which the wallet pins for Circle CCTP V2 on the four
 *    test networks it serves (engine CCTP_V2_TESTNET and
 *    CCTP_V2_TESTNET_DOMAINS: Ethereum, OP, Arbitrum and Base Sepolia, the
 *    same address on each, checked on-chain on 2026-10-25 — docs/BRIDGING.md
 *    section 17). The burn's `to` is that contract: the card names it in
 *    one line, like a staking contract, instead of "goes to a contract",
 *    the contract-age line and the first-interaction line. The approval
 *    before the burn goes to the USDC contract with approve(TokenMessengerV2,
 *    amount): the card used to describe the USDC contract ("goes to a
 *    contract", its age, a first-transfer search about the token itself);
 *    now, when `to` is a token the wallet tracks or knows on this chain (or
 *    Circle's USDC the CCTP table pins there) and holds code, and the
 *    calldata is exactly approve(<the pinned spender on this chain>, x),
 *    the card describes the SPENDER in one line (bridgeApprovalText). The
 *    engine's approval signals from the calldata are kept. The match is on
 *    the exact (chain, address) pair; a look-alike spender, the address on
 *    a network CCTP does not serve, a token without code or an unknown
 *    token keeps every generic line. Stargate's pools are NOT listed here:
 *    the Bridge confirm names them in its own line beside the card.
 *    Pass p23-mint finding 2: Circle's MessageTransmitterV2 (engine
 *    CCTP_V2_TESTNET.messageTransmitterV2, packages/chains-evm/src/bridge/
 *    cctp-v2.ts line 64; the four networks of CCTP_V2_TESTNET_DOMAINS, lines
 *    69–74), the target of the mint (receiveMessage) on the receiving
 *    network, is pinned the same way and named in one line. It never takes
 *    tokens, so an approval naming it as the spender is NOT described by
 *    the spender: only TokenMessengerV2 is accepted as a pinned spender.
 *
 * The look-alike-contact warning is NOT produced here; it stays in
 * ./contacts.ts and the send screens' RecipientContactNotice.
 *
 * Free of React Native imports so scripts/check-approvals.mjs exercises
 * this exact code with a fake JSON-RPC node.
 */

// ---------------------------------------------------------------------------
// Thresholds and lookbacks (documented choices, not standards)
// ---------------------------------------------------------------------------

/**
 * Ethereum proof-of-stake produces at most one block per 12-second slot
 * (ethereum.org, "Blocks": "In every slot (spaced twelve seconds apart) a
 * validator is randomly selected to be the block proposer", and slots "can
 * sometimes go empty"). Measured 2026-10-01 over the latest 10,000 blocks
 * via the app's default publicnode endpoints: 12.05 s/block on mainnet and
 * 12.07 s/block on Sepolia. Used only to phrase block counts as approximate
 * durations for the user; nothing is decided from it.
 */
export const SECONDS_PER_BLOCK_ESTIMATE = 12;

/**
 * Per-chain block time for the same phrasing. Base Sepolia produces a block
 * every 2 seconds (sources under NEW_CONTRACT_THRESHOLD_BLOCKS below);
 * chains not listed use SECONDS_PER_BLOCK_ESTIMATE. Since the known
 * test-network tokens (tokens.ts) made the first-interaction search and the
 * approvals scan run on Base Sepolia, their range sentences need it.
 */
export const SECONDS_PER_BLOCK_BY_CHAIN: Readonly<Record<string, number>> = {
  'eip155:84532': 2,
  // Arbitrum Sepolia: 0.25 s, measured (sources under
  // NEW_CONTRACT_THRESHOLD_BLOCKS below).
  'eip155:421614': 0.25,
  // Hoodi: 12-second slots like Ethereum (the same figure the unlisted
  // chains get, listed so the choice is explicit); measured blocks are
  // slower because slots go empty (see NEW_CONTRACT_THRESHOLD_BLOCKS).
  'eip155:560048': 12,
  // OP Sepolia: 2 s, measured (see NEW_CONTRACT_THRESHOLD_BLOCKS).
  'eip155:11155420': 2,
};

/**
 * "New contract" threshold, per CAIP-2 chain, in blocks. The engine has no
 * built-in threshold (contract-risk.ts leaves it to the app on purpose).
 *
 * CHOICE: 50,400 blocks = 7 days x 7,200 blocks/day at 12-second slots, on
 * both Ethereum mainnet and Sepolia (same slot time, measured above). The
 * reasoning is a product judgement, not an industry standard or a measured
 * fraud statistic: a contract younger than one week has had little public
 * use or review, and a week is long enough that ordinary dApp contracts a
 * user meets have usually been live longer, so the warning stays rare. It
 * should be revisited with real-world data. Chains not listed get no
 * new-contract check at all.
 *
 * Base Sepolia (phase 11 item 5): the same 7 days, at Base's 2-second
 * blocks: 7 x 86,400 s / 2 s = 302,400 blocks. Sources (read 2026-10-03):
 * docs.base.org "Transaction Ordering"
 * (https://docs.base.org/specifications/transactions/transaction-ordering:
 * Flashblocks "reduce effective block times from 2 seconds to 200
 * milliseconds through preconfirmations" — the 200 ms preconfirmations do
 * not change the block number, which still advances every 2 seconds) and
 * "Network Fees" (https://docs.base.org/specifications/transactions/network-fees:
 * "18 blocks × 2 seconds = 36 seconds"); measured live the same day over
 * the latest 10,000 Base Sepolia blocks via the app's default endpoint:
 * exactly 2.0 s/block. Free endpoints usually refuse historical
 * eth_getCode this far back, which gives "unknown" and no signal, exactly
 * as on Ethereum.
 *
 * Arbitrum Sepolia (phase 14 integration): the same 7 days at 0.25 s per
 * block: 7 x 86,400 s / 0.25 s = 2,419,200 blocks. Arbitrum does not
 * document a fixed block time: its "Block gas limit, numbers and time" page
 * (https://docs.arbitrum.io/arbitrum-essentials/arbitrum-vs-ethereum/block-numbers-and-time.md,
 * read 2026-10-04) says "block creation depends entirely on chain usage,
 * meaning that block production only occurs when there are transactions to
 * sequence". The figure is therefore MEASURED: on 2026-10-04 (UTC
 * 2026-10-05T02:12) the latest 1,000,000 Arbitrum Sepolia blocks spanned
 * 250,118 s on arbitrum-sepolia-rpc.publicnode.com and 250,117 s on
 * sepolia-rollup.arbitrum.io/rpc, both answering eth_chainId 0x66eee, i.e.
 * 0.2501 s per block. If blocks come more slowly than that, 2,419,200 blocks
 * cover MORE than 7 days, so the warning errs towards showing, never towards
 * hiding.
 *
 * Hoodi (phase 18 item 1): the same 50,400 blocks as Ethereum, the 7 days
 * at Ethereum's 12-second slots. Hoodi skips more slots: measured on
 * 2026-10-11 UTC through ethereum-hoodi-rpc.publicnode.com (eth_chainId
 * 0x88bb0), the latest 1,000 blocks took 13.37 s each on average, 10,000
 * blocks 13.52 s and 50,400 blocks 676,608 s (7.8 days). Slower blocks make
 * the window LONGER than 7 days, so the warning errs towards showing.
 *
 * OP Sepolia (phase 18 item 1): an OP-stack chain like Base Sepolia, so the
 * same 302,400 two-second blocks. Measured on 2026-10-11 UTC through
 * optimism-sepolia-rpc.publicnode.com (eth_chainId 0xaa37dc): exactly 2,000
 * s over the latest 1,000 blocks, 20,000 s over 10,000 and 100,800 s over
 * 50,400.
 *
 * The search runs from (head - threshold) to head: if code already exists
 * at the start, the contract is older than the threshold and no signal is
 * raised (the engine reports atOrBefore). On free endpoints the very first
 * historical eth_getCode is refused, which this module turns into "unknown".
 */
export const NEW_CONTRACT_THRESHOLD_BLOCKS: Readonly<Record<string, bigint>> = {
  'eip155:1': 50_400n,
  'eip155:11155111': 50_400n,
  'eip155:84532': 302_400n,
  'eip155:421614': 2_419_200n,
  'eip155:560048': 50_400n,
  'eip155:11155420': 302_400n,
};

/** The new-contract window in seconds (7 days; see NEW_CONTRACT_THRESHOLD_BLOCKS). */
export const NEW_CONTRACT_THRESHOLD_SECONDS = 7 * 86_400;

/**
 * The block time of a network the user added (feature 33), in seconds, as
 * MEASURED when it was saved (wallet/custom-networks.ts: the head block's
 * timestamp minus that of the block 100 below it, divided by 100), or null
 * for a built-in chain, an unknown chain, or a custom network whose
 * measurement failed.
 */
function customSecondsPerBlock(chainCaip2: string): number | null {
  const ms = evmProfileByCaip2(chainCaip2)?.custom?.blockTimeMs;
  return typeof ms === 'number' && Number.isSafeInteger(ms) && ms > 0 ? ms / 1000 : null;
}

/**
 * Seconds per block for phrasing block counts as durations: the built-in
 * table, then a custom network's measured block time, else the Ethereum
 * estimate (SECONDS_PER_BLOCK_ESTIMATE).
 */
export function secondsPerBlockFor(chainCaip2: string): number {
  return SECONDS_PER_BLOCK_BY_CHAIN[chainCaip2] ?? customSecondsPerBlock(chainCaip2) ?? SECONDS_PER_BLOCK_ESTIMATE;
}

/**
 * The new-contract threshold in blocks for a chain: the built-in table
 * (NEW_CONTRACT_THRESHOLD_BLOCKS), else, for a network the user added,
 * 7 days at its block time MEASURED when it was saved (rounded up, so the
 * window is never shorter than 7 days at that rate), else undefined (no
 * new-contract check, the rule for every chain the table does not list —
 * also a custom network whose block time could not be measured). The
 * measurement is a 100-block sample: if blocks later come faster than
 * measured, the window covers less than 7 days; if slower, more. Stated in
 * Settings → Developer with the measured figure.
 */
export function newContractThresholdBlocks(chainCaip2: string): bigint | undefined {
  const builtIn = NEW_CONTRACT_THRESHOLD_BLOCKS[chainCaip2];
  if (builtIn !== undefined) return builtIn;
  const ms = evmProfileByCaip2(chainCaip2)?.custom?.blockTimeMs;
  if (typeof ms !== 'number' || !Number.isSafeInteger(ms) || ms <= 0) return undefined;
  const window = BigInt(NEW_CONTRACT_THRESHOLD_SECONDS) * 1000n;
  return (window + BigInt(ms) - 1n) / BigInt(ms);
}

/** eth_getLogs window size (token-history.ts's 9,000-block window). */
export const RISK_LOG_WINDOW_BLOCKS = 9_000n;

/**
 * First-interaction lookback: first try the token-history bounded lookback
 * (8 windows of 9,000 = 72,000 blocks, about 10 days). Live probe
 * 2026-10-01: https://ethereum.publicnode.com (the app's working mainnet
 * default) refuses eth_getLogs whose fromBlock is more than about 10,000
 * blocks behind the head (-32602 "Archive requests require a personal
 * token"), so on refusal the search is retried over a single 9,000-block
 * window, which that endpoint serves. The notice names the range actually
 * searched.
 */
export const FIRST_INTERACTION_LOOKBACK_BLOCKS = 72_000n;
export const FIRST_INTERACTION_FALLBACK_BLOCKS = 9_000n;

/**
 * Shallower contract-age probes, used when the endpoint refuses historical
 * state at the full threshold depth (phase 11 item 6 finding F2: on
 * Sepolia, publicnode answered "state at block … is pruned" 50,400 blocks
 * back, so a 150-block-old contract got no warning). Deepest first; the
 * first depth at which eth_getCode answers is the depth this endpoint
 * serves, and the deployment search then runs inside it — the same idea as
 * token-history.ts, which keeps what the endpoint actually answered.
 * Depths at or beyond the chain's threshold are skipped (the full search
 * already covered them). The engine's 2026-10-01 probe of
 * ethereum.publicnode.com answered at latest-64 and refused at latest-127.
 */
export const CONTRACT_AGE_PROBE_DEPTHS: readonly bigint[] = [16_384n, 4_096n, 1_024n, 256n, 128n, 64n, 32n];

/** The neutral line when a contract's age cannot be established. */
export const CONTRACT_AGE_UNKNOWN_LINE = 'Contract age could not be checked on this endpoint.';

/**
 * alchemy_getAssetTransfers page size for the native-ETH first-interaction
 * search through the history indexer: the documented default,
 * 0x3e8 = 1,000 (www.alchemy.com/docs/reference/alchemy-getassettransfers,
 * "maxCount" default "0x3e8", re-read 2026-10-03).
 */
export const NATIVE_INTERACTION_MAX_COUNT = 1_000;

// ---------------------------------------------------------------------------
// Calldata-derived approvals
// ---------------------------------------------------------------------------

/** approve(address,uint256) selector, taken from the engine's encoder (no hardcoded hex). */
export const ERC20_APPROVE_SELECTOR_HEX = toHex(
  encodeErc20Approve('0x0000000000000000000000000000000000000000', 0n).slice(0, 4),
);
export const SET_APPROVAL_FOR_ALL_SELECTOR_HEX = toHex(SET_APPROVAL_FOR_ALL_SELECTOR);
/** transfer(address,uint256) selector, taken from the engine's encoder (no hardcoded hex). */
export const ERC20_TRANSFER_SELECTOR_HEX = toHex(
  encodeErc20Transfer('0x0000000000000000000000000000000000000000', 0n).slice(0, 4),
);

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function checksum(address: string): string {
  return toChecksumAddress(toBytes(address.toLowerCase()));
}

function dataToHex(data: Uint8Array | string | undefined): string {
  if (data === undefined) return '0x';
  const hex = typeof data === 'string' ? data : toHex(data);
  return hex.toLowerCase();
}

/** Address from an ABI word whose top 12 bytes are zero, else null. */
function wordToAddress(word: string): string | null {
  if (word.length !== 64 || !/^0{24}/.test(word)) return null;
  return checksum('0x' + word.slice(24));
}

/**
 * The approval a DIRECT call grants, decoded from its calldata, as engine
 * AssetChange entries (callIndex 0, owner = the wallet, token = `to`):
 *  - approve(address,uint256): an 'erc20-approval' (unlimited exactly at
 *    type(uint256).max, the engine's definition);
 *  - setApprovalForAll(address,bool): an 'approval-for-all'.
 * Only exactly-sized calldata (selector + two words) with a clean address
 * word (and a 0/1 bool word) is decoded; anything else yields nothing.
 *
 * LIMITS: this is the fallback for when no simulation result is available.
 * It sees only the top-level call, not approvals made indirectly by a
 * contract. ERC-721's per-token approve(address,uint256 tokenId) has the
 * same selector as the ERC-20 approve, so an ERC-721 approve whose token id
 * happens to be type(uint256).max would be read as an unlimited approval —
 * an over-warning, never a missed one. The simulation's event-based
 * changes, when passed in, take precedence and do not have this ambiguity.
 */
export function approvalChangesFromCalldata(
  to: string,
  wallet: string,
  data: Uint8Array | string | undefined,
): AssetChange[] {
  if (!ADDRESS.test(to) || !ADDRESS.test(wallet)) return [];
  const hex = dataToHex(data);
  if (!/^0x[0-9a-f]*$/.test(hex) || hex.length !== 2 + 8 + 128) return [];
  const selector = hex.slice(0, 10);
  const word1 = hex.slice(10, 74);
  const word2 = hex.slice(74, 138);
  const first = wordToAddress(word1);
  if (!first) return [];
  if (selector === ERC20_APPROVE_SELECTOR_HEX) {
    const amount = BigInt('0x' + word2);
    return [
      {
        type: 'erc20-approval',
        callIndex: 0,
        token: checksum(to),
        owner: checksum(wallet),
        spender: first,
        amount,
        unlimited: amount === MAX_UINT256,
      },
    ];
  }
  if (selector === SET_APPROVAL_FOR_ALL_SELECTOR_HEX) {
    const flag = BigInt('0x' + word2);
    if (flag !== 0n && flag !== 1n) return [];
    return [
      {
        type: 'approval-for-all',
        callIndex: 0,
        token: checksum(to),
        owner: checksum(wallet),
        operator: first,
        approved: flag === 1n,
      },
    ];
  }
  return [];
}

/**
 * The recipient of a DIRECT ERC-20 transfer(address,uint256) call, decoded
 * from its calldata (EIP-55), or null. Only exactly-sized calldata (selector
 * plus two words) with a clean address word counts, the same strictness as
 * approvalChangesFromCalldata.
 */
export function erc20TransferRecipientFromCalldata(data: Uint8Array | string | undefined): string | null {
  const hex = dataToHex(data);
  if (!/^0x[0-9a-f]*$/.test(hex) || hex.length !== 2 + 8 + 128) return null;
  if (hex.slice(0, 10) !== ERC20_TRANSFER_SELECTOR_HEX) return null;
  return wordToAddress(hex.slice(10, 74));
}

/**
 * The token whose transfer the card may describe in terms of its recipient,
 * or null. All of these must hold, otherwise the card keeps describing the
 * contract `to` exactly as before:
 *  - `to` is one of `tokens` (the caller passes the tracked tokens plus the
 *    known test-network tokens of the ACTIVE chain only), matched on the
 *    full address;
 *  - a counterparty is given and differs from `to`;
 *  - the calldata is exactly transfer(counterparty, amount).
 * Whether `to` really holds contract code is checked separately on the
 * network (gatherRiskFacts); a "token" address without code keeps the
 * engine's no-code warning.
 */
export function tokenTransferTarget(
  to: string,
  counterparty: string | undefined,
  data: Uint8Array | string | undefined,
  tokens: readonly RiskTokenRef[],
): RiskTokenRef | null {
  if (!ADDRESS.test(to) || !counterparty || !ADDRESS.test(counterparty)) return null;
  if (counterparty.toLowerCase() === to.toLowerCase()) return null;
  const recipient = erc20TransferRecipientFromCalldata(data);
  if (!recipient || recipient.toLowerCase() !== counterparty.toLowerCase()) return null;
  return tokens.find((t) => ADDRESS.test(t.address) && t.address.toLowerCase() === to.toLowerCase()) ?? null;
}

// ---------------------------------------------------------------------------
// Facts -> lines (pure)
// ---------------------------------------------------------------------------

/**
 * Result of the native-ETH first-interaction search through the history
 * indexer (alchemy_getAssetTransfers, fromAddress = the wallet, categories
 * external + internal). These entries describe value the wallet's own
 * transactions (or its smart account's calls) moved, so a match is
 * evidence, unlike a Transfer log anyone can emit.
 */
export interface NativeInteractionResult {
  /** True when a transfer from the wallet to the counterparty was listed. */
  known: boolean;
  /** How many sent transfers the indexer returned (newest first). */
  checkedTransfers: number;
  /** True when the indexer said there are no more (no pageKey): the whole sent history was searched. */
  complete: boolean;
}

/** One of the wallet's own EVM addresses, with the name shown for it. */
export interface OwnAddress {
  address: string;
  /** "Account 2", or "Account 1's smart account". */
  label: string;
}

/**
 * Every EVM address this wallet controls on one network, known WITHOUT a
 * network request: each account's EOA (hidden accounts included), plus
 * the smart-account addresses activity-sentences.ts walletAddressesFor
 * derives (the Kernel v3.3 counterfactual when Kernel is the chain's
 * account type, and a recovered account linked to the owner). SimpleAccount
 * addresses need a factory call and are not included. Used so the risk
 * card and the success screens treat a send between the wallet's own
 * accounts as such (finding 13 of the rehearsal), never as a first-time or
 * unknown counterparty.
 *
 * `extra` adds further own addresses already named by the caller — the
 * wallet's multi-signature accounts on this network ("Multisig 1 (2-of-3)",
 * multisig.ts ownMultisigAddresses), which are stored records rather than
 * accounts — after the accounts' own, skipping any address already listed.
 */
export function ownWalletAddresses(
  accounts: readonly { index: number; name: string; evmAddress: string | null }[],
  aa: AaAddressFacts | null,
  extra: readonly OwnAddress[] = [],
): OwnAddress[] {
  const out: OwnAddress[] = [];
  const seen = new Set<string>();
  for (const account of accounts) {
    if (!account.evmAddress || !ADDRESS.test(account.evmAddress)) continue;
    walletAddressesFor(account.evmAddress, account.index, aa).forEach((address, i) => {
      const key = address.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ address, label: i === 0 ? account.name : `${account.name}’s smart account` });
    });
  }
  for (const own of extra) {
    if (!ADDRESS.test(own.address)) continue;
    const key = own.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ address: own.address, label: own.label });
  }
  return out;
}

/** The own-address entry for `address` (case-insensitive), or null. */
export function findOwnAddress(address: string, own: readonly OwnAddress[]): OwnAddress | null {
  const lower = address.toLowerCase();
  return own.find((o) => o.address.toLowerCase() === lower) ?? null;
}

/** A staking contract the engine pins for one chain (see the file comment). */
export interface PinnedStakingContract {
  /** CAIP-2 id of the chain the address is pinned for. */
  chain: string;
  /** The address as the engine's table lists it (EIP-55). */
  address: string;
  protocol: 'Lido' | 'Rocket Pool';
  /** What the contract is: "stETH", "wstETH", "withdrawal queue", "rETH" or "deposit pool". */
  name: string;
  /**
   * Set only for Rocket Pool's deposit pool, which is not pinned: the pinned
   * RocketStorage address it was resolved from at this check
   * (resolvedRocketDepositPoolAt). Never set by pinnedStakingContracts.
   */
  resolvedFrom?: string;
}

/**
 * Every staking contract the card names, built from the engine's pinned
 * deployment tables (packages/chains-evm/src/staking.ts; addresses from
 * lidofinance/docs 140c583d and rocket-pool/smartnode 8c1dad70, checked
 * on-chain in phase 18 — docs/STAKING.md 4.1).
 */
export function pinnedStakingContracts(): PinnedStakingContract[] {
  const out: PinnedStakingContract[] = [];
  for (const d of Object.values(LIDO_DEPLOYMENTS)) {
    out.push({ chain: d.chain, address: d.stETH, protocol: 'Lido', name: 'stETH' });
    out.push({ chain: d.chain, address: d.wstETH, protocol: 'Lido', name: 'wstETH' });
    out.push({ chain: d.chain, address: d.withdrawalQueue, protocol: 'Lido', name: 'withdrawal queue' });
  }
  for (const d of Object.values(ROCKET_POOL_DEPLOYMENTS)) {
    out.push({ chain: d.chain, address: d.rETH, protocol: 'Rocket Pool', name: 'rETH' });
  }
  return out;
}

/**
 * The pinned staking contract at exactly `address` on `chainCaip2`, or
 * null. All 40 hex digits must match (case-insensitively) and the chain
 * must be the one the address is pinned for.
 */
export function stakingContractAt(chainCaip2: string, address: string): PinnedStakingContract | null {
  if (!ADDRESS.test(address)) return null;
  const lower = address.toLowerCase();
  return (
    pinnedStakingContracts().find((c) => c.chain === chainCaip2 && c.address.toLowerCase() === lower) ?? null
  );
}

/**
 * `tokens` plus the chain's known liquid-staking tokens (tokens.ts
 * KNOWN_STAKING_TOKENS) that are not already in it (compared by address,
 * case-insensitively), so a stETH, wstETH or rETH transfer is described by
 * its recipient and the first-interaction search covers them. The caller's
 * entries come first and win.
 */
export function withStakingTokens(tokens: readonly RiskTokenRef[], chainCaip2: string): RiskTokenRef[] {
  const seen = new Set(tokens.map((t) => t.address.toLowerCase()));
  const extra = knownStakingTokensForChain(chainCaip2)
    .map((t) => ({ address: t.assetId.reference, symbol: t.symbol }))
    .filter((t) => !seen.has(t.address.toLowerCase()));
  return [...tokens, ...extra];
}

/**
 * Rocket Pool's deposit pool at exactly `address` on `chainCaip2`, resolved
 * NOW from the pinned RocketStorage through `transport` (engine
 * resolveRocketPool: the registry's rocketDepositPool entry, with the
 * pinned-rETH and code checks), or null — no Rocket Pool deployment on this
 * chain, a malformed address, a failed or refused read, or a different
 * address. Never cached: each call reads the registry again.
 */
export async function resolvedRocketDepositPoolAt(
  transport: JsonRpcTransport,
  chainCaip2: string,
  address: string,
): Promise<PinnedStakingContract | null> {
  const deployment = rocketPoolDeploymentFor(chainCaip2);
  if (!deployment || !ADDRESS.test(address)) return null;
  let contracts: Awaited<ReturnType<typeof resolveRocketPool>>;
  try {
    contracts = await resolveRocketPool(transport, deployment);
  } catch {
    return null;
  }
  if (contracts.depositPool.toLowerCase() !== address.toLowerCase()) return null;
  return {
    chain: chainCaip2,
    address: contracts.depositPool,
    protocol: 'Rocket Pool',
    name: 'deposit pool',
    resolvedFrom: deployment.storage,
  };
}

/** A bridge contract the wallet pins for one chain (see the file comment). */
export interface PinnedBridgeContract {
  /** CAIP-2 id of the chain the address is pinned for. */
  chain: string;
  /** The address as the engine's table lists it (EIP-55). */
  address: string;
  /** Who runs it, for the card ("Circle"). */
  operator: 'Circle';
  /** What the contract is ("TokenMessengerV2"). */
  name: string;
}

/**
 * Every bridge contract the card names, on each test network the engine's
 * CCTP tables serve: Circle's TokenMessengerV2 (the spender of the approval
 * and the target of the burn) and Circle's MessageTransmitterV2 (the target
 * of the mint, pass p23-mint finding 2). Built from the engine's pinned
 * tables.
 */
export function pinnedBridgeContracts(): PinnedBridgeContract[] {
  return Object.keys(CCTP_V2_TESTNET_DOMAINS).flatMap((id) => [
    { chain: `eip155:${id}`, address: CCTP_V2_TESTNET.tokenMessengerV2, operator: 'Circle' as const, name: 'TokenMessengerV2' },
    { chain: `eip155:${id}`, address: CCTP_V2_TESTNET.messageTransmitterV2, operator: 'Circle' as const, name: 'MessageTransmitterV2' },
  ]);
}

/** The pinned bridge contract at exactly `address` on `chainCaip2`, or null (all 40 hex digits, that chain only). */
export function bridgeContractAt(chainCaip2: string, address: string): PinnedBridgeContract | null {
  if (!ADDRESS.test(address)) return null;
  const lower = address.toLowerCase();
  return pinnedBridgeContracts().find((c) => c.chain === chainCaip2 && c.address.toLowerCase() === lower) ?? null;
}

/**
 * An ENS contract the wallet pins on Ethereum Sepolia (pass p23-handle
 * finding 5): the ETHRegistrar, the VerifiableFactory and the ENSv1
 * ReverseRegistrar from the engine's ENS_V2_SEPOLIA table
 * (packages/chains-evm/src/ens-register.ts, contracts-v2 07e55a05, checked
 * on-chain on 2026-10-25), and the name owner's own resolver when the
 * caller passes that owner (GatherRiskOptions.ensResolverOwner).
 */
export interface PinnedEnsContract {
  /** CAIP-2 id of the chain the address is pinned for (Ethereum Sepolia). */
  chain: string;
  /** The address as the engine's table lists it, or as the factory derives it (EIP-55). */
  address: string;
  /** Who runs it, for the card ("ENS"). */
  operator: 'ENS';
  /** What the contract is: "ETHRegistrar", "VerifiableFactory", "ReverseRegistrar (ENSv1)", or "resolver" for the owner's own. */
  name: 'ETHRegistrar' | 'VerifiableFactory' | 'ReverseRegistrar (ENSv1)' | 'resolver';
  /** Set only for the owner's own resolver: the owner its address was derived for (EIP-55). */
  resolverOwner?: string;
}

/** The CAIP-2 id of the one network the ENS contracts are pinned on. */
const ENS_PINNED_CHAIN = `eip155:${ENS_V2_SEPOLIA.chainId.toString()}`;

/** Every ENS contract the card names from the engine's pinned table (not the owner's resolver, which is derived per owner). */
export function pinnedEnsContracts(): PinnedEnsContract[] {
  return [
    { chain: ENS_PINNED_CHAIN, address: ENS_V2_SEPOLIA.ethRegistrar, operator: 'ENS', name: 'ETHRegistrar' },
    { chain: ENS_PINNED_CHAIN, address: ENS_V2_SEPOLIA.verifiableFactory, operator: 'ENS', name: 'VerifiableFactory' },
    { chain: ENS_PINNED_CHAIN, address: ENS_V2_SEPOLIA.v1ReverseRegistrar, operator: 'ENS', name: 'ReverseRegistrar (ENSv1)' },
  ];
}

/**
 * The pinned ENS contract at exactly `address` on `chainCaip2` (all 40 hex
 * digits, that chain only), or — when `resolverOwner` is given — the
 * owner's own ENS resolver: the address ENS's pinned VerifiableFactory
 * derives for that owner (the engine's predictVerifiableProxyAddress with
 * ensOwnedResolverSalt, the derivation readEnsOwnedResolver uses). The
 * resolver address is computed here from the owner, never taken from the
 * caller. Null otherwise.
 */
export function ensContractAt(chainCaip2: string, address: string, resolverOwner: string | null = null): PinnedEnsContract | null {
  if (!ADDRESS.test(address) || chainCaip2 !== ENS_PINNED_CHAIN) return null;
  const lower = address.toLowerCase();
  const pinned = pinnedEnsContracts().find((c) => c.address.toLowerCase() === lower);
  if (pinned) return pinned;
  if (resolverOwner === null || !ADDRESS.test(resolverOwner)) return null;
  const predicted = predictVerifiableProxyAddress(resolverOwner, ensOwnedResolverSalt(resolverOwner));
  if (predicted.toLowerCase() !== lower) return null;
  return { chain: ENS_PINNED_CHAIN, address: predicted, operator: 'ENS', name: 'resolver', resolverOwner: checksum(resolverOwner) };
}

/** The card's one line for an ENS contract (RiskFacts.ensContract). */
export function ensContractText(contract: PinnedEnsContract): string {
  const network = evmProfileByCaip2(contract.chain)?.label ?? contract.chain;
  if (contract.name === 'resolver' && contract.resolverOwner) {
    return (
      `This transaction goes to your own ENS resolver on ${network} (${contract.address}): the address ENS’s pinned ` +
      `VerifiableFactory derives for the name’s owner ${contract.resolverOwner}.`
    );
  }
  return (
    `This transaction goes to ENS’s ${contract.name} on ${network} (${contract.address}), ` +
    'pinned by this wallet from ENS’s published Sepolia deployments.'
  );
}

/** A spender the card can name: a pinned bridge contract, or ENS's pinned ETHRegistrar (it takes the registration fee). */
export type PinnedSpender = PinnedBridgeContract | PinnedEnsContract;

/** The token whose approval names a pinned spender (RiskFacts.bridgeApproval). */
export interface PinnedSpenderApproval {
  token: RiskTokenRef;
  spender: PinnedSpender;
  /** The approved amount, from the calldata's second word. */
  amount: bigint;
}

/**
 * The approval the card may describe by its pinned SPENDER, or null. All of
 * these must hold, otherwise the card keeps describing the contract `to`:
 *  - the calldata is exactly approve(spender, amount) (selector plus two
 *    words, a clean address word);
 *  - the spender is Circle's TokenMessengerV2 as the wallet pins it on THIS
 *    chain (bridgeContractAt), or ENS's pinned ETHRegistrar;
 *  - `to` is one of `tokens` (tracked plus known on the active chain), or
 *    Circle's USDC that the CCTP table pins on this chain.
 * Whether `to` holds code is checked separately (gatherRiskFacts).
 */
export function pinnedSpenderApprovalTarget(
  to: string,
  data: Uint8Array | string | undefined,
  chainCaip2: string,
  tokens: readonly RiskTokenRef[],
): PinnedSpenderApproval | null {
  if (!ADDRESS.test(to)) return null;
  const hex = dataToHex(data);
  if (!/^0x[0-9a-f]*$/.test(hex) || hex.length !== 2 + 8 + 128 || hex.slice(0, 10) !== ERC20_APPROVE_SELECTOR_HEX) return null;
  const spenderAddress = wordToAddress(hex.slice(10, 74));
  if (!spenderAddress) return null;
  // A pinned bridge spender, or ENS's pinned ETHRegistrar (pass p23-handle
  // finding 5: the handle's exact approval and the zero approval that
  // removes it); no other ENS contract takes tokens.
  const ens = ensContractAt(chainCaip2, spenderAddress);
  // Of the bridge contracts only TokenMessengerV2 takes tokens (the burn);
  // MessageTransmitterV2 only receives the mint call (pass p23-mint).
  const bridge = bridgeContractAt(chainCaip2, spenderAddress);
  const spender: PinnedSpender | null = (bridge?.name === 'TokenMessengerV2' ? bridge : null) ?? (ens?.name === 'ETHRegistrar' ? ens : null);
  if (!spender) return null;
  const amount = BigInt('0x' + hex.slice(74));
  const lower = to.toLowerCase();
  const listed = tokens.find((t) => ADDRESS.test(t.address) && t.address.toLowerCase() === lower);
  if (listed) return { token: listed, spender, amount };
  const chainId = /^eip155:(\d+)$/.exec(chainCaip2)?.[1];
  const usdc = chainId !== undefined ? CCTP_V2_TESTNET_USDC[Number(chainId)] : undefined;
  if (usdc && usdc.toLowerCase() === lower) return { token: { address: usdc, symbol: 'USDC' }, spender, amount };
  return null;
}

/** The card's one line for a pinned bridge contract (RiskFacts.bridgeContract). */
export function bridgeContractText(contract: PinnedBridgeContract): string {
  const network = evmProfileByCaip2(contract.chain)?.label ?? contract.chain;
  return (
    `This transaction goes to ${contract.operator}’s ${contract.name} on ${network} (${contract.address}), ` +
    `pinned by this wallet from ${contract.operator}’s published test-network addresses.`
  );
}

/** Where the wallet took a pinned spender's address from, for the card. */
function pinnedSource(s: PinnedSpender): string {
  return s.operator === 'ENS' ? 'ENS’s published Sepolia deployments' : `${s.operator}’s published test-network addresses`;
}

/**
 * The card's one line for an approval whose spender is a pinned contract
 * (RiskFacts.bridgeApproval). An approval of exactly 0 (the handle screen's
 * "Remove the USDC approval", pass p23-handle finding 5) says that it
 * removes what the spender may take; any other amount keeps the bridge
 * wording unchanged.
 */
export function bridgeApprovalText(approval: { contract: string; symbol: string; spender: PinnedSpender; amount?: bigint }): string {
  const s = approval.spender;
  const network = evmProfileByCaip2(s.chain)?.label ?? s.chain;
  if (approval.amount === 0n) {
    return (
      `This sets to 0 what ${s.operator}’s ${s.name} on ${network} (${s.address}), pinned by this wallet from ` +
      `${pinnedSource(s)}, may take in ${approval.symbol} from this account through its token contract ${approval.contract}.`
    );
  }
  return (
    `This approves ${s.operator}’s ${s.name} on ${network} (${s.address}), pinned by this wallet from ` +
    `${pinnedSource(s)}, to take ${approval.symbol} from this account through its ` +
    `token contract ${approval.contract}.`
  );
}

/** The card's one line for a pinned staking contract (RiskFacts.stakingContract). */
export function stakingContractText(contract: PinnedStakingContract): string {
  const network = evmProfileByCaip2(contract.chain)?.label ?? contract.chain;
  if (contract.resolvedFrom) {
    return (
      `This transaction goes to ${contract.protocol}'s ${contract.name} (${contract.address}), resolved just now ` +
      `from ${contract.protocol}'s pinned RocketStorage contract on ${network}.`
    );
  }
  return (
    `This transaction goes to ${contract.protocol}'s ${contract.name} contract on ${network} ` +
    `(${contract.address}), pinned by this wallet from ${contract.protocol}'s published list of ` +
    'deployed contracts.'
  );
}

export interface RiskFacts {
  /** The transaction's `to` (what classification and age describe, unless tokenTransfer is set). */
  to: string;
  /**
   * Set when the transaction is a plain transfer of a token the wallet
   * tracks or knows on this chain, to `recipient`, and `contract` was seen
   * to hold code (tokenTransferTarget). Then recipientClass, contractAge,
   * contractAgeUnknown and expectedOwnDelegation describe the RECIPIENT,
   * not the token contract.
   */
  tokenTransfer?: { contract: string; symbol: string; recipient: string };
  /**
   * Set when `to` is a staking contract the wallet pins for this chain
   * (stakingContractAt) and was seen to hold code. Then no contract-age or
   * first-interaction check runs for it, and the card names it.
   */
  stakingContract?: PinnedStakingContract;
  /**
   * Set when `to` is a bridge contract the wallet pins for this chain
   * (bridgeContractAt) and was seen to hold code: the card names it, with
   * no contract-age or first-interaction check.
   */
  bridgeContract?: PinnedBridgeContract;
  /**
   * Set when the transaction approves a pinned bridge contract on a token
   * the wallet tracks, knows or pins on this chain, and the token was seen
   * to hold code (pinnedSpenderApprovalTarget): the card describes the
   * spender, with no contract-age or first-interaction check.
   */
  bridgeApproval?: { contract: string; symbol: string; spender: PinnedSpender; amount?: bigint };
  /**
   * Set when `to` is an ENS contract the wallet pins on this chain, or the
   * name owner's own resolver (ensContractAt), and was seen to hold code:
   * the card names it, with no contract-age or first-interaction check.
   */
  ensContract?: PinnedEnsContract;
  /** Set when `to` is one of the wallet's own addresses (no age or first-interaction checks then). */
  ownRecipient?: OwnAddress;
  /** Set when the paid party differs from `to` and is one of the wallet's own addresses. */
  ownCounterparty?: OwnAddress;
  /** classifyRecipient result for `to`; absent when the lookup failed or was skipped. */
  recipientClass?: RecipientClass;
  /** True when an endpoint was available, so classification was attempted. */
  classifyAttempted?: boolean;
  /** Whether the transaction carries non-empty calldata. */
  hasCalldata: boolean;
  /** Approval/transfer changes (preview or calldata-derived). */
  assetChanges?: AssetChange[];
  /** isFirstInteraction result for the counterparty; absent when not searched or failed. */
  firstInteraction?: FirstInteractionResult;
  /** Symbols of the tokens the first-interaction search covered (tracked + known). */
  firstInteractionTokens?: string[];
  /**
   * Whether a first-interaction line applies at all: false for a send to the
   * wallet itself and when no endpoint was available (calldata-only checks).
   */
  firstInteractionApplicable?: boolean;
  /** Why the token-log search did not produce a result. */
  tokenSearch?: 'searched' | 'no-tokens' | 'failed';
  /** The native-ETH search through the history indexer. */
  nativeInteraction?: NativeInteractionResult;
  /** Why the native search did not produce a result. */
  nativeSearch?: 'searched' | 'no-indexer' | 'failed';
  /** The chain the facts were gathered on (durations use its block time). */
  chainCaip2?: string;
  /**
   * Deployment search result with the chain threshold, when the age could
   * be established: from the full threshold-deep search, or from a shallow
   * probe that found the deployment inside the depth the endpoint serves.
   */
  contractAge?: { result: DeploymentSearchResult; thresholdBlocks: bigint };
  /**
   * Set when the recipient is a contract but its age could not be
   * established against the threshold. `atLeastBlocks`: the contract
   * already had code at the deepest block the endpoint served.
   */
  contractAgeUnknown?: { atLeastBlocks?: bigint };
  /**
   * True when `to` is one of the wallet's OWN accounts delegated (EIP-7702)
   * to the wallet's pinned Kernel v3.3 delegate — the expected result of
   * "Upgrade this account", so the delegated-eoa signal is not raised. It
   * stays for every other address and for a foreign delegate on an own
   * account (see isExpectedOwnDelegation).
   */
  expectedOwnDelegation?: boolean;
}

/**
 * True only when `to` is the sending wallet or another of the wallet's own
 * EVM addresses AND its delegation indicator names exactly the pinned
 * Kernel v3.3 delegate (./delegation.ts WALLET_7702_DELEGATE).
 */
export function isExpectedOwnDelegation(
  to: string,
  recipientClass: RecipientClass | undefined,
  ownAddresses: readonly string[],
): boolean {
  if (recipientClass?.kind !== 'delegated-eoa') return false;
  if (recipientClass.delegate.toLowerCase() !== WALLET_7702_DELEGATE.toLowerCase()) return false;
  const lower = to.toLowerCase();
  return ownAddresses.some((a) => a.toLowerCase() === lower);
}

export type RiskTone = 'warning' | 'notice';

/**
 * Line types: the engine's signal types plus the app's own lines —
 * 'recipient-class' (what `to` is), 'contract-age-unknown' (age could not
 * be established) and 'first-interaction-unchecked' (no search could run).
 */
export type RiskLineType =
  | RiskSignalType
  | 'recipient-class'
  | 'contract-age-unknown'
  | 'first-interaction-unchecked';

export interface RiskLine {
  type: RiskLineType;
  tone: RiskTone;
  text: string;
  /** Address the line is about, when the engine named one. */
  subject?: string;
}

/**
 * "about 10 days" / "about 33 hours" / "about 13 minutes" for a block count
 * (approximate by design), at the chain's block time.
 */
export function approxDuration(blocks: bigint, chainCaip2?: string): string {
  const perBlock = chainCaip2 !== undefined ? secondsPerBlockFor(chainCaip2) : SECONDS_PER_BLOCK_ESTIMATE;
  const seconds = Number(blocks) * perBlock;
  const hours = seconds / 3600;
  if (hours < 1) {
    const m = Math.max(1, Math.round(seconds / 60));
    return `about ${m} minute${m === 1 ? '' : 's'}`;
  }
  if (hours < 48) {
    const h = Math.max(1, Math.round(hours));
    return `about ${h} hour${h === 1 ? '' : 's'}`;
  }
  return `about ${Math.round(hours / 24)} days`;
}

/** The searched-range sentence appended to the first-interaction notice. */
export function firstInteractionScope(
  result: FirstInteractionResult,
  symbols: string[],
  chainCaip2?: string,
): string {
  const blocks = result.scannedToBlock - result.scannedFromBlock + 1n;
  const what = symbols.length > 0 ? `${symbols.join(', ')} transfers` : 'token transfers';
  return (
    `Searched: ${what} in blocks ${result.scannedFromBlock}–${result.scannedToBlock} ` +
    `(the last ${groupThousands(blocks.toString())} blocks, ${approxDuration(blocks, chainCaip2)}).`
  );
}

/** The searched-range sentence for the native-ETH search through the history indexer. */
export function nativeInteractionScope(result: NativeInteractionResult): string {
  return result.complete
    ? 'Searched: every ETH transfer you sent, through your history indexer.'
    : `Searched: your latest ${groupThousands(String(result.checkedTransfers))} ETH transfers sent, ` +
        'through your history indexer (older ones were not searched).';
}

/** The first-interaction notice when a search ran and found nothing. */
export const FIRST_INTERACTION_NONE_FOUND =
  'No earlier transfers from you to this address were found. This may be your first time sending ' +
  'to it, so double-check every character of the address.';

/** The recipient-class sentence (always shown when the class is known). */
export function recipientClassText(to: string, recipientClass: RecipientClass, ownUpgraded: boolean): string {
  if (recipientClass.kind === 'contract') return `This transaction goes to a contract (${to}).`;
  if (recipientClass.kind === 'eoa') {
    return `This transaction goes to a regular account with no contract code on this network (${to}).`;
  }
  return ownUpgraded
    ? `This transaction goes to one of your own accounts, upgraded to this wallet's Kernel v3.3 delegate (${to}).`
    : `This transaction goes to a regular account that runs delegated contract code (${to}).`;
}

/** The calm line for a send to one of the wallet's own addresses. */
export function ownAccountText(own: OwnAddress): string {
  return `This transaction goes to one of your own accounts in this wallet: ${own.label} (${own.address}).`;
}

/**
 * The opening line for a transfer of a tracked or known token
 * (RiskFacts.tokenTransfer): what is sent, through which contract (in
 * full), and to whom — the recipient described like the `to` of a plain
 * ETH send.
 */
export function tokenTransferText(facts: RiskFacts & { tokenTransfer: NonNullable<RiskFacts['tokenTransfer']> }): string {
  const { contract, symbol, recipient } = facts.tokenTransfer;
  const prefix = `This sends ${symbol} through its token contract ${contract}`;
  if (facts.ownCounterparty) {
    return `${prefix} to one of your own accounts in this wallet: ${facts.ownCounterparty.label} (${facts.ownCounterparty.address}).`;
  }
  const cls = facts.recipientClass;
  if (!cls) {
    return `${prefix} to ${recipient}. Whether ${recipient} is a contract or a regular account could not be checked on this endpoint.`;
  }
  if (cls.kind === 'contract') return `${prefix} to a contract (${recipient}).`;
  if (cls.kind === 'eoa') return `${prefix} to a regular account with no contract code on this network (${recipient}).`;
  // A delegated recipient: the engine's delegated-eoa notice explains the
  // code, unless it is one of the wallet's own upgraded accounts.
  return facts.expectedOwnDelegation
    ? `${prefix} to one of your own accounts, upgraded to this wallet's Kernel v3.3 delegate (${recipient}).`
    : `${prefix} to ${recipient}.`;
}

function firstInteractionLine(facts: RiskFacts): RiskLine | null {
  if (!facts.firstInteractionApplicable) return null;
  if (facts.firstInteraction?.known || facts.nativeInteraction?.known) return null;
  const tokensSearched = facts.firstInteraction !== undefined;
  const nativeSearched = facts.nativeInteraction !== undefined;
  if (!tokensSearched && !nativeSearched) {
    const why: string[] = [];
    if (facts.tokenSearch === 'no-tokens') why.push('there are no tracked or known tokens on this network to search');
    if (facts.tokenSearch === 'failed') why.push('the endpoint refused the token-transfer search');
    if (facts.nativeSearch === 'no-indexer') {
      why.push('plain ETH transfers need a history indexer (Settings → Ethereum history indexer)');
    }
    if (facts.nativeSearch === 'failed') why.push('the history indexer did not answer');
    return {
      type: 'first-interaction-unchecked',
      tone: 'notice',
      text:
        'Whether you have sent to this address before could not be checked' +
        (why.length > 0 ? `: ${why.join('; ')}` : '') +
        '. Double-check every character of the address.',
    };
  }
  const parts = [FIRST_INTERACTION_NONE_FOUND];
  if (facts.firstInteraction) {
    parts.push(firstInteractionScope(facts.firstInteraction, facts.firstInteractionTokens ?? [], facts.chainCaip2));
  } else if (facts.tokenSearch === 'failed') {
    parts.push('Token transfers could not be searched: the endpoint refused the search.');
  }
  if (facts.nativeInteraction) {
    parts.push(nativeInteractionScope(facts.nativeInteraction));
  } else if (facts.nativeSearch === 'failed') {
    parts.push('ETH transfers could not be searched: the history indexer did not answer.');
  } else {
    parts.push('(Plain ETH transfers cannot be checked without a history indexer.)');
  }
  return { type: 'first-interaction-unknown', tone: 'notice', text: parts.join(' ') };
}

/**
 * Pure: runs the engine's riskSignals over the gathered facts and returns
 * display lines, warnings first (engine order kept within each tone). The
 * engine's own plain-language messages are used verbatim, except the
 * first-interaction notice, which the app writes itself because it also
 * covers the native-ETH search and the could-not-check case. App lines:
 * the recipient class (whenever it is known, unless the no-code-with-
 * calldata warning or the delegated-account notice already says it), the
 * neutral contract-age line, and the could-not-check first-interaction
 * line. Returns [] only when no endpoint was available and no approval
 * was decoded.
 */
export function computeRiskLines(facts: RiskFacts): RiskLine[] {
  const transfer = facts.tokenTransfer;
  // What the class and age facts describe: the recipient of a tracked or
  // known token's transfer, else the transaction's `to`.
  const subject = transfer ? transfer.recipient : facts.to;
  const signals = riskSignals({
    ...(facts.recipientClass ? { recipient: { address: subject, class: facts.recipientClass } } : {}),
    // The recipient of a token transfer is not called (the call goes to the
    // token contract, which was seen to hold code), so "instructions to an
    // address with no code" cannot apply to it.
    hasCalldata: transfer ? false : facts.hasCalldata,
    ...(facts.assetChanges ? { assetChanges: facts.assetChanges } : {}),
    // Age only means something for ordinary contracts; riskSignals also
    // ignores it for other classes, this keeps the input honest.
    ...(facts.contractAge && facts.recipientClass?.kind === 'contract'
      ? { contractAge: facts.contractAge }
      : {}),
  });
  const kept = facts.expectedOwnDelegation
    ? signals.filter((s) => s.type !== 'delegated-eoa')
    : signals;
  const lines: RiskLine[] = kept.map((s) => ({
    type: s.type,
    tone: s.severity,
    text: s.message,
    ...(s.subject ? { subject: s.subject } : {}),
  }));

  if (transfer) {
    // One line describing the transfer in terms of its recipient (own
    // account, class, or "could not be checked"); nothing about the token
    // contract's own class or age.
    lines.push({
      type: 'recipient-class',
      tone: 'notice',
      text: tokenTransferText({ ...facts, tokenTransfer: transfer }),
      subject,
    });
  } else if (facts.stakingContract) {
    // A pinned staking contract on this chain: one line naming it, nothing
    // about its class or age (see the file comment).
    lines.push({
      type: 'recipient-class',
      tone: 'notice',
      text: stakingContractText(facts.stakingContract),
      subject: facts.to,
    });
  } else if (facts.bridgeContract) {
    // A pinned bridge contract on this chain (Circle's TokenMessengerV2 or MessageTransmitterV2).
    lines.push({
      type: 'recipient-class',
      tone: 'notice',
      text: bridgeContractText(facts.bridgeContract),
      subject: facts.to,
    });
  } else if (facts.ensContract) {
    // A pinned ENS contract, or the name owner's own resolver (pass p23-handle finding 5).
    lines.push({
      type: 'recipient-class',
      tone: 'notice',
      text: ensContractText(facts.ensContract),
      subject: facts.to,
    });
  } else if (facts.bridgeApproval) {
    // An approval for a pinned bridge spender: about the spender, not the token contract.
    lines.push({
      type: 'recipient-class',
      tone: 'notice',
      text: bridgeApprovalText(facts.bridgeApproval),
      subject: facts.bridgeApproval.spender.address,
    });
  } else if (facts.ownRecipient && !facts.expectedOwnDelegation) {
    // A send between the wallet's own accounts: one calm line, whatever the
    // address's code (an own smart account is a contract, possibly a new one).
    lines.push({
      type: 'recipient-class',
      tone: 'notice',
      text: ownAccountText(facts.ownRecipient),
      subject: facts.to,
    });
  } else if (facts.recipientClass) {
    const saidByEngine = lines.some(
      (l) => l.type === 'no-code-recipient-with-calldata' || l.type === 'delegated-eoa',
    );
    if (!saidByEngine) {
      lines.push({
        type: 'recipient-class',
        tone: 'notice',
        text: recipientClassText(facts.to, facts.recipientClass, facts.expectedOwnDelegation === true),
        subject: facts.to,
      });
    }
  } else if (facts.classifyAttempted) {
    lines.push({
      type: 'recipient-class',
      tone: 'notice',
      text: `Whether ${facts.to} is a contract or a regular account could not be checked on this endpoint.`,
      subject: facts.to,
    });
  }

  if (facts.recipientClass?.kind === 'contract' && facts.contractAgeUnknown) {
    const atLeast = facts.contractAgeUnknown.atLeastBlocks;
    lines.push({
      type: 'contract-age-unknown',
      tone: 'notice',
      text:
        atLeast !== undefined
          ? `${CONTRACT_AGE_UNKNOWN_LINE} It has had code for at least the last ` +
            `${groupThousands(atLeast.toString())} blocks (${approxDuration(atLeast, facts.chainCaip2)}), ` +
            'the oldest state this endpoint serves.'
          : CONTRACT_AGE_UNKNOWN_LINE,
      subject,
    });
  }

  // (A token transfer's opening line already names an own recipient.)
  if (facts.ownCounterparty && !transfer) {
    lines.push({
      type: 'recipient-class',
      tone: 'notice',
      text: `The recipient is ${ownAccountText(facts.ownCounterparty).replace(/^This transaction goes to /, '')}`,
      subject: facts.ownCounterparty.address,
    });
  }

  const first = firstInteractionLine(facts);
  if (first) lines.push(first);

  return [
    ...lines.filter((l) => l.tone === 'warning'),
    ...lines.filter((l) => l.tone === 'notice'),
  ];
}

// ---------------------------------------------------------------------------
// Gathering facts over the network (never throws)
// ---------------------------------------------------------------------------

export interface RiskTokenRef {
  /** ERC-20 contract on the ACTIVE chain. */
  address: string;
  symbol: string;
}

export interface GatherRiskOptions {
  /** The active chain's RPC endpoint; null = no network checks (calldata-only). */
  url: string | null;
  /** The sending address (EOA, or the smart account on the AA path). */
  wallet: string;
  /** The transaction's `to`. */
  to: string;
  /**
   * The party the user is paying, when it differs from `to` (for example the
   * recipient inside an ERC-20 transfer, where `to` is the token contract).
   * Used for the first-interaction search. Defaults to `to`.
   */
  counterparty?: string;
  data?: Uint8Array | string;
  /**
   * Changes from the balance-change preview. undefined or null: decode
   * direct approvals from the calldata instead.
   */
  assetChanges?: AssetChange[] | null;
  /** The ACTIVE chain's CAIP-2 id (thresholds are per chain). */
  chainCaip2: string;
  /**
   * ERC-20 tokens on the ACTIVE chain to search for earlier transfers: the
   * tracked tokens plus the known test-network tokens (approvals.ts
   * approvalTokensForChain). Also the only contracts whose transfer the card
   * describes in terms of the recipient (tokenTransferTarget), so callers
   * must pass the active chain's tokens and nothing else. The chain's known
   * liquid-staking tokens (tokens.ts knownStakingTokensForChain: stETH,
   * wstETH, rETH where the wallet offers staking) are added here, once each.
   */
  trackedTokens: RiskTokenRef[];
  /** Injectable for scripts; defaults to simulationTransport(url). */
  transport?: JsonRpcTransport;
  /**
   * The active chain's history indexer URL (indexer.ts; serves
   * alchemy_getAssetTransfers), or null/undefined when none is configured.
   * Used only for the native-ETH first-interaction search.
   */
  indexerUrl?: string | null;
  /** Injectable for scripts; defaults to simulationTransport(indexerUrl). */
  indexerTransport?: JsonRpcTransport;
  /**
   * The wallet's other own EVM addresses (the sending `wallet` always
   * counts). A recipient among them that is delegated to the wallet's
   * pinned Kernel delegate raises no delegated-eoa signal.
   */
  ownAddresses?: readonly string[];
  /**
   * The wallet's own addresses with names (ownWalletAddresses). A `to` or
   * counterparty among them is described as the user's own account, and no
   * first-interaction or contract-age check runs for it.
   */
  ownAccounts?: readonly OwnAddress[];
  /**
   * Loads the wallet's own multi-signature accounts on `chainCaip2`, which
   * are added to ownAccounts (finding 8 of the 2026-10-10 multisig emulator
   * pass: a send to the wallet's own counterfactual multisig read as "a
   * regular account with no contract code" and "first time sending").
   * Omitted: the stored records (multisig.ts ownMultisigAddresses); null:
   * none (scripts). A failed load adds none.
   */
  loadOwnMultisigs?: ((chainCaip2: string) => Promise<readonly OwnAddress[]>) | null;
  /**
   * The owner of the ENS name a handle step is for (the handle screen,
   * pass p23-handle finding 5): a `to` equal to the resolver ENS's pinned
   * VerifiableFactory derives for this owner is named as the owner's own
   * resolver (ensContractAt computes the address; the caller passes only
   * the owner). Omitted or null: no resolver is named.
   */
  ensResolverOwner?: string | null;
}

async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

const QUANTITY_HEX = /^0x[0-9a-fA-F]+$/;

/**
 * Contract age, honest about endpoint depth. First the full search from
 * (head − threshold) to head. When the endpoint refuses that (historical
 * state pruned), the deepest depth in CONTRACT_AGE_PROBE_DEPTHS at which
 * eth_getCode answers is found and the search runs inside it:
 *  - deployment found inside that depth → a real age (younger than the
 *    threshold, so the engine raises "new contract");
 *  - code already present at that depth → "at least N blocks old", which
 *    cannot be compared with the threshold → neutral line;
 *  - nothing answered, or the search failed half-way (load-balanced
 *    endpoints whose backends keep different history) → neutral line.
 * Never a guessed age.
 */
async function contractAgeFacts(
  transport: JsonRpcTransport,
  address: string,
  threshold: bigint,
): Promise<Pick<RiskFacts, 'contractAge' | 'contractAgeUnknown'>> {
  const headRaw = await attempt(() => transport('eth_blockNumber', []));
  if (typeof headRaw !== 'string' || !QUANTITY_HEX.test(headRaw)) return { contractAgeUnknown: {} };
  const head = BigInt(headRaw);
  const full = await attempt(() =>
    findCodeDeploymentBlock(transport, address, { fromBlock: head > threshold ? head - threshold : 0n, toBlock: head }),
  );
  if (full) return { contractAge: { result: full, thresholdBlocks: threshold } };
  if (full === null) return { contractAgeUnknown: {} }; // no code at head after all: say nothing definite
  for (const depth of CONTRACT_AGE_PROBE_DEPTHS) {
    if (depth >= threshold || depth > head) continue;
    const from = head - depth;
    const served = await attempt(() => transport('eth_getCode', [address, '0x' + from.toString(16)]));
    if (typeof served !== 'string') continue;
    const shallow = await attempt(() => findCodeDeploymentBlock(transport, address, { fromBlock: from, toBlock: head }));
    if (!shallow) return { contractAgeUnknown: {} };
    if (shallow.atOrBefore) return { contractAgeUnknown: { atLeastBlocks: shallow.ageBlocks } };
    return { contractAge: { result: shallow, thresholdBlocks: threshold } };
  }
  return { contractAgeUnknown: {} };
}

/**
 * Native-ETH first-interaction search through the history indexer: one
 * alchemy_getAssetTransfers query for transfers SENT by the wallet
 * (fromAddress; the same documented parameters as the engine's
 * indexer-history.ts provider), newest first, up to
 * NATIVE_INTERACTION_MAX_COUNT entries, matched against the counterparty
 * on the client. The documentation does not say whether fromAddress and
 * toAddress may be combined in one query (re-read 2026-10-03), so the
 * wallet does not rely on it. Throws on a malformed answer.
 */
export async function searchNativeInteraction(
  transport: JsonRpcTransport,
  wallet: string,
  counterparty: string,
): Promise<NativeInteractionResult> {
  const result = (await transport('alchemy_getAssetTransfers', [
    {
      fromBlock: '0x0',
      toBlock: 'latest',
      fromAddress: wallet,
      category: ['external', 'internal'],
      excludeZeroValue: false,
      maxCount: '0x' + NATIVE_INTERACTION_MAX_COUNT.toString(16),
      order: 'desc',
    },
  ])) as { transfers?: unknown; pageKey?: unknown } | null;
  if (!result || !Array.isArray(result.transfers)) {
    throw new Error('The history indexer returned no transfers array');
  }
  const me = wallet.toLowerCase();
  const target = counterparty.toLowerCase();
  const known = result.transfers.some((t) => {
    const transfer = t as { from?: unknown; to?: unknown };
    return (
      typeof transfer.from === 'string' &&
      transfer.from.toLowerCase() === me &&
      typeof transfer.to === 'string' &&
      transfer.to.toLowerCase() === target
    );
  });
  return {
    known,
    checkedTransfers: result.transfers.length,
    complete: !(typeof result.pageKey === 'string' && result.pageKey !== ''),
  };
}

/**
 * Collects every fact it can and returns them; each network check is
 * independent. A failed check is never turned into a warning: it is
 * recorded so the screen can say plainly what could not be checked
 * (recipient class, contract age, first interaction), never a guessed value.
 */
export async function gatherRiskFacts(options: GatherRiskOptions): Promise<RiskFacts> {
  const hasCalldata = dataToHex(options.data).length > 2;
  const assetChanges =
    options.assetChanges ?? approvalChangesFromCalldata(options.to, options.wallet, options.data);
  const facts: RiskFacts = { to: options.to, hasCalldata, assetChanges, chainCaip2: options.chainCaip2 };
  if (!ADDRESS.test(options.to) || !ADDRESS.test(options.wallet)) return facts;
  // The wallet's own multisig accounts on this chain (stored records, not
  // accounts, so the caller's ownAccounts may not list them).
  const loadMultisigs = options.loadOwnMultisigs === undefined ? ownMultisigAddresses : options.loadOwnMultisigs;
  let multisigs: readonly OwnAddress[] = [];
  if (loadMultisigs) {
    try {
      multisigs = await loadMultisigs(options.chainCaip2);
    } catch {
      multisigs = [];
    }
  }
  // The sending address always counts as the wallet's own.
  const listed = options.ownAccounts ?? [];
  const own: OwnAddress[] = [
    ...listed,
    ...multisigs.filter((m) => ADDRESS.test(m.address) && !findOwnAddress(m.address, listed)),
    { address: options.wallet, label: 'the sending account itself' },
  ];
  const ownTo = findOwnAddress(options.to, own);
  if (ownTo) facts.ownRecipient = ownTo;
  const transport =
    options.transport ?? (options.url ? simulationTransport(options.url) : null);
  if (!transport) return facts;
  facts.classifyAttempted = true;

  const counterparty =
    options.counterparty && ADDRESS.test(options.counterparty) ? options.counterparty : options.to;
  const tokens = withStakingTokens(options.trackedTokens, options.chainCaip2).filter((t) => ADDRESS.test(t.address));
  const threshold = newContractThresholdBlocks(options.chainCaip2);
  const indexerTransport =
    options.indexerTransport ?? (options.indexerUrl ? simulationTransport(options.indexerUrl) : null);

  // A transfer of a tracked or known token on this chain (see
  // tokenTransferTarget); confirmed below only if `to` holds code.
  const tokenRef = facts.ownRecipient
    ? null
    : tokenTransferTarget(options.to, options.counterparty, options.data, tokens);
  // A staking contract the wallet pins for this chain (not a token transfer
  // through it, which tokenRef describes); confirmed below only if `to`
  // holds code.
  let stakingRef = facts.ownRecipient || tokenRef ? null : stakingContractAt(options.chainCaip2, options.to);
  // Rocket Pool's deposit pool is resolved, not pinned: read the registry
  // again now (only on a chain with a Rocket Pool deployment).
  if (!stakingRef && !facts.ownRecipient && !tokenRef && rocketPoolDeploymentFor(options.chainCaip2)) {
    stakingRef = await resolvedRocketDepositPoolAt(transport, options.chainCaip2, options.to);
  }

  // A pinned bridge contract (the burn's target), or an approval whose
  // spender is one (the step before the burn); each confirmed below only if
  // `to` holds code.
  const bridgeRef = facts.ownRecipient || tokenRef || stakingRef ? null : bridgeContractAt(options.chainCaip2, options.to);
  // A pinned ENS contract or the name owner's own resolver (pass p23-handle
  // finding 5); confirmed below only if `to` holds code.
  const ensRef =
    facts.ownRecipient || tokenRef || stakingRef || bridgeRef ? null : ensContractAt(options.chainCaip2, options.to, options.ensResolverOwner ?? null);
  const bridgeApprovalRef =
    facts.ownRecipient || tokenRef || stakingRef || bridgeRef || ensRef ? null : pinnedSpenderApprovalTarget(options.to, options.data, options.chainCaip2, tokens);

  // Class, delegation and age of `address`, recorded as the card's subject.
  const describeSubject = async (address: string, known?: RecipientClass) => {
    const recipientClass = known ?? (await attempt(() => classifyRecipient(transport, address)));
    if (!recipientClass) return;
    facts.recipientClass = recipientClass;
    if (isExpectedOwnDelegation(address, recipientClass, [options.wallet, ...(options.ownAddresses ?? [])])) {
      facts.expectedOwnDelegation = true;
    }
    // No age check for the wallet's own smart account: a freshly deployed
    // own account is not a "new contract" risk.
    if (recipientClass.kind !== 'contract' || threshold === undefined || facts.ownRecipient) return;
    Object.assign(facts, await contractAgeFacts(transport, address, threshold));
  };

  const classifyTask = async () => {
    const toClass = await attempt(() => classifyRecipient(transport, options.to));
    if (!toClass) return;
    if (tokenRef && toClass.kind === 'contract') {
      facts.tokenTransfer = {
        contract: checksum(options.to),
        symbol: sanitizeSymbol(tokenRef.symbol) ?? 'the token',
        recipient: checksum(counterparty),
      };
      // An own recipient is named in the opening line; it needs no class
      // or age check (the same rule as a send to an own `to`).
      if (facts.ownCounterparty) return;
      await describeSubject(counterparty);
      return;
    }
    if (stakingRef && toClass.kind === 'contract') {
      // Named by the card; no age check for a pinned contract.
      facts.recipientClass = toClass;
      facts.stakingContract = stakingRef;
      return;
    }
    if (bridgeRef && toClass.kind === 'contract') {
      facts.recipientClass = toClass;
      facts.bridgeContract = bridgeRef;
      return;
    }
    if (ensRef && toClass.kind === 'contract') {
      facts.recipientClass = toClass;
      facts.ensContract = ensRef;
      return;
    }
    if (bridgeApprovalRef && toClass.kind === 'contract') {
      facts.recipientClass = toClass;
      facts.bridgeApproval = {
        contract: checksum(options.to),
        symbol: sanitizeSymbol(bridgeApprovalRef.token.symbol) ?? 'the token',
        spender: bridgeApprovalRef.spender,
        amount: bridgeApprovalRef.amount,
      };
      return;
    }
    await describeSubject(options.to, toClass);
  };

  const tokenSearchTask = async () => {
    // Without tokens there is nothing the free endpoints will search
    // (they refuse log filters without a contract address).
    if (tokens.length === 0) {
      facts.tokenSearch = 'no-tokens';
      return;
    }
    const run = (lookbackBlocks: bigint) =>
      isFirstInteraction(transport, options.wallet, counterparty, {
        lookbackBlocks,
        windowBlocks: RISK_LOG_WINDOW_BLOCKS,
        tokens: tokens.map((t) => t.address),
      });
    const result =
      (await attempt(() => run(FIRST_INTERACTION_LOOKBACK_BLOCKS))) ??
      (await attempt(() => run(FIRST_INTERACTION_FALLBACK_BLOCKS)));
    if (result) {
      facts.firstInteraction = result;
      facts.firstInteractionTokens = tokens.map((t) => t.symbol);
      facts.tokenSearch = 'searched';
    } else {
      facts.tokenSearch = 'failed';
    }
  };

  const nativeSearchTask = async () => {
    if (!indexerTransport) {
      facts.nativeSearch = 'no-indexer';
      return;
    }
    const result = await attempt(() => searchNativeInteraction(indexerTransport, options.wallet, counterparty));
    if (result) {
      facts.nativeInteraction = result;
      facts.nativeSearch = 'searched';
    } else {
      facts.nativeSearch = 'failed';
    }
  };

  const ownParty = findOwnAddress(counterparty, own);
  if (ownParty && counterparty.toLowerCase() !== options.to.toLowerCase()) facts.ownCounterparty = ownParty;
  // A send to the wallet itself or to another of its own addresses is never
  // a first interaction worth a warning (finding 13), so no search runs.
  const selfSend = ownParty !== null;
  facts.firstInteractionApplicable = !selfSend;
  if ((stakingRef || bridgeRef || ensRef || bridgeApprovalRef) && !selfSend && counterparty.toLowerCase() === options.to.toLowerCase()) {
    // The paid party is the pinned staking or bridge contract itself (or the
    // token whose approval names a pinned bridge spender): when its code is
    // confirmed, "have you sent here before" adds nothing, so no search
    // runs; otherwise the searches run as for any other address.
    await classifyTask();
    if (facts.stakingContract || facts.bridgeContract || facts.ensContract || facts.bridgeApproval) {
      facts.firstInteractionApplicable = false;
      return facts;
    }
    await Promise.all([tokenSearchTask(), nativeSearchTask()]);
    return facts;
  }
  await Promise.all([
    classifyTask(),
    ...(selfSend ? [] : [tokenSearchTask(), nativeSearchTask()]),
  ]);
  return facts;
}

// ---------------------------------------------------------------------------
// Address tags (approvals manager)
// ---------------------------------------------------------------------------

export type AddressTag = 'contract' | 'EOA' | 'delegated EOA';

/** Display tag for a classifyRecipient result. */
export function recipientTag(recipientClass: RecipientClass): AddressTag {
  if (recipientClass.kind === 'contract') return 'contract';
  if (recipientClass.kind === 'delegated-eoa') return 'delegated EOA';
  return 'EOA';
}

/**
 * Classifies several addresses (sequentially, to stay inside public-endpoint
 * rate limits). Keyed by lowercase address; null when the lookup failed —
 * the UI then shows no tag rather than a guessed one.
 */
export async function classifyAddresses(
  transport: JsonRpcTransport,
  addresses: string[],
): Promise<Record<string, AddressTag | null>> {
  const out: Record<string, AddressTag | null> = {};
  for (const address of addresses) {
    const key = address.toLowerCase();
    if (key in out) continue;
    const recipientClass = await attempt(() => classifyRecipient(transport, address));
    out[key] = recipientClass ? recipientTag(recipientClass) : null;
  }
  return out;
}
