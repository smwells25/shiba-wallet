/**
 * Cold signing for a SMART ACCOUNT, end to end (phase 23 item 5, the engine
 * and script half). The ON-LINE half below holds only the owner's ADDRESS:
 * it builds, estimates and fee-checks a Kernel v3.3 UserOperation with
 * SmartAccountClient.prepareUserOperationForExternalSigner, writes the
 * engine's "shiba-wallet/cold-sign-userop-request" to a file, and has it
 * signed in a SEPARATE process by scripts/testnet/cold-signer.mjs
 * sign-userop (the only process that reads a key). It then verifies the
 * returned signature, simulates the signed operation through the real
 * EntryPoint v0.7 with eth_simulateV1, and submits it with
 * submitColdUserOpRequest (the signature re-checked before any request,
 * then the chain checks, then the fee check below, then
 * eth_sendUserOperation).
 *
 * Fees follow the app's rules (app/src/wallet/aa.ts, not imported because it
 * pulls in React Native modules; mirrored here and cited):
 *  - the quote: the node's suggestion raised to the bundler's STANDARD tier
 *    (pimlico_getUserOperationGasPrice) plus AA_FEE_FLOOR_HEADROOM_PERCENT =
 *    100, as quoteFeesOverFloor;
 *  - before submission: the bundler's floor is read again and the operation
 *    is refused when its signed fees are below the SLOW tier (the lowest
 *    advertised price), as feeFloorShortfall; and the signed worst case must
 *    not exceed the reviewed one, as signedFeeGuard. The signed fees are
 *    never changed: a refusal means a fresh request and a fresh signature.
 *  - the client: depositTopUpVerificationGas 40,000 and no gas padding, as
 *    the app's Kernel client (AA_DEPOSIT_TOPUP_VERIFICATION_GAS).
 *
 * Modes (run from the repository root after `npm run build`, Node 24):
 *
 *   Dry run (default; anyone; read-only): the PUBLIC BIP-39 test phrase,
 *   written to a 0600 scratch file for the signer process; a fake bundler
 *   with fixed limits that captures the submitted operation; every signed
 *   operation simulated against the real Sepolia EntryPoint and Kernel with
 *   a balance override. Also simulates three operations the engine itself
 *   would refuse, to pin the CONTRACTS' behaviour: a signature by another
 *   key (validation must fail), a signature over the RAW userOpHash (the
 *   ECDSA validator accepts it on-chain; the engine refuses it anyway), and
 *   the signed operation with its maxFeePerGas raised by one wei (the
 *   signature no longer validates: fees cannot be repriced).
 *     node scripts/testnet/cold-userop-smoke.mjs
 *
 *   Live (dev seed, Ethereum Sepolia, ZeroDev's bundler):
 *     set -a; . .dev-wallet/env; set +a
 *     COLD_USEROP_LIVE=1 node scripts/testnet/cold-userop-smoke.mjs
 *   The owner is dev index 8 (OWNER_INDEX); its counterfactual Kernel
 *   account must already be funded (scripts/testnet/fund.mjs) — the script
 *   prints what it needs and stops, signing nothing, when it is short. Op 1
 *   deploys the account and sends 0.0001 test ETH to the dev EOA; op 2 sweeps
 *   what the account can spare back to the dev EOA (balance minus the part of
 *   the worst-case fee the EntryPoint deposit does not cover). Every bundle
 *   receipt is re-read on two public RPCs. SPEND_CAP_WEI (default 0.006 ETH)
 *   caps each operation's worst-case fee plus value. Op 3 then withdraws
 *   most of the account's EntryPoint DEPOSIT to the dev EOA with
 *   EntryPoint.withdrawTo, a contract call from the account: EntryPoint
 *   v0.7.0 takes the whole required prefund from the deposit during
 *   validation (contracts/core/EntryPoint.sol lines 482-504: AA21 unless the
 *   deposit covers it, then deposit -= requiredPrefund) and withdrawTo
 *   refuses more than the deposit (contracts/core/StakeManager.sol lines
 *   134-144), so the amount is the deposit minus TWICE the prefund (one
 *   prefund for this operation, one as margin for the bundler's estimation,
 *   which may simulate with other limits); the unused prefund returns to the
 *   deposit as dust. COLD_USEROP_ONLY_WITHDRAW=1 runs op 3 alone on an
 *   account deployed earlier.
 *
 * Files: the request and the signature go to COLD_USEROP_DIR (default
 * .local/cold-userop, git-ignored), mode 0600, and are deleted with rm -P at
 * the end whatever happens. Nothing from .dev-wallet is printed: the bundler
 * URL and the ZeroDev project id are masked in every line.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { ChainRegistry, HdKeyring, evmKeyProvider } from '../../packages/core/dist/index.js';
import * as evm from '../../packages/chains-evm/dist/index.js';
import { SEPOLIA_RPC } from './config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIVE = process.env.COLD_USEROP_LIVE === '1';
const CHAIN_ID = 11155111n;
const NODE_URL = process.env.NODE_URL ?? SEPOLIA_RPC;
/** Second public RPC for the receipt re-reads (the record's usual pair, phase 19). */
const SECOND_RPC = process.env.SECOND_RPC ?? 'https://sepolia.drpc.org';
const OWNER_INDEX = process.env.OWNER_INDEX ?? (LIVE ? '8' : '0');
/** Dev index 8 and the dev EOA (index 0), as recorded in AGENTS.md (phase 22 item 3; the standing records). */
const EXPECTED_LIVE_OWNER = '0x8E1dEaF5d88e60DBdabcC79d8EFA570f40fb0cDF';
const EXPECTED_DEV_EOA = '0x16DA2CAeaDa26516F919C6872F6C38AB378CaC5C';
const SPEND_CAP_WEI = BigInt(process.env.SPEND_CAP_WEI ?? '6000000000000000');
const TRANSFER_WEI = 100_000_000_000_000n; // 0.0001 ETH
const FEE_HEADROOM_PERCENT = 100n; // app/src/wallet/aa.ts AA_FEE_FLOOR_HEADROOM_PERCENT
const DEPOSIT_TOPUP_GAS = 40_000n; // app/src/wallet/aa.ts AA_DEPOSIT_TOPUP_VERIFICATION_GAS
const FILE_DIR = process.env.COLD_USEROP_DIR ?? join(ROOT, '.local', 'cold-userop');
const PUBLIC_TEST_PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const BUNDLER_URL = LIVE
  ? process.env.BUNDLER_URL ??
    (process.env.ZERODEV_PROJECT_ID ? `https://rpc.zerodev.app/api/v3/${process.env.ZERODEV_PROJECT_ID}/chain/${CHAIN_ID}` : null)
  : null;
function mask(text) {
  let out = String(text);
  for (const secret of [process.env.ZERODEV_PROJECT_ID, BUNDLER_URL].filter(Boolean)) out = out.split(secret).join('<masked>');
  return out;
}
const log = (...parts) => console.log(mask(parts.join(' ')));

const node = evm.httpTransport(NODE_URL);
const second = evm.httpTransport(SECOND_RPC);
const nodeClient = new evm.NodeClient(node);
const filesToDelete = new Set();

function writeSecretFile(path, text) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
  filesToDelete.add(path);
}

function shredAll() {
  for (const path of filesToDelete) {
    if (!existsSync(path)) continue;
    const r = spawnSync('rm', ['-P', path]);
    if (r.status !== 0) console.error(`could not delete ${path} with rm -P`);
  }
  filesToDelete.clear();
}

/** Runs cold-signer.mjs in its own process; only that process reads a key. */
function signer(args, mnemonicFile) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, ...(mnemonicFile ? { MNEMONIC_FILE: mnemonicFile } : {}) };
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/testnet/cold-signer.mjs'), ...args], { env, encoding: 'utf8' });
  const stderr = (r.stderr ?? '').split('\n').filter((l) => l && !/MODULE_TYPELESS|Reparsing as ES module|add "type": "module"|trace-warnings/.test(l));
  if (r.status !== 0) throw new Error(`cold-signer ${args[0]} failed: ${stderr.join(' | ')}`);
  return { stdout: r.stdout.trim(), stderr };
}

const word = (data, i) => BigInt('0x' + data.slice(2 + 64 * i, 2 + 64 * (i + 1)));
const TOPIC = (sig) => evm.toHex(keccak_256(utf8ToBytes(sig)));
const EVENTS = {
  [TOPIC('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)')]: 'UserOperationEvent',
  [TOPIC('AccountDeployed(bytes32,address,address,address)')]: 'AccountDeployed',
  [TOPIC('Deposited(address,uint256)')]: 'Deposited',
  [TOPIC('OwnerRegistered(address,address)')]: 'OwnerRegistered',
  [TOPIC('Transfer(address,address,uint256)')]: 'Transfer',
  [TOPIC('BeforeExecution()')]: 'BeforeExecution',
  [TOPIC('Withdrawn(address,address,uint256)')]: 'Withdrawn',
};
/** EIP-7708 protocol transfer log emitter (packages/chains-evm asset-diff.ts EIP7708_TRANSFER_LOG_ADDRESS). */
const EIP7708 = '0xfffffffffffffffffffffffffffffffffffffffe';

const HANDLE_OPS_SIG = 'handleOps((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)[],address)';
function encodeHandleOps(op, beneficiary) {
  return evm.encodeFunctionCall(HANDLE_OPS_SIG, [
    {
      kind: 'array',
      items: [
        {
          kind: 'tuple',
          items: [
            { kind: 'address', value: op.sender },
            { kind: 'uint256', value: op.nonce },
            { kind: 'bytes', value: evm.packInitCode(op) },
            { kind: 'bytes', value: op.callData },
            { kind: 'fixedBytes', value: evm.packUint128Pair(op.verificationGasLimit, op.callGasLimit) },
            { kind: 'uint256', value: op.preVerificationGas },
            { kind: 'fixedBytes', value: evm.packUint128Pair(op.maxPriorityFeePerGas, op.maxFeePerGas) },
            { kind: 'bytes', value: evm.packPaymasterAndData(op) },
            { kind: 'bytes', value: op.signature },
          ],
        },
      ],
    },
    { kind: 'address', value: beneficiary },
  ]);
}

/**
 * handleOps([op]) through eth_simulateV1 against the real EntryPoint. A
 * validation failure reverts the whole call (FailedOp); an execution failure
 * does not, so the UserOperationEvent success flag is read from the logs.
 */
async function simulate(op, from, overrides) {
  const call = { from, to: evm.ENTRYPOINT_V07, data: evm.toHex(encodeHandleOps(op, from)), gas: '0x1c9c380' };
  const sim = await node('eth_simulateV1', [
    { blockStateCalls: [{ ...(overrides ? { stateOverrides: overrides } : {}), calls: [call] }] },
    'latest',
  ]);
  const result = sim[0].calls[0];
  if (result.status !== '0x1') {
    return { validated: false, error: `${result.error?.message ?? 'reverted'}${decodeFailedOp(result.error?.data ?? result.returnData)}` };
  }
  const hash = evm.toHex(evm.getUserOpHash(op, evm.ENTRYPOINT_V07, CHAIN_ID)).toLowerCase();
  let event = null;
  for (const l of result.logs ?? []) {
    if (EVENTS[l.topics?.[0]?.toLowerCase()] === 'UserOperationEvent' && l.topics[1]?.toLowerCase() === hash) {
      event = { success: word(l.data, 1) === 1n, actualGasCost: word(l.data, 2), actualGasUsed: word(l.data, 3) };
    }
  }
  return { validated: true, gasUsed: BigInt(result.gasUsed), event };
}

/** EntryPoint v0.7 FailedOp(uint256,string) / FailedOpWithRevert(uint256,string,bytes): the reason string, for the log. */
function decodeFailedOp(data) {
  if (typeof data !== 'string' || data.length < 10) return '';
  const sel = data.slice(0, 10).toLowerCase();
  const failedOp = evm.toHex(keccak_256(utf8ToBytes('FailedOp(uint256,string)')).slice(0, 4));
  const withRevert = evm.toHex(keccak_256(utf8ToBytes('FailedOpWithRevert(uint256,string,bytes)')).slice(0, 4));
  if (sel !== failedOp && sel !== withRevert) return ` (revert data ${data.slice(0, 10)})`;
  const body = data.slice(10);
  const off = Number(BigInt('0x' + body.slice(64, 128)));
  const len = Number(BigInt('0x' + body.slice(off * 2, off * 2 + 64)));
  const text = Buffer.from(body.slice(off * 2 + 64, off * 2 + 64 + len * 2), 'hex').toString('utf8');
  return ` — ${sel === failedOp ? 'FailedOp' : 'FailedOpWithRevert'}("${text}")`;
}

/** The bundler's tiers (pimlico_getUserOperationGasPrice), as app/src/wallet/aa.ts pimlicoFeeFloor reads them. */
async function bundlerTiers(bundler) {
  const r = await bundler('pimlico_getUserOperationGasPrice', []);
  const tier = (t) => ({ maxFeePerGas: BigInt(t.maxFeePerGas), maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas) });
  return { slow: tier(r.slow), standard: tier(r.standard), fast: tier(r.fast) };
}

/** app/src/wallet/aa.ts quoteFeesOverFloor with AA_FEE_FLOOR_HEADROOM_PERCENT = 100. */
function quoteFeesOverFloor(fees, standard) {
  const up = (v) => (v * (100n + FEE_HEADROOM_PERCENT) + 99n) / 100n;
  let { maxFeePerGas, maxPriorityFeePerGas } = fees;
  const priority = up(standard.maxPriorityFeePerGas);
  if (priority > maxPriorityFeePerGas) {
    maxFeePerGas += priority - maxPriorityFeePerGas;
    maxPriorityFeePerGas = priority;
  }
  const maxFee = up(standard.maxFeePerGas);
  if (maxFee > maxFeePerGas) maxFeePerGas = maxFee;
  return { maxFeePerGas, maxPriorityFeePerGas };
}

async function receiptOn(transport, hash) {
  for (let i = 0; i < 30; i++) {
    const r = await transport('eth_getTransactionReceipt', [hash]).catch(() => null);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 4000));
  }
  throw new Error(`no receipt for ${hash}`);
}

/** Re-reads a bundle receipt on BOTH RPCs and checks they agree on block, status and logs. */
async function verifyBundle(txHash, userOpHash, label) {
  const [a, b] = [await receiptOn(node, txHash), await receiptOn(second, txHash)];
  const sig = (r) => JSON.stringify([r.status, r.blockNumber, r.blockHash, r.gasUsed, (r.logs ?? []).map((l) => [l.address, l.topics, l.data])]);
  const clientA = await node('web3_clientVersion', []).catch(() => '?');
  const clientB = await second('web3_clientVersion', []).catch(() => '?');
  log(`  ${label} bundle tx ${txHash}`);
  log(`    ${new URL(NODE_URL).host} (${clientA}): status ${a.status}, block ${BigInt(a.blockNumber)}, gasUsed ${BigInt(a.gasUsed)}, from ${a.from}`);
  log(`    ${new URL(SECOND_RPC).host} (${clientB}): status ${b.status}, block ${BigInt(b.blockNumber)}, gasUsed ${BigInt(b.gasUsed)}`);
  if (sig(a) !== sig(b)) throw new Error('the two RPCs disagree on the bundle receipt');
  let ok = null;
  for (const l of a.logs ?? []) {
    const name = EVENTS[l.topics?.[0]?.toLowerCase()];
    let detail = '';
    if (name === 'UserOperationEvent') {
      if (l.topics[1].toLowerCase() === userOpHash.toLowerCase()) ok = word(l.data, 1) === 1n;
      detail = ` userOpHash ${l.topics[1]} sender 0x${l.topics[2].slice(26)} nonce ${word(l.data, 0)} success ${word(l.data, 1)} actualGasCost ${word(l.data, 2)} actualGasUsed ${word(l.data, 3)}`;
    } else if (name === 'AccountDeployed') {
      detail = ` sender 0x${l.topics[2].slice(26)} factory 0x${l.data.slice(26, 66)}`;
    } else if (name === 'Deposited') {
      detail = ` account 0x${l.topics[1].slice(26)} totalDeposit ${word(l.data, 0)}`;
    } else if (name === 'OwnerRegistered') {
      detail = ` kernel 0x${l.topics[1].slice(26)} owner 0x${l.topics[2].slice(26)}`;
    } else if (name === 'Transfer' && l.topics.length === 3) {
      detail = ` from 0x${l.topics[1].slice(26)} to 0x${l.topics[2].slice(26)} amount ${word(l.data, 0)}`;
    } else if (name === 'Withdrawn') {
      detail = ` account 0x${l.topics[1].slice(26)} to 0x${l.data.slice(26, 66)} amount ${word(l.data, 1)}`;
    }
    log(`    log ${l.address.toLowerCase() === EIP7708 ? `${l.address} (EIP-7708)` : l.address}: ${name ?? `topic ${l.topics?.[0]}`}${detail}`);
  }
  if (a.status !== '0x1' || ok !== true) throw new Error(`${label}: the bundle did not report UserOperationEvent success for ${userOpHash}`);
  return a;
}

async function balanceAt(transport, address, block) {
  return BigInt(await transport('eth_getBalance', [address, block]));
}

async function main() {
  log(`${LIVE ? 'LIVE' : 'DRY RUN'} — cold signing for a Kernel v3.3 smart account on Sepolia`);
  const chainId = await nodeClient.chainId();
  if (chainId !== CHAIN_ID) throw new Error(`the node reports chain ${chainId}, not ${CHAIN_ID}`);
  const deployment = await evm.verifyKernelDeployment(node);
  log(`Kernel v3.3 deployment verified on-chain: ${JSON.stringify(deployment)}`);

  // The signer process's key source. Dry run: the PUBLIC phrase in a 0600 scratch file.
  let mnemonicFile = null;
  if (!LIVE) {
    mnemonicFile = join(FILE_DIR, 'public-test-phrase.txt');
    writeSecretFile(mnemonicFile, PUBLIC_TEST_PHRASE);
  }
  // The on-line half learns ADDRESSES only, from the signer process.
  const owner = signer(['address', OWNER_INDEX], mnemonicFile).stdout;
  const recipient = LIVE ? signer(['address', '0'], mnemonicFile).stdout : '0x2222222222222222222222222222222222222222';
  if (LIVE && owner !== EXPECTED_LIVE_OWNER) throw new Error(`dev index ${OWNER_INDEX} is ${owner}, not the recorded ${EXPECTED_LIVE_OWNER}`);
  if (LIVE && recipient !== EXPECTED_DEV_EOA) throw new Error(`dev index 0 is ${recipient}, not the recorded ${EXPECTED_DEV_EOA}`);
  log(`Owner (off-line key, address only here): ${owner}`);

  let bundler;
  const captured = [];
  if (LIVE) {
    if (!BUNDLER_URL) throw new Error('Set ZERODEV_PROJECT_ID (source .dev-wallet/env) or BUNDLER_URL.');
    const real = evm.httpTransport(BUNDLER_URL);
    const eps = await real('eth_supportedEntryPoints', []);
    if (!eps.map((a) => a.toLowerCase()).includes(evm.ENTRYPOINT_V07.toLowerCase())) throw new Error('bundler lacks EntryPoint v0.7');
    const bundlerChain = BigInt(await real('eth_chainId', []));
    if (bundlerChain !== CHAIN_ID) throw new Error(`the bundler serves chain ${bundlerChain}`);
    bundler = async (method, params) => {
      const answer = await real(method, params);
      if (method === 'eth_estimateUserOperationGas') log(`  bundler estimate: ${JSON.stringify(answer)}`);
      return answer;
    };
  } else {
    bundler = async (method, params) => {
      if (method === 'eth_estimateUserOperationGas') {
        // Generous fixed limits: the dry run proves validity, not pricing.
        return { callGasLimit: '0x30d40', verificationGasLimit: '0x1e8480', preVerificationGas: '0x186a0' };
      }
      if (method === 'eth_sendUserOperation') {
        captured.push(params[0]);
        return '0x' + '00'.repeat(32);
      }
      throw new Error(`dry-run bundler: unexpected ${method}`);
    };
  }

  const spec = evm.createKernelAccountSpec({ node });
  const client = new evm.SmartAccountClient({
    chainId,
    entryPoint: evm.ENTRYPOINT_V07,
    bundler,
    node,
    spec,
    depositTopUpVerificationGas: DEPOSIT_TOPUP_GAS,
  });
  const ownerOnly = evm.addressOnlyOwner(owner, chainId);
  const sender = await client.getAddress(ownerOnly);
  if (sender !== evm.predictKernelAddress(owner)) throw new Error('factory getAddress disagrees with the local CREATE2 prediction');
  log(`Kernel account (index 0): ${sender}`);

  const overrides = LIVE ? undefined : { [sender]: { balance: '0xde0b6b3a7640000' } };

  async function quoteFees() {
    if (!LIVE) return { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
    const tiers = await bundlerTiers(bundler);
    const suggested = await nodeClient.suggestFees();
    const fees = quoteFeesOverFloor(suggested, tiers.standard);
    log(
      `  fees: node ${suggested.maxFeePerGas}/${suggested.maxPriorityFeePerGas}, bundler standard ${tiers.standard.maxFeePerGas}/${tiers.standard.maxPriorityFeePerGas}` +
        ` (slow ${tiers.slow.maxFeePerGas}/${tiers.slow.maxPriorityFeePerGas}) → quoted ${fees.maxFeePerGas}/${fees.maxPriorityFeePerGas} wei (maxFee/priority)`,
    );
    return fees;
  }

  /** The submit-time fee check (aa.ts feeFloorShortfall + signedFeeGuard): refuse, never reprice. */
  function feeCheck(reviewed) {
    return async (op) => {
      if (op.maxFeePerGas !== reviewed.maxFeePerGas || op.maxPriorityFeePerGas !== reviewed.maxPriorityFeePerGas) {
        throw new Error('the operation fees differ from the reviewed ones');
      }
      if (evm.requiredPrefund(op) > reviewed.worstCase) throw new Error('the worst-case fee grew past the reviewed one');
      if (!LIVE) return;
      const tiers = await bundlerTiers(bundler);
      const min = tiers.slow.maxPriorityFeePerGas <= tiers.standard.maxPriorityFeePerGas ? tiers.slow : tiers.standard;
      log(`  floor at submission: slow ${min.maxFeePerGas}/${min.maxPriorityFeePerGas} vs signed ${op.maxFeePerGas}/${op.maxPriorityFeePerGas}`);
      if (min.maxPriorityFeePerGas > op.maxPriorityFeePerGas || min.maxFeePerGas > op.maxFeePerGas) {
        throw new Error("The bundler's minimum fee rose above the signed fees; prepare a new request (the signed fees cannot be changed).");
      }
    };
  }

  /** Prepare → request file → separate signer → verify → simulate → submit. */
  async function coldOperation(label, calls) {
    const fees = await quoteFees();
    const prepared = await client.prepareUserOperationForExternalSigner(owner, calls, fees, {
      scheme: evm.KERNEL_V3_3_ECDSA_ROOT_SCHEME,
    });
    const op = prepared.userOp;
    const worstCase = evm.requiredPrefund(op);
    const value = calls.reduce((s, c) => s + c.value, 0n);
    log(
      `${label}: prepared nonce ${op.nonce}${op.factory ? ' (deploys the account)' : ''}; signed limits vGL ${op.verificationGasLimit} cGL ${op.callGasLimit} pVG ${op.preVerificationGas};` +
        ` worst case ${worstCase} wei + value ${value} wei`,
    );
    if (worstCase + value > SPEND_CAP_WEI) throw new Error(`worst case + value exceeds SPEND_CAP_WEI (${SPEND_CAP_WEI}); nothing signed`);
    if (LIVE) {
      const balance = await nodeClient.getBalance(sender);
      const deposit = await client.getEntryPointDeposit(sender);
      const need = worstCase + value;
      log(`  account balance ${balance} wei, EntryPoint deposit ${deposit} wei; needs up to ${need} wei`);
      if (balance + deposit < need) {
        throw new Error(`fund the Kernel account ${sender} with at least ${need - balance - deposit} wei more first; nothing signed`);
      }
    }
    const request = evm.buildColdUserOpRequest(prepared, {
      summary: `${label}: ${calls.map((c) => `${c.value} wei to ${c.to}`).join('; ')}${op.factory ? ' (deploys the account)' : ''}`,
      accountIndex: op.factory ? 0n : null,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    const requestFile = join(FILE_DIR, `request-${request.requestId.slice(2, 10)}.json`);
    const signatureFile = join(FILE_DIR, `signature-${request.requestId.slice(2, 10)}.json`);
    writeSecretFile(requestFile, evm.serializeColdUserOpRequest(request));
    log(`  request ${request.requestId} written (${evm.serializeColdUserOpRequest(request).length} bytes); userOpHash ${request.userOpHash}`);
    const signed = signer(['sign-userop', requestFile, OWNER_INDEX], mnemonicFile);
    for (const line of signed.stderr) log(`  [off-line signer] ${line}`);
    writeSecretFile(signatureFile, signed.stdout);
    const signatureText = readFileSync(signatureFile, 'utf8');
    const verified = evm.verifyColdUserOpSignature(signatureText, request);
    log(`  signature verified locally: recovers to ${verified.signer}`);

    // Pre-flight: the signed operation through the real EntryPoint.
    const signedOp = { ...op, signature: evm.KERNEL_V3_3_ECDSA_ROOT_SCHEME.encodeSignature(verified.signature) };
    const sim = await simulate(signedOp, owner, overrides);
    log(`  eth_simulateV1 handleOps: ${JSON.stringify(sim, (k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
    if (!sim.validated || sim.event?.success !== true) throw new Error('the pre-flight simulation failed; nothing submitted');

    const result = await evm.submitColdUserOpRequest(client, request, signatureText, {
      nowSeconds: Math.floor(Date.now() / 1000),
      beforeSign: feeCheck({ ...fees, worstCase }),
    });
    log(`  submitted: userOpHash ${result.userOpHash}`);
    return { request, prepared, signedOp, verified, result, sim };
  }

  if (!LIVE) {
    // Op 1 (deploys) through the whole path, captured by the fake bundler.
    const one = await coldOperation('op 1', [{ to: recipient, value: TRANSFER_WEI, data: new Uint8Array(0) }]);
    const sent = captured[0];
    const expectSent = evm.toRpcUserOperation(one.signedOp);
    if (JSON.stringify(sent) !== JSON.stringify(expectSent)) throw new Error('the submitted operation differs from the verified one');
    log('  the fake bundler received exactly the verified, simulated operation');

    // Contract-level facts the engine relies on (simulated; the engine refuses each before any request).
    const keyring = HdKeyring.fromMnemonic(PUBLIC_TEST_PHRASE, (() => { const r = new ChainRegistry(); r.register(evmKeyProvider); return r; })());
    const ownerKey = keyring.getAccount('eip155:1', 0, Number(OWNER_INDEX));
    const stranger = keyring.getAccount('eip155:1', 0, 1);
    const base = one.prepared.userOp;
    const hash = evm.getUserOpHash(base, evm.ENTRYPOINT_V07, CHAIN_ID);
    const as = (k, digest) => evm.withEthereumV(k.sign(digest));
    const wrong = await simulate({ ...base, signature: as(stranger, evm.toEthSignedMessageHash(hash)) }, owner, overrides);
    log(`  another key's signature: ${wrong.validated ? 'VALIDATED (unexpected)' : `refused by the EntryPoint (${wrong.error})`}`);
    const raw = await simulate({ ...base, signature: as(ownerKey, hash) }, owner, overrides);
    log(`  owner signature over the RAW userOpHash: ${raw.validated && raw.event?.success ? 'accepted on-chain (ECDSAValidator lines 57-58); the engine still refuses it' : `refused (${raw.error})`}`);
    const repriced = await simulate({ ...one.signedOp, maxFeePerGas: one.signedOp.maxFeePerGas + 1n }, owner, overrides);
    log(`  signed operation with maxFeePerGas + 1 wei: ${repriced.validated ? 'VALIDATED (unexpected)' : `refused by the EntryPoint (${repriced.error})`}`);
    if (wrong.validated || repriced.validated || !(raw.validated && raw.event?.success)) throw new Error('a contract-level expectation failed');

    // Engine refusals before any request.
    const before = captured.length;
    const otherSig = evm.buildColdUserOpSignature(one.request, owner, (() => {
      const s = stranger.sign(evm.toBytes(one.request.signingDigest));
      return { yParity: s[64], r: s.slice(0, 32), s: s.slice(32, 64) };
    })());
    await evm.submitColdUserOpRequest(client, one.request, otherSig, { nowSeconds: Math.floor(Date.now() / 1000) }).then(
      () => { throw new Error('a foreign signature was accepted'); },
      (e) => log(`  engine refusal (foreign key): ${e.message}`),
    );
    await evm
      .submitColdUserOpRequest(client, one.request, readFileSync([...filesToDelete].find((f) => f.includes('signature-')), 'utf8'), {
        nowSeconds: Number(one.request.expiresAt) + 1,
      })
      .then(
        () => { throw new Error('an expired request was accepted'); },
        (e) => log(`  engine refusal (expired): ${e.message}`),
      );
    if (captured.length !== before) throw new Error('a refused submission reached the bundler');
    log('\nDRY RUN PASSED: an operation prepared from the owner ADDRESS, signed in a separate process,');
    log('verified and simulated against the real EntryPoint v0.7 and Kernel v3.3 on Sepolia. Nothing was broadcast.');
    return;
  }

  // ---- LIVE ----
  if (process.env.COLD_USEROP_ONLY_WITHDRAW === '1') {
    await withdrawDeposit();
    return;
  }
  const devStart = await nodeClient.getBalance(recipient);
  const kStart = await nodeClient.getBalance(sender);
  log(`Start: dev EOA ${devStart} wei; Kernel ${kStart} wei; deposit ${await client.getEntryPointDeposit(sender)} wei`);

  const one = await coldOperation('op 1', [{ to: recipient, value: TRANSFER_WEI, data: new Uint8Array(0) }]);
  const r1 = await client.waitForReceipt(one.result.userOpHash, { timeoutMs: 240_000, pollMs: 5_000 });
  log(`  bundler receipt: success ${JSON.stringify(r1?.success)} actualGasCost ${BigInt(r1?.actualGasCost ?? 0)} tx ${r1?.receipt?.transactionHash}`);
  const b1 = await verifyBundle(r1.receipt.transactionHash, one.result.userOpHash, 'op 1');
  const code = await node('eth_getCode', [sender, 'latest']);
  log(`  account code after op 1: ${(code.length - 2) / 2} bytes`);
  for (const [name, t] of [['primary', node], ['second', second]]) {
    const after = await balanceAt(t, recipient, b1.blockNumber);
    const prior = await balanceAt(t, recipient, '0x' + (BigInt(b1.blockNumber) - 1n).toString(16));
    log(`  dev EOA balance delta at block ${BigInt(b1.blockNumber)} (${name}): ${after - prior} wei`);
  }

  // Op 2: sweep what can be swept. EntryPoint v0.7 asks the account for
  // requiredPrefund - deposit during validation, then runs the calls, then
  // credits prefund - actualGasCost back to the DEPOSIT (not the balance),
  // so the most the calls can send is balance - max(0, prefund - deposit).
  let amount = null;
  let sweep = null;
  for (let round = 1; round <= 3 && !sweep; round++) {
    const balance = await nodeClient.getBalance(sender);
    const deposit = await client.getEntryPointDeposit(sender);
    const fees = await quoteFees();
    const probe = await client.prepareUserOperationForExternalSigner(owner, [{ to: recipient, value: amount ?? balance / 2n, data: new Uint8Array(0) }], fees, {
      scheme: evm.KERNEL_V3_3_ECDSA_ROOT_SCHEME,
    });
    const need = evm.requiredPrefund(probe.userOp);
    const spare = balance - (need > deposit ? need - deposit : 0n);
    log(`op 2 sizing round ${round}: balance ${balance}, deposit ${deposit}, worst case ${need} → can send ${spare} wei`);
    if (spare <= 0n) break;
    if (amount === spare) {
      sweep = amount;
      break;
    }
    amount = spare;
  }
  if (amount && amount > 0n) {
    const two = await coldOperation('op 2 (sweep)', [{ to: recipient, value: amount, data: new Uint8Array(0) }]);
    const r2 = await client.waitForReceipt(two.result.userOpHash, { timeoutMs: 240_000, pollMs: 5_000 });
    log(`  bundler receipt: success ${JSON.stringify(r2?.success)} actualGasCost ${BigInt(r2?.actualGasCost ?? 0)} tx ${r2?.receipt?.transactionHash}`);
    await verifyBundle(r2.receipt.transactionHash, two.result.userOpHash, 'op 2');
  } else {
    log('op 2: nothing can be swept (the worst-case fee exceeds the balance).');
  }
  const kEnd = await nodeClient.getBalance(sender);
  const dEnd = await client.getEntryPointDeposit(sender);
  const devEnd = await nodeClient.getBalance(recipient);
  log(`After op 2: dev EOA ${devEnd} wei (Δ ${devEnd - devStart}); Kernel ${kEnd} wei; EntryPoint deposit ${dEnd} wei`);
  await withdrawDeposit();
  log('\nLIVE RUN PASSED.');

  /** Op 3: EntryPoint.withdrawTo(dev EOA, deposit - 2 × prefund), signed off-line like the others. */
  async function withdrawDeposit() {
    const withdrawCall = (amount) => ({
      to: evm.ENTRYPOINT_V07,
      value: 0n,
      data: evm.encodeFunctionCall('withdrawTo(address,uint256)', [
        { kind: 'address', value: recipient },
        { kind: 'uint256', value: amount },
      ]),
    });
    const deposit = await client.getEntryPointDeposit(sender);
    const probe = await client.prepareUserOperationForExternalSigner(owner, [withdrawCall(1n)], await quoteFees(), {
      scheme: evm.KERNEL_V3_3_ECDSA_ROOT_SCHEME,
    });
    const prefund = evm.requiredPrefund(probe.userOp);
    const amount = deposit - 2n * prefund;
    log(`op 3 sizing: deposit ${deposit} wei, prefund ${prefund} wei → withdraw ${amount} wei`);
    if (amount <= 0n) {
      log('op 3: the deposit is too small to withdraw anything after the fee; left as it is.');
      return;
    }
    const devBefore = await nodeClient.getBalance(recipient);
    const three = await coldOperation('op 3 (deposit withdrawal)', [withdrawCall(amount)]);
    const r3 = await client.waitForReceipt(three.result.userOpHash, { timeoutMs: 240_000, pollMs: 5_000 });
    log(`  bundler receipt: success ${JSON.stringify(r3?.success)} actualGasCost ${BigInt(r3?.actualGasCost ?? 0)} tx ${r3?.receipt?.transactionHash}`);
    const b3r = await verifyBundle(r3.receipt.transactionHash, three.result.userOpHash, 'op 3');
    for (const [name, t] of [['primary', node], ['second', second]]) {
      const after = await balanceAt(t, recipient, b3r.blockNumber);
      const prior = await balanceAt(t, recipient, '0x' + (BigInt(b3r.blockNumber) - 1n).toString(16));
      log(`  dev EOA balance delta at block ${BigInt(b3r.blockNumber)} (${name}): ${after - prior} wei`);
    }
    const devAfter = await nodeClient.getBalance(recipient);
    log(
      `End: dev EOA ${devAfter} wei (Δ ${devAfter - devBefore} for op 3); Kernel ${await nodeClient.getBalance(sender)} wei; ` +
        `EntryPoint deposit ${await client.getEntryPointDeposit(sender)} wei (dust left in the deposit)`,
    );
  }
}

main()
  .catch((e) => {
    console.error(mask(`cold-userop smoke failed: ${e?.message ?? e}`));
    process.exitCode = 1;
  })
  .finally(shredAll);
