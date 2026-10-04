import type { DerivedAccount } from '@shiba-wallet/core';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import {
  KERNEL_V3_3_7702_DELEGATE,
  NodeClient,
  ZERO_ADDRESS,
  decodeUint256,
  encodeFunctionCall,
  httpTransport,
  minimalBytes,
  rlpEncode,
  readDelegationStatus,
  selfSponsoredAuthorizationNonce,
  setCodeIntrinsicGas,
  signEip7702Authorization,
  signEip7702Transaction,
  toBytes,
  toHex,
  type JsonRpcTransport,
} from '@shiba-wallet/chains-evm';
import { assertFeatureAllowed, eip155Caip2 } from '../config/readiness.ts';
import {
  L1_DATA_FEE_HEADROOM_PERCENT,
  OP_STACK_GAS_PRICE_ORACLE,
  chainHasL1DataFee,
  notifySendAccepted,
  opStackFeeTotal,
  quoteEndpointChange,
  type OpStackFees,
} from './send.ts';

/**
 * EIP-7702 "Upgrade this account" glue for the app (phase 8 item 1, app
 * half): the delegation status of the wallet's own EOAs, and the two
 * self-sponsored set-code (type 0x04) transactions the wallet ever builds —
 * delegate to the pinned Kernel v3.3 implementation, or revoke (delegate to
 * the zero address).
 *
 * Sources (all read through the engine, packages/chains-evm):
 *  - EIP-7702, status Final, ethereum/EIPs EIPS/eip-7702.md at commit
 *    bbc3f95844c37612a2f1b9e7477990bb717ecfa0: the delegation indicator
 *    0xef0100 || address is what eth_getCode returns for a delegated EOA;
 *    a tuple whose address is the zero address clears the code; the sender's
 *    nonce is incremented before the authorization list is processed, so a
 *    tuple carried by the EOA's own transaction must name tx nonce + 1; the
 *    intrinsic cost adds PER_EMPTY_ACCOUNT_COST (25,000) per tuple. The
 *    engine's eip7702.ts quotes each of these lines.
 *  - The delegate is KERNEL_V3_3_7702_DELEGATE, the Kernel v3.3
 *    implementation 0xd6CEDDe84be40893d153Be9d467CD6aD37875b28 (engine
 *    kernel-account.ts, cross-checked there against the ZeroDev SDK's
 *    KERNEL_7702_DELEGATION_ADDRESS); no initialization is needed or possible.
 *
 * ADR D6 (AGENTS.md; EIP-7702 "Interaction with applications and wallets":
 * "Applications must not expect that they can suggest the user sign an
 * authorization, and therefore it is the duty of the wallet to not provide
 * an interface to do so. There is no safe way to provide this interface."):
 * the wallet signs an authorization tuple ONLY from the upgrade flow (this
 * module and the kernel-7702 smart-account path in ./aa.ts), ONLY for the
 * pinned Kernel delegate or the zero address (revocation), ONLY for the
 * active chain (never chain id 0 — the engine refuses it), and ONLY after
 * the biometric gate (callers sign through WalletContext.signWith after
 * requireLocalAuth). assertWalletDelegate enforces the delegate rule at the
 * signing call itself. WalletConnect requests that carry an authorization
 * are declined in ./walletconnect.ts.
 *
 * Free of React Native imports (explicit .ts extensions on relative imports)
 * so scripts/check-7702.mjs runs this exact code under Node.
 */

/** The only delegate this wallet ever authorizes (besides the zero address, which revokes). */
export const WALLET_7702_DELEGATE = KERNEL_V3_3_7702_DELEGATE;

/** Delegation status of one of the wallet's own EOAs on one chain. */
export type AccountDelegation =
  /** No code: a plain EOA (never delegated, or revoked). */
  | { kind: 'plain' }
  /** Delegated to the wallet's pinned Kernel v3.3 implementation. */
  | { kind: 'kernel-v3.3'; delegate: string }
  /** Delegated to some other contract — not done by this wallet's upgrade flow. */
  | { kind: 'other'; delegate: string }
  /**
   * Code that is not a delegation indicator. Not expected for a
   * seed-derived EOA; reported rather than guessed.
   */
  | { kind: 'contract' };

export type TransportFactory = (url: string) => JsonRpcTransport;

/** Throws unless `address` is the pinned Kernel delegate or the zero address (D6). */
export function assertWalletDelegate(address: string): void {
  const lower = address.toLowerCase();
  if (lower !== WALLET_7702_DELEGATE.toLowerCase() && lower !== ZERO_ADDRESS) {
    throw new Error(
      `Refusing to sign an EIP-7702 authorization for ${address}: this wallet only delegates to ` +
        `Kernel v3.3 (${WALLET_7702_DELEGATE}) or revokes (zero address).`,
    );
  }
}

/** Pure classification of the engine's DelegationStatus. */
export function classifyDelegation(
  status: { kind: 'none' } | { kind: 'delegated'; delegate: string } | { kind: 'contract' },
): AccountDelegation {
  if (status.kind === 'none') return { kind: 'plain' };
  if (status.kind === 'contract') return { kind: 'contract' };
  return status.delegate.toLowerCase() === WALLET_7702_DELEGATE.toLowerCase()
    ? { kind: 'kernel-v3.3', delegate: status.delegate }
    : { kind: 'other', delegate: status.delegate };
}

// ---------------------------------------------------------------------------
// Session cache (per account + chain), with change notifications
// ---------------------------------------------------------------------------

const cache = new Map<string, AccountDelegation>();
const inflight = new Map<string, Promise<AccountDelegation>>();
const listeners = new Set<() => void>();

function cacheKey(chainId: bigint | undefined, url: string, address: string): string {
  return `${chainId !== undefined ? chainId.toString() : `url:${url}`}|${address.toLowerCase()}`;
}

/** Subscribes to cache invalidations (hooks re-read). Returns the unsubscribe function. */
export function subscribeDelegation(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Drops cached statuses — for one address (on every chain), or everything
 * when no address is given — and notifies subscribers. Called after any
 * delegation change the wallet makes (upgrade transaction, revocation, a
 * smart-account send that carried the tuple).
 */
export function invalidateAccountDelegation(address?: string): void {
  if (address === undefined) {
    cache.clear();
  } else {
    const suffix = `|${address.toLowerCase()}`;
    for (const key of [...cache.keys()]) if (key.endsWith(suffix)) cache.delete(key);
  }
  for (const listener of [...listeners]) listener();
}

/** The cached status, if one was read this session (no network). */
export function cachedAccountDelegation(
  url: string,
  address: string,
  chainId?: bigint,
): AccountDelegation | undefined {
  return cache.get(cacheKey(chainId, url, address));
}

/**
 * Reads an account's delegation through the engine's readDelegationStatus
 * (eth_getCode) and classifies it: plain / kernel-v3.3 (delegate equals the
 * pinned KERNEL_V3_3_7702_DELEGATE) / other (with the delegate address) /
 * contract. When `chainId` is given the endpoint's eth_chainId must match it
 * first — a status read on the wrong chain would be a wrong answer. Results
 * are cached for the session per chain + address; `force` re-reads.
 */
export async function readAccountDelegation(
  url: string,
  address: string,
  options: { chainId?: bigint; transportFor?: TransportFactory; force?: boolean } = {},
): Promise<AccountDelegation> {
  const key = cacheKey(options.chainId, url, address);
  if (!options.force) {
    const hit = cache.get(key);
    if (hit) return hit;
    const pending = inflight.get(key);
    if (pending) return pending;
  }
  const task = (async () => {
    const node = (options.transportFor ?? httpTransport)(url);
    if (options.chainId !== undefined) {
      const reported = await new NodeClient(node).chainId();
      if (reported !== options.chainId) {
        throw new Error(
          `The RPC endpoint is chain id ${reported}, expected ${options.chainId}; the account ` +
            'status cannot be read through it.',
        );
      }
    }
    const status = classifyDelegation(await readDelegationStatus(node, address));
    cache.set(key, status);
    return status;
  })();
  inflight.set(key, task);
  try {
    return await task;
  } finally {
    if (inflight.get(key) === task) inflight.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Display text (one source for every screen)
// ---------------------------------------------------------------------------

export function shortDelegate(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * The upgrade explanation (the phase 8 engine design note, recorded in
 * AGENTS.md: "Your address stays the same…").
 */
export const UPGRADE_EXPLANATION =
  'Your address stays the same. Your account will run ZeroDev Kernel v3.3 code ' +
  `(contract ${WALLET_7702_DELEGATE.slice(0, 6)}…${WALLET_7702_DELEGATE.slice(-4)}), which enables batching, sponsored gas ` +
  'and, later, session keys. Your recovery phrase still controls everything. You can undo ' +
  'this at any time.';

/**
 * Receiving caveat. EIP-7702 (Gas Costs): resolving a delegated account's
 * code costs an extra 2,600 gas (cold) or 100 (warm), and a call to the
 * account runs the delegate's code. A plain ETH transfer sent with exactly
 * 21,000 gas has nothing left for that, and AGENTS.md (phase 7 live
 * validation) records a 21,000-gas transfer to a deployed Kernel account
 * failing. Inferred for a delegated EOA from those two facts; not yet
 * observed live for a 7702-upgraded address.
 */
export const UPGRADE_RECEIVE_NOTE =
  'After the upgrade, a plain ETH transfer to your address runs the account code. Senders that ' +
  'use a fixed 21,000-gas limit (some exchanges do) may fail to send to it until you undo the ' +
  'upgrade; wallets that estimate gas are not affected.';

export const SET_CODE_WARNING =
  'This changes what code runs at your address. Until you undo it, every call to your address ' +
  'runs Kernel v3.3.';

/**
 * Why the set-code transaction skips the eth_call pre-flight: eth_call has
 * no field for an authorization list in the request this app sends, so a
 * simulation would run against the account's CURRENT code (none) and show a
 * plain self-call, which says nothing about the delegation.
 */
export const SET_CODE_NO_SIMULATION_NOTE =
  'No pre-flight simulation: this transaction installs code at your address, and a simulation ' +
  'would run against the code that is there now, so it could not show what the upgrade does. ' +
  'The transaction sends 0 ETH to yourself; only the network fee is spent.';

export const REVOKE_NOTE =
  'Undoing the upgrade is a transaction from this account that sets its code back to none ' +
  '(an EIP-7702 authorization for the zero address). It costs a normal network fee in ETH ' +
  '(about 37,000 gas on Sepolia) and cannot be sponsored, because the account itself must send it.';

export const FOREIGN_DELEGATE_WARNING =
  "This is not the wallet's Kernel delegate. If you did not do this, revoke it now.";

/** Status line for the upgrade screen. */
export function delegationStatusText(status: AccountDelegation): string {
  switch (status.kind) {
    case 'plain':
      return 'Regular account (no code)';
    case 'kernel-v3.3':
      return 'Upgraded to Kernel v3.3';
    case 'other':
      return `Delegated elsewhere: ${status.delegate}`;
    case 'contract':
      return 'This address holds contract code that is not an EIP-7702 delegation';
  }
}

/**
 * Suffix for an account label wherever the account is shown as sending
 * ("Account 1 · upgraded (Kernel v3.3)"), so the user always knows which
 * code runs. Empty for a plain account or an unknown status.
 */
export function delegationLabelSuffix(status: AccountDelegation | null | undefined): string {
  if (!status) return '';
  if (status.kind === 'kernel-v3.3') return ' · upgraded (Kernel v3.3)';
  if (status.kind === 'other') return ` · delegated to ${shortDelegate(status.delegate)} (not the wallet's Kernel)`;
  if (status.kind === 'contract') return ' · holds contract code';
  return '';
}

// ---------------------------------------------------------------------------
// Self-sponsored set-code transactions (upgrade now / revoke)
// ---------------------------------------------------------------------------

/**
 * Gas above the intrinsic cost for the call the set-code transaction makes
 * to the EOA itself (empty data; after the tuple is processed it runs the
 * new code's receive path for a delegation, nothing for a revocation). The
 * same 40,000 the proven smoke test uses (scripts/testnet/eip7702-smoke.mjs
 * buildSelfSponsoredSetCode); its live revocation used 36,800 gas in total
 * (AGENTS.md phase 8). Unused gas is refunded, so the confirm screen's fee is
 * a worst case.
 */
export const SET_CODE_EXECUTION_GAS = 40_000n;

export type SetCodeAction = 'upgrade' | 'revoke';

export interface SetCodeQuote {
  kind: 'set-code';
  action: SetCodeAction;
  /** The EOA: sender, authority and destination. */
  from: string;
  chainId: bigint;
  /** Transaction nonce. */
  nonce: bigint;
  /** Tuple nonce = nonce + 1 (self-sponsored, EIP-7702). */
  authorizationNonce: bigint;
  /** WALLET_7702_DELEGATE for an upgrade, ZERO_ADDRESS for a revocation. */
  delegate: string;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /**
   * Worst case: gasLimit × maxFeePerGas, plus on an OP-stack network the
   * layer 1 data fee reserve and the operator fee (`opStack`).
   */
  fee: bigint;
  /**
   * OP-stack fee parts (Base Sepolia), already included in `fee`. Absent on
   * chains without an L1 data fee (Ethereum mainnet and Sepolia), whose
   * quotes are unchanged.
   */
  opStack?: OpStackFees;
  balance: bigint;
  /** Status when quoted. */
  statusBefore: AccountDelegation;
  /**
   * The RPC endpoint this quote came from. The nonce, fees, balance and
   * status above are that endpoint's answers, so the transaction must be
   * signed for and sent through the same URL (quote pinning, phase 9 item 5
   * follow-up; sendSetCodeTx refuses any other URL).
   */
  url: string;
}

/**
 * The unsigned set-code (type 0x04) transaction as GasPriceOracle.getL1Fee
 * expects it: 0x04 || rlp([chainId, nonce, maxPriorityFeePerGas,
 * maxFeePerGas, gasLimit, to, value, data, accessList, authorizationList]),
 * the payload whose keccak256 the sender signs (EIP-7702 "Set Code
 * Transaction"; the same ten fields, in the same order, as the engine's
 * eip7702.ts setCodePayloadFields, whose bytes the engine does not export).
 * Each authorization is [chainId, address, nonce, yParity, r, s].
 */
export function serializeUnsignedSetCode(tx: {
  chainId: bigint;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
  to: string;
  authorizations: { chainId: bigint; address: string; nonce: bigint; yParity: number; r: Uint8Array; s: Uint8Array }[];
}): Uint8Array {
  const strip = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length && b[i] === 0) i++;
    return b.slice(i);
  };
  const body = rlpEncode([
    minimalBytes(tx.chainId),
    minimalBytes(tx.nonce),
    minimalBytes(tx.maxPriorityFeePerGas),
    minimalBytes(tx.maxFeePerGas),
    minimalBytes(tx.gasLimit),
    toBytes(tx.to),
    minimalBytes(0n),
    new Uint8Array(0),
    [],
    tx.authorizations.map((a) => [
      minimalBytes(a.chainId),
      toBytes(a.address),
      minimalBytes(a.nonce),
      minimalBytes(BigInt(a.yParity)),
      strip(a.r),
      strip(a.s),
    ]),
  ]);
  const out = new Uint8Array(1 + body.length);
  out[0] = 0x04;
  out.set(body, 1);
  return out;
}

/**
 * Stand-in signature values for the authorization tuple when the L1 data fee
 * is priced. The real tuple is signed only after the biometric gate (D6), so
 * at quote time its r and s are unknown. The oracle prices the bytes' FastLZ-
 * compressed size, so stand-ins must be as incompressible as a real
 * signature: two keccak256 digests (32 bytes each, like a real r and s) and
 * yParity 1 (one byte; 0 would encode as an empty string and price lower).
 */
export const SET_CODE_L1_FEE_STUB_R = keccak_256(utf8ToBytes('shiba-wallet: set-code L1 fee stub r'));
export const SET_CODE_L1_FEE_STUB_S = keccak_256(utf8ToBytes('shiba-wallet: set-code L1 fee stub s'));

/**
 * The OP-stack fees of a self-sponsored set-code transaction (phase 13 item
 * 4; Base Sepolia). Sources, read 2026-10-04:
 *  - op-geth (ethereum-optimism/op-geth, branch optimism at b355734b),
 *    core/types/transaction.go RollupCostData(): the L1 cost a node charges
 *    is computed from `tx.MarshalBinary()` for every transaction type except
 *    deposits, so a type 0x04 transaction pays it like any other
 *    (SetCodeTxType = 0x04 in the same file);
 *  - GasPriceOracle (ethereum-optimism/optimism, develop at 773798a6,
 *    packages/contracts-bedrock/src/L2/GasPriceOracle.sol): getL1Fee(bytes
 *    _data) takes the "Unsigned fully RLP-encoded transaction" and, since
 *    Fjord, prices `LibZip.flzCompress(_data).length + 68` — nothing in it
 *    depends on the transaction type, so the unsigned type 0x04 bytes are
 *    what it expects, the +68 standing for the sender's own signature.
 * What is NOT exact: the authorization's own signature sits inside the
 * unsigned payload and is stubbed (SET_CODE_L1_FEE_STUB_R/S), so the priced
 * bytes differ from the signed ones in those 64 bytes; a real r or s with a
 * leading zero byte is one byte shorter. The send.ts headroom
 * (L1_DATA_FEE_HEADROOM_PERCENT) covers that difference as it covers the
 * fee moving. Any oracle failure refuses the quote, as for the Send screen.
 */
export async function quoteSetCodeOpStackFees(
  transport: JsonRpcTransport,
  tx: {
    chainId: bigint;
    nonce: bigint;
    maxPriorityFeePerGas: bigint;
    maxFeePerGas: bigint;
    gasLimit: bigint;
    to: string;
    delegate: string;
    authorizationNonce: bigint;
  },
): Promise<OpStackFees> {
  const unsigned = serializeUnsignedSetCode({
    ...tx,
    authorizations: [
      {
        chainId: tx.chainId,
        address: tx.delegate,
        nonce: tx.authorizationNonce,
        yParity: 1,
        r: SET_CODE_L1_FEE_STUB_R,
        s: SET_CODE_L1_FEE_STUB_S,
      },
    ],
  });
  const read = async (data: Uint8Array, what: string): Promise<bigint> => {
    let result: unknown;
    try {
      result = await transport('eth_call', [{ to: OP_STACK_GAS_PRICE_ORACLE, data: toHex(data) }, 'latest']);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not read the ${what} from the network's GasPriceOracle, so the full fee of this ` +
          `transaction is unknown. Nothing was signed. (${detail})`,
      );
    }
    if (typeof result !== 'string') {
      throw new Error(`The GasPriceOracle answered the ${what} request with no value. Nothing was signed.`);
    }
    return decodeUint256(result);
  };
  const [l1DataFeeEstimate, operatorFee] = await Promise.all([
    read(encodeFunctionCall('getL1Fee(bytes)', [{ kind: 'bytes', value: unsigned }]), 'layer 1 data fee'),
    read(encodeFunctionCall('getOperatorFee(uint256)', [{ kind: 'uint256', value: tx.gasLimit }]), 'operator fee'),
  ]);
  const headroom = (l1DataFeeEstimate * L1_DATA_FEE_HEADROOM_PERCENT + 99n) / 100n;
  return { l1DataFeeEstimate, l1DataFee: l1DataFeeEstimate + headroom, operatorFee, unsignedTxBytes: unsigned.length };
}

/**
 * Quotes the self-sponsored set-code transaction for `action`:
 *  - the endpoint's eth_chainId must equal `expectedChainId` (the active
 *    chain), so a tuple is only ever bound to the chain the user is on;
 *  - upgrade: refused when already upgraded (nothing to do), delegated
 *    elsewhere (EIP-7702 "Storage management": changing delegates is
 *    security-critical — revoke first), or holding contract code;
 *  - revoke: refused for a plain account (nothing to undo) or contract code;
 *  - gas = setCodeIntrinsicGas(1) + SET_CODE_EXECUTION_GAS, fee checked
 *    against the EOA's ETH balance (it cannot be sponsored); on an OP-stack
 *    network the fee includes the layer 1 data fee reserve and the operator
 *    fee (quoteSetCodeOpStackFees).
 */
export async function prepareSetCodeTx(options: {
  url: string;
  from: string;
  action: SetCodeAction;
  expectedChainId: bigint;
  transportFor?: TransportFactory;
}): Promise<SetCodeQuote> {
  // Mainnet readiness (config/readiness.ts): an upgrade is refused before
  // any request where it is not allowed. A revocation is never gated, so an
  // upgrade made earlier can always be undone.
  if (options.action === 'upgrade') assertFeatureAllowed('eip7702-upgrade', eip155Caip2(options.expectedChainId));
  const node = (options.transportFor ?? httpTransport)(options.url);
  const client = new NodeClient(node);
  const chainId = await client.chainId();
  if (chainId !== options.expectedChainId) {
    throw new Error(
      `Endpoint is chain id ${chainId}, expected ${options.expectedChainId}. Check the RPC ` +
        'endpoint (and the Sepolia test mode toggle) in Settings.',
    );
  }
  const statusBefore = classifyDelegation(await readDelegationStatus(node, options.from));
  if (statusBefore.kind === 'contract') {
    throw new Error(`${options.from} holds contract code that is not an EIP-7702 delegation.`);
  }
  if (options.action === 'upgrade') {
    if (statusBefore.kind === 'kernel-v3.3') {
      throw new Error('This account is already upgraded to Kernel v3.3; there is nothing to do.');
    }
    if (statusBefore.kind === 'other') {
      throw new Error(
        `This account is delegated to ${statusBefore.delegate}, not the wallet's Kernel delegate. ` +
          'Revoke that delegation first; the wallet does not replace another delegation ' +
          '(EIP-7702: changing delegates is security-critical).',
      );
    }
  } else if (statusBefore.kind === 'plain') {
    throw new Error('This account is not delegated; there is nothing to undo.');
  }
  const [nonce, fees, balance] = await Promise.all([
    client.getTransactionCount(options.from),
    client.suggestFees(),
    client.getBalance(options.from),
  ]);
  const gasLimit = setCodeIntrinsicGas(1) + SET_CODE_EXECUTION_GAS;
  const delegate = options.action === 'upgrade' ? WALLET_7702_DELEGATE : ZERO_ADDRESS;
  const authorizationNonce = selfSponsoredAuthorizationNonce(nonce);
  // OP-stack networks only: the layer 1 data fee of this exact transaction,
  // with the authorization's signature stubbed (see quoteSetCodeOpStackFees).
  const opStack = chainHasL1DataFee(chainId)
    ? await quoteSetCodeOpStackFees(node, {
        chainId,
        nonce,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        maxFeePerGas: fees.maxFeePerGas,
        gasLimit,
        to: options.from,
        delegate,
        authorizationNonce,
      })
    : undefined;
  const fee = gasLimit * fees.maxFeePerGas + opStackFeeTotal(opStack);
  if (fee > balance) {
    throw new Error(
      `Not enough ETH to pay the network fee: the worst-case fee is ${fee} wei and the account ` +
        `holds ${balance} wei. This transaction is sent by the account itself, so it cannot be ` +
        'sponsored.',
    );
  }
  return {
    kind: 'set-code',
    action: options.action,
    from: options.from,
    chainId,
    nonce,
    authorizationNonce,
    delegate,
    gasLimit,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    fee,
    ...(opStack ? { opStack } : {}),
    balance,
    statusBefore,
    url: options.url,
  };
}

/**
 * Signs (tuple, then transaction) and broadcasts a quoted set-code
 * transaction. Call only after the biometric gate, with the signer from
 * WalletContext.signWith(expectAddress = quote.from). Refuses before
 * signing when the signer is not the quoted EOA, the delegate is not one the
 * wallet allows (D6), the tuple nonce is not tx nonce + 1, or the endpoint
 * moved to another chain. Also refuses when `url` is not the endpoint the
 * quote came from (the screen re-resolves the endpoint before the biometric
 * gate and sends through quote.url; this is the last line of defense).
 * Invalidates the status cache for the account.
 */
export async function sendSetCodeTx(
  url: string,
  signer: DerivedAccount,
  quote: SetCodeQuote,
  explorerTxBase: string | null,
  options: { transportFor?: TransportFactory } = {},
): Promise<{ txid: string; explorerUrl: string | null }> {
  // Mainnet readiness: checked again before signing. Only a tuple naming the
  // zero address (a revocation) passes on a gated network, whatever the
  // quote's action field says.
  if (quote.action === 'upgrade' || quote.delegate.toLowerCase() !== ZERO_ADDRESS.toLowerCase()) {
    assertFeatureAllowed('eip7702-upgrade', eip155Caip2(quote.chainId));
  }
  // Quote pinning: a quote is one endpoint's answer and is never sent
  // through another endpoint.
  const endpointMoved = quoteEndpointChange(quote.url, url);
  if (endpointMoved) throw new Error(endpointMoved);
  if (signer.address.toLowerCase() !== quote.from.toLowerCase()) {
    throw new Error(
      `This signer is ${signer.address}, but the transaction was prepared for ${quote.from}. ` +
        'Nothing was signed.',
    );
  }
  assertWalletDelegate(quote.delegate);
  if (quote.authorizationNonce !== selfSponsoredAuthorizationNonce(quote.nonce)) {
    throw new Error('The authorization nonce must be the transaction nonce + 1. Nothing was signed.');
  }
  const node = (options.transportFor ?? httpTransport)(url);
  const client = new NodeClient(node);
  const chainId = await client.chainId();
  if (chainId !== quote.chainId) {
    throw new Error(`Endpoint is now chain id ${chainId}, not ${quote.chainId}. Nothing was signed.`);
  }
  const authorization = signEip7702Authorization(
    { chainId: quote.chainId, address: quote.delegate, nonce: quote.authorizationNonce },
    signer,
  );
  const signed = signEip7702Transaction(
    {
      chainId: quote.chainId,
      nonce: quote.nonce,
      maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
      maxFeePerGas: quote.maxFeePerGas,
      gasLimit: quote.gasLimit,
      to: quote.from,
      value: 0n,
      authorizationList: [authorization],
    },
    signer,
  );
  const txid = await client.sendRawTransaction(signed.rawHex);
  invalidateAccountDelegation(quote.from);
  notifySendAccepted();
  return { txid, explorerUrl: explorerTxBase ? `${explorerTxBase}${txid}` : null };
}

/**
 * Polls for the set-code transaction's receipt, then re-reads the account's
 * status (forced, so the cache holds the post-transaction truth). Throws on
 * timeout; the transaction may still be included later.
 */
export async function waitForSetCode(
  url: string,
  txid: string,
  address: string,
  options: {
    chainId?: bigint;
    transportFor?: TransportFactory;
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<{ success: boolean; status: AccountDelegation }> {
  const node = (options.transportFor ?? httpTransport)(url);
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  const pollMs = options.pollMs ?? 4_000;
  for (;;) {
    const receipt = (await node('eth_getTransactionReceipt', [txid])) as { status?: string } | null;
    if (receipt) {
      const status = await readAccountDelegation(url, address, {
        ...(options.chainId !== undefined ? { chainId: options.chainId } : {}),
        ...(options.transportFor ? { transportFor: options.transportFor } : {}),
        force: true,
      });
      // The forced read replaced the cached entry; tell subscribers.
      for (const listener of [...listeners]) listener();
      return { success: receipt.status === '0x1', status };
    }
    if (Date.now() + pollMs > deadline) throw new Error(`Timed out waiting for transaction ${txid}`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
