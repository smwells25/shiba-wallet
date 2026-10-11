/**
 * Staking smoke test (phase 18 item 2; docs/STAKING.md). Test networks only.
 *
 * DRY RUN (default): for Ethereum Sepolia and Hoodi, and for two owners —
 * account 0 of the PUBLIC test mnemonic ("abandon … about") and account 0
 * of the dev mnemonic in .dev-wallet — it checks the pinned Lido (and, on
 * Hoodi, Rocket Pool) contracts on-chain with the engine readers, then runs
 * eth_simulateV1 against the REAL contracts with the calls the wallet
 * builds (packages/chains-evm/src/staking.ts):
 *   A  stake 0.01 ETH → stETH            (submit(address(0)))
 *   B  stake 0.01 ETH → wstETH           (a plain transfer to wstETH)
 *   C  stake, approve(wstETH, exact), wrap, unwrap (one simulated block)
 *   D  stake, approve(queue, exact), requestWithdrawals([x], owner)
 *      (expected to REVERT on Sepolia, whose queue is paused)
 *   E  Hoodi only: Rocket Pool deposit 0.01 ETH (the deposit pool resolved
 *      from RocketStorage), then in the NEXT simulated block an rETH burn
 *      (shows whether the deposit started the "deposit delay" lock)
 * When an owner holds less than 0.05 ETH on the network, its balance is
 * overridden IN THE SIMULATION ONLY (stateOverrides) and the output says so.
 * Nothing is signed or sent.
 *
 * LIVE legs (STAKING_LIVE), each through the APP'S OWN CODE
 * (app/src/wallet/staking.ts planStakingAction → prepareStakingSend →
 * send.ts sendEvm, the path the Staking screen uses), every hash re-read on
 * two more public endpoints:
 *   STAKING_LIVE=sepolia      Ethereum Sepolia: the dev EOA stakes 0.001
 *                             test ETH for stETH (no unstake: the queue is
 *                             paused there).
 *   STAKING_LIVE=hoodi        Hoodi, the full leg (phase 19 item 0b), dev
 *                             EOA only: Lido stake 0.1 → stETH; 0.05 →
 *                             wstETH (plain transfer); wrap 0.02 stETH
 *                             (exact approve, wrap) and unwrap 0.01 wstETH;
 *                             a withdrawal request of 0.03 stETH (exact
 *                             approve, requestWithdrawals); a Rocket Pool
 *                             deposit of 0.05 and an rETH burn of 0.02 at
 *                             once afterwards (finding F-72); the read-only
 *                             F-73 simulations (an rETH burn from addresses
 *                             that carry code); then polls the request every
 *                             STAKING_POLL_MINUTES (10) for at most
 *                             STAKING_FINALIZE_WAIT_MINUTES (90) and claims
 *                             it through the engine's claim flow if it is
 *                             finalised. Refuses to run twice unless
 *                             STAKING_REPEAT=1 (the record file says it ran).
 *   STAKING_LIVE=hoodi-claim  Claims the request left pending by the leg
 *                             above once Lido's oracle has finalised it
 *                             (prints the status and the next report's
 *                             estimated time otherwise).
 *   STAKING_LIVE=hoodi-f73    Only the read-only F-73 simulations.
 *   STAKING_LIVE=1            sepolia, then hoodi.
 * Values staked on Hoodi are capped at 1.5 ETH per run (HOODI_VALUE_CAP)
 * and each worst-case fee at 0.01 ETH. The Hoodi record is written,
 * public facts only, to scripts/testnet/runs/hoodi-staking-run.json
 * (git-ignored) after every step. STAKING_SKIP_DRY=1 skips the dry run.
 *
 * Run from the repository root after `npm run build`:
 *   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
 *   node scripts/testnet/staking-smoke.mjs
 *   STAKING_LIVE=hoodi node scripts/testnet/staking-smoke.mjs
 *
 * Secrets: the dev mnemonic is read from the git-ignored .dev-wallet and
 * never printed; addresses are printed shortened.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { ChainRegistry, HdKeyring, evmKeyProvider } from '../../packages/core/dist/index.js';
import * as E from '../../packages/chains-evm/dist/index.js';

const SEPOLIA = 'eip155:11155111';
const HOODI = 'eip155:560048';
const CHAINS = {
  [SEPOLIA]: {
    name: 'Ethereum Sepolia',
    id: 11155111n,
    rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
    second: 'https://eth-sepolia-testnet.api.pocket.network',
    explorer: 'https://sepolia.etherscan.io/tx/',
  },
  [HOODI]: {
    name: 'Hoodi',
    id: 560048n,
    rpc: 'https://ethereum-hoodi-rpc.publicnode.com',
    second: 'https://rpc.hoodi.ethpandaops.io',
    third: 'https://0xrpc.io/hoodi',
    explorer: 'https://hoodi.etherscan.io/tx/',
  },
};
const E18 = 10n ** 18n;
const STAKE = 10n ** 16n; // 0.01 ETH (Rocket Pool's minimum deposit on Hoodi)
const PUBLIC_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fmt = (wei) => {
  const s = wei.toString().padStart(19, '0');
  return `${s.slice(0, -18)}.${s.slice(-18)}`.replace(/\.?0+$/, '') || '0';
};
const hex = (n) => '0x' + n.toString(16);

const registry = new ChainRegistry();
registry.register(evmKeyProvider);
const owners = [{ label: 'public test mnemonic, account 0', signer: HdKeyring.fromMnemonic(PUBLIC_MNEMONIC, registry).getAccount('eip155:1') }];
const devPath = new URL('../../.dev-wallet/mnemonic.txt', import.meta.url);
let devSigner = null;
if (existsSync(devPath)) {
  devSigner = HdKeyring.fromMnemonic(readFileSync(devPath, 'utf8').trim(), registry).getAccount('eip155:1');
  owners.push({ label: 'dev owner (account 0 of .dev-wallet)', signer: devSigner });
} else {
  console.log('No .dev-wallet/mnemonic.txt: the dev owner is skipped.');
}

let failures = 0;
const expect = (ok, text) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${text}`);
  if (!ok) failures += 1;
};

/** eth_simulateV1 over several blocks, with an optional balance override in the first. */
async function simulate(node, blocks, override) {
  const payload = {
    blockStateCalls: blocks.map((calls, i) => ({
      ...(i === 0 && override ? { stateOverrides: { [override.address]: { balance: hex(override.balance) } } } : {}),
      calls: calls.map((c) => ({
        from: c.from,
        to: c.to,
        ...(c.value ? { value: hex(c.value) } : {}),
        ...(c.data && c.data.length > 0 ? { input: E.toHex(c.data) } : {}),
      })),
    })),
    traceTransfers: true,
  };
  const result = await node('eth_simulateV1', [payload, 'latest']);
  return result.map((block, i) => E.parseSimulationResult([block], blocks[i].length, blocks[i][0].from));
}

/** Simulated gas of call i (eth_simulateV1 reports the whole transaction's gas, intrinsic included). */
const gasOf = (diff, i) => (diff.calls[i]?.gasUsed !== undefined ? diff.calls[i].gasUsed.toString() : 'n/a');

const tokenIn = (diff, token) =>
  diff.changes.filter((c) => c.type === 'erc20' && c.direction === 'in' && c.token.toLowerCase() === token.toLowerCase()).reduce((a, c) => a + c.amount, 0n);

async function dryRun(caip2) {
  const chain = CHAINS[caip2];
  const node = E.httpTransport(chain.rpc);
  const chainId = BigInt(await node('eth_chainId', []));
  if (chainId !== chain.id) throw new Error(`${chain.rpc} answered chain id ${chainId}, expected ${chain.id}`);
  const block = BigInt(await node('eth_blockNumber', []));
  console.log(`\n=== ${chain.name} (block ${block}) — dry run`);
  const lido = E.LIDO_DEPLOYMENTS[caip2];
  const problems = await E.verifyLidoDeployment(node, lido);
  expect(problems.length === 0, `Lido deployment verified on-chain (symbols, wstETH.stETH(), locator.withdrawalQueue())${problems.length ? ': ' + problems.join(' ') : ''}`);
  const state = await E.readLidoState(node, lido);
  console.log(
    `  Lido: staking ${state.stakingPaused ? 'PAUSED' : 'open'}, stake limit ${fmt(state.currentStakeLimit)} ETH, queue ${state.queuePaused ? 'PAUSED' : 'open'}, ` +
      `requests ${state.lastRequestId} (finalized ${state.lastFinalizedRequestId}), oracle last report ${new Date(Number(state.oracleLastReportTime) * 1000).toISOString()}`,
  );
  let rocket = null;
  if (E.ROCKET_POOL_DEPLOYMENTS[caip2]) {
    const contracts = await E.resolveRocketPool(node, E.ROCKET_POOL_DEPLOYMENTS[caip2]);
    const rs = await E.readRocketPoolState(node, contracts);
    rocket = { contracts, state: rs };
    console.log(
      `  Rocket Pool: deposit pool ${contracts.depositPool} (from RocketStorage), deposits ${rs.depositEnabled ? 'enabled' : 'DISABLED'}, ` +
        `minimum ${fmt(rs.minimumDeposit)} ETH, fee ${fmt(rs.depositFee * 100n)}%, max deposit ${fmt(rs.maximumDepositAmount)} ETH, ` +
        `rate ${fmt(rs.exchangeRate)} ETH/rETH, collateral ${fmt(rs.totalCollateral)} ETH, deposit delay ${rs.depositDelayBlocks} blocks`,
    );
  }

  for (const { label, signer } of owners) {
    const who = signer.address;
    const balance = BigInt(await node('eth_getBalance', [who, 'latest']));
    const override = balance < 5n * STAKE ? { address: who, balance: E18 } : null;
    console.log(`  -- ${label} ${short(who)}: holds ${fmt(balance)} ETH${override ? ' (balance overridden to 1 ETH in the simulation only)' : ''}`);
    const at = (c) => ({ ...c, from: who });

    // A: stake → stETH.
    const [a] = await simulate(node, [[at(E.lidoStakeCall(lido, STAKE))]], override);
    const minted = tokenIn(a, lido.stETH);
    expect(a.ok && minted > 0n && minted <= STAKE && STAKE - minted <= 2n, `A stake 0.01 → stETH minted ${minted} wei (${STAKE - minted} wei below the ETH sent); simulated gas ${gasOf(a, 0)}`);

    // B: stake → wstETH (plain transfer).
    const [b] = await simulate(node, [[at(E.lidoStakeCall(lido, STAKE, 'wstETH'))]], override);
    expect(b.ok && tokenIn(b, lido.wstETH) > 0n, `B stake 0.01 → wstETH minted ${tokenIn(b, lido.wstETH)} (plain transfer, receive()); simulated gas ${gasOf(b, 0)}`);

    // C: stake, approve exact, wrap, unwrap.
    const half = STAKE / 2n;
    const [c] = await simulate(
      node,
      [[at(E.lidoStakeCall(lido, STAKE)), at(E.wstethWrapApproveCall(lido, half)), at(E.wstethWrapCall(lido, half)), at(E.wstethUnwrapCall(lido, half / 2n))]],
      override,
    );
    expect(c.ok, `C stake + approve(wstETH, ${half}) + wrap + unwrap: ${c.calls.map((x) => (x.ok ? 'ok' : `REVERT ${x.revertReason}`)).join(', ')}; simulated gas ${c.calls.map((_, i) => gasOf(c, i)).join(' / ')}`);

    // D: stake, approve exact, request a withdrawal.
    const [d] = await simulate(
      node,
      [[at(E.lidoStakeCall(lido, STAKE)), at(E.withdrawalApproveCall(lido, half)), at(E.requestWithdrawalCall(lido, half, who))]],
      override,
    );
    const request = d.calls[2];
    if (state.queuePaused) {
      // 0x14378398 = ResumedExpected() (lidofinance/core v4.0.1, contracts/0.8.9/utils/PausableUntil.sol line 23).
      const reason = /0x14378398/.test(request.revertReason ?? '') ? 'ResumedExpected() — the queue is paused' : request.revertReason ?? 'reverted';
      expect(!request.ok, `D withdrawal request REFUSED by the paused queue, as the app says: ${reason}`);
    } else {
      const nft = d.changes.find((x) => x.type === 'erc721' && x.direction === 'in' && x.token.toLowerCase() === lido.withdrawalQueue.toLowerCase());
      expect(d.ok && nft !== undefined, `D approve(queue, ${half}) + requestWithdrawals: request NFT ${nft ? `#${nft.tokenId}` : 'missing'} minted to the owner; simulated gas ${gasOf(d, 1)} / ${gasOf(d, 2)}`);
    }

    // Claim: what the wallet would claim for this owner now.
    if (!state.queuePaused) {
      const plan = await E.planLidoClaim(node, lido, who);
      console.log(`  claim: ${plan ? `${plan.requestIds.length} finalized request(s), ${fmt(plan.total)} ETH` : 'nothing finalized to claim'}`);
    }

    // E: Rocket Pool deposit, then a burn in the next block.
    if (rocket) {
      const deposit = E.rocketDepositCall(rocket.contracts.depositPool, STAKE);
      const { net } = E.rocketDepositSplit(STAKE, rocket.state.depositFee);
      const expected = await E.readRethValue(node, rocket.contracts.rETH, net);
      const burnAmount = expected / 2n;
      const [e1, e2] = await simulate(node, [[at(deposit)], [at(E.rethBurnCall(rocket.contracts.rETH, burnAmount))]], override);
      const rMinted = tokenIn(e1, rocket.contracts.rETH);
      expect(e1.ok && rMinted === expected, `E deposit 0.01 → rETH minted ${rMinted} (getRethValue(amount − fee) = ${expected}); simulated gas ${gasOf(e1, 0)}`);
      const lock = await E.readRethDepositLock(node, rocket.contracts.storage, who, rocket.state.depositDelayBlocks);
      const code = await node('eth_getCode', [who, 'latest']);
      const delegated = typeof code === 'string' && code.toLowerCase().startsWith('0xef0100') ? `0x${code.slice(8, 48)}` : null;
      console.log(
        `  rETH burn of ${burnAmount} in the next simulated block: ${e2.ok ? `SUCCEEDED (simulated gas ${gasOf(e2, 0)}) — this deposit did not start the deposit-delay lock` : `REVERTED (${e2.calls[0].revertReason})`}; ` +
          `stored user.deposit.block for this owner: ${lock.lastDepositBlock}` +
          (delegated
            ? `; this owner carries an EIP-7702 delegation to ${delegated}, and burn() pays with Solidity transfer() (a 2,300-gas stipend; line 148 of the deployed rETH's Sourcify-verified RocketTokenRETH.sol), which the delegate may not accept`
            : ''),
      );
    }
  }
}

async function receiptOf(node, hash) {
  for (let i = 0; i < 60; i++) {
    const r = await node('eth_getTransactionReceipt', [hash]);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 4000));
  }
  throw new Error(`No receipt for ${hash} after 4 minutes`);
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const host = (url) => new URL(url).host;
/** JSON with bigints as decimal strings. */
const toJson = (value) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);

/** Sepolia: one stake through the app's own glue, verified on a second endpoint (phase 18). */
async function liveAction(caip2, action, label) {
  const chain = CHAINS[caip2];
  const app = await import('../../app/src/wallet/staking.ts');
  const send = await import('../../app/src/wallet/send.ts');
  const node = E.httpTransport(chain.rpc);
  const plan = await app.planStakingAction(node, caip2, devSigner.address, action, 'test ETH');
  const quote = await app.prepareStakingSend(chain.rpc, devSigner.address, plan);
  if (quote.step !== 'main') throw new Error('Unexpected approval step for a stake.');
  if (!quote.quote.simulation.ok) throw new Error(`Pre-flight failed: ${quote.quote.simulation.reason}. Nothing was sent.`);
  console.log(`  ${label}: ${app.stakingSummaryLines(plan).join('; ')}; to ${quote.quote.to}; gas limit ${quote.quote.gasLimit}, worst-case fee ${quote.quote.fee} wei`);
  const second = E.httpTransport(chain.second);
  const token = plan.previewTokens.find((t) => t.symbol === plan.youReceive.symbol).address;
  const before = BigInt(await node('eth_call', [{ to: token, data: E.toHex(E.encodeErc20BalanceOf(devSigner.address)) }, 'latest']));
  const sent = await send.sendEvm(chain.rpc, devSigner, quote.quote, chain.explorer);
  console.log(`  sent: ${sent.txid} (${sent.explorerUrl})`);
  const receipt = await receiptOf(node, sent.txid);
  const r2 = await receiptOf(second, sent.txid);
  const blockNo = BigInt(r2.blockNumber);
  const mints = r2.logs.filter(
    (l) => l.address.toLowerCase() === token.toLowerCase() && l.topics[0] === E.TRANSFER_EVENT_TOPIC && BigInt(l.topics[1]) === 0n && BigInt(l.topics[2]) === BigInt(devSigner.address),
  );
  const minted = mints.reduce((a, l) => a + BigInt(l.data), 0n);
  const balAt = async (b) => BigInt(await second('eth_call', [{ to: token, data: E.toHex(E.encodeErc20BalanceOf(devSigner.address)) }, hex(b)]));
  const [pre, post] = [await balAt(blockNo - 1n), await balAt(blockNo)];
  console.log(
    `  receipt (${chain.second}): status ${r2.status}, block ${blockNo}, gas used ${BigInt(r2.gasUsed)}, effective price ${BigInt(r2.effectiveGasPrice)}; ` +
      `${plan.youReceive.symbol} minted (Transfer event) ${minted}; balance ${pre} → ${post} (delta ${post - pre}); balance read before sending ${before}`,
  );
  expect(receipt.status === '0x1' && r2.status === '0x1', `${label} succeeded (both endpoints agree on status)`);
  expect(minted > 0n, `${label}: ${plan.youReceive.symbol} minted to the dev EOA`);
  if (plan.youReceive.symbol === 'stETH') {
    const shares = async (b) => BigInt(await second('eth_call', [{ to: token, data: E.toHex(E.encodeFunctionCall('sharesOf(address)', [{ kind: 'address', value: devSigner.address }])) }, hex(b)]));
    console.log(`  stETH shares ${await shares(blockNo - 1n)} → ${await shares(blockNo)}`);
    expect(post - pre >= minted - 2n && post - pre <= minted, 'the balance delta equals the minted amount within the 1–2 wei share rounding');
  }
}

async function sepoliaLive() {
  console.log(`\n=== LIVE Ethereum Sepolia (dev EOA ${short(devSigner.address)})`);
  const sepBalance = BigInt(await E.httpTransport(CHAINS[SEPOLIA].rpc)('eth_getBalance', [devSigner.address, 'latest']));
  console.log(`  Sepolia balance ${fmt(sepBalance)} test ETH`);
  if (sepBalance < 2n * 10n ** 15n) throw new Error('The dev EOA holds less than 0.002 Sepolia ETH; nothing was sent.');
  await liveAction(SEPOLIA, { kind: 'stake', protocol: 'lido', receive: 'stETH', amount: 10n ** 15n }, 'Sepolia Lido stake 0.001');
}

// ---------------------------------------------------------------------------
// Hoodi, the full leg (phase 19 item 0b)
// ---------------------------------------------------------------------------

const RUN_FILE = new URL('./runs/hoodi-staking-run.json', import.meta.url);
const HOODI_VALUE_CAP = 15n * 10n ** 17n; // 1.5 ETH of stakes and deposits per run
const HOODI_FEE_CAP = 10n ** 16n; // refuse any quote whose worst-case fee exceeds 0.01 ETH
const AMOUNTS = {
  lidoStake: 10n ** 17n, // 0.1 → stETH
  wstStake: 5n * 10n ** 16n, // 0.05 → wstETH
  wrap: 2n * 10n ** 16n, // 0.02 stETH
  unwrap: 10n ** 16n, // 0.01 wstETH
  request: 3n * 10n ** 16n, // 0.03 stETH
  rpDeposit: 5n * 10n ** 16n, // 0.05 → rETH
  rpBurn: 2n * 10n ** 16n, // 0.02 rETH
};
/** The deposit pool RocketStorage named in phase 18 (AGENTS.md, phase 18 item 2). */
const RECORDED_DEPOSIT_POOL = '0x425E6f83e27f1676AD78BC39dA79C2C7b33d3Fd8';
/** The Sepolia gas figures on record (AGENTS.md phase 18): a first submit (new shares slot) and a later one. */
const SEPOLIA_SUBMIT_GAS = { first: 208421n, later: 110501n };
/** The ERC-1967 implementation slot (keccak256("eip1967.proxy.implementation") − 1). */
const ERC1967_IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
/** The emulator's Kernel v3.3 account on Sepolia (DEMO.md) — its proxy code is copied into a simulation for F-73. */
const SEPOLIA_KERNEL_ACCOUNT = '0xD31c2C54F21684eE2026a6C41e391130BdEeD8FA';

const topicOf = (sig) => '0x' + Buffer.from(keccak_256(utf8ToBytes(sig))).toString('hex');
/**
 * Event signatures the receipts are decoded with. A log is named only when
 * its topic0 equals the keccak of one of these, so a wrong signature shows
 * up as an unrecognised log rather than a misread one.
 */
const EVENT_SIGNATURES = [
  'Transfer(address,address,uint256)',
  'Approval(address,address,uint256)',
  'Submitted(address,uint256,address)',
  'TransferShares(address,address,uint256)',
  'SharesBurnt(address,uint256,uint256,uint256)',
  'WithdrawalRequested(uint256,address,address,uint256,uint256)',
  'WithdrawalClaimed(uint256,address,address,uint256)',
  'DepositReceived(address,uint256,uint256)',
  'TokensMinted(address,uint256,uint256,uint256)',
  'TokensBurned(address,uint256,uint256,uint256)',
  'EtherDeposited(address,uint256,uint256)',
  'EtherWithdrawn(string,address,uint256,uint256)',
];
const EVENT_BY_TOPIC = Object.fromEntries(EVENT_SIGNATURES.map((s) => [topicOf(s), s.slice(0, s.indexOf('('))]));

const lower = (a) => a.toLowerCase();
const topicAddr = (t) => '0x' + t.slice(26).toLowerCase();
const dataWords = (data) => (data.length > 2 ? data.slice(2).match(/.{64}/g).map((w) => BigInt('0x' + w)) : []);

/** Names each log by its topic0 and reads its indexed and data words. */
function decodeLogs(logs, labels) {
  return logs.map((l) => {
    const name = EVENT_BY_TOPIC[l.topics[0]] ?? null;
    return {
      contract: labels[lower(l.address)] ?? l.address,
      address: lower(l.address),
      event: name ?? `unrecognised ${l.topics[0]}`,
      indexed: l.topics.slice(1),
      data: dataWords(l.data),
    };
  });
}

async function uintAt(t, to, signature, args, block) {
  return BigInt(await t('eth_call', [{ to, data: E.toHex(E.encodeFunctionCall(signature, args)) }, block]));
}
const addrArg = (value) => ({ kind: 'address', value });
const uintArg = (value) => ({ kind: 'uint256', value });

/** Everything the leg can move for `who`, at `block` on transport `t`. */
async function holdings(t, lido, rETH, who, block) {
  const [eth, stETH, shares, wstETH, reth, allowWst, allowQueue] = await Promise.all([
    t('eth_getBalance', [who, block]).then(BigInt),
    uintAt(t, lido.stETH, 'balanceOf(address)', [addrArg(who)], block),
    uintAt(t, lido.stETH, 'sharesOf(address)', [addrArg(who)], block),
    uintAt(t, lido.wstETH, 'balanceOf(address)', [addrArg(who)], block),
    uintAt(t, rETH, 'balanceOf(address)', [addrArg(who)], block),
    uintAt(t, lido.stETH, 'allowance(address,address)', [addrArg(who), addrArg(lido.wstETH)], block),
    uintAt(t, lido.stETH, 'allowance(address,address)', [addrArg(who), addrArg(lido.withdrawalQueue)], block),
  ]);
  return { eth, stETH, shares, wstETH, rETH: reth, allowanceStethToWsteth: allowWst, allowanceStethToQueue: allowQueue };
}

function diffHoldings(pre, post) {
  return Object.fromEntries(Object.keys(pre).map((k) => [k, post[k] - pre[k]]));
}

/** The oracle's schedule: last processed reference slot and the next one (an estimate from HashConsensus). */
async function oracleSchedule(node, lido) {
  const view = async (to, sig) => node('eth_call', [{ to, data: E.toHex(E.encodeFunctionCall(sig, [])) }, 'latest']);
  const asAddr = (r) => '0x' + r.slice(26);
  const words = (r) => dataWords(r);
  const locator = asAddr(await view(lido.stETH, 'getLidoLocator()'));
  const oracle = asAddr(await view(locator, 'accountingOracle()'));
  const consensus = asAddr(await view(oracle, 'getConsensusContract()'));
  const [lastRef] = words(await view(oracle, 'getLastProcessingRefSlot()'));
  const [, secondsPerSlot, genesisTime] = words(await view(consensus, 'getChainConfig()'));
  const out = { accountingOracle: oracle, hashConsensus: consensus, lastProcessedRefSlot: lastRef, secondsPerSlot, genesisTime };
  out.lastProcessedRefSlotTime = new Date(Number(genesisTime + lastRef * secondsPerSlot) * 1000).toISOString();
  try {
    const [frameRef, deadlineSlot] = words(await view(consensus, 'getCurrentFrame()'));
    const [initialEpoch, epochsPerFrame] = words(await view(consensus, 'getFrameConfig()'));
    const frameSlots = epochsPerFrame * 32n;
    const nextRef = frameRef > lastRef ? frameRef : frameRef + frameSlots;
    Object.assign(out, {
      currentFrameRefSlot: frameRef,
      currentFrameDeadlineSlot: deadlineSlot,
      initialEpoch,
      epochsPerFrame,
      nextRefSlot: nextRef,
      nextRefSlotTime: new Date(Number(genesisTime + nextRef * secondsPerSlot) * 1000).toISOString(),
    });
  } catch (error) {
    out.frameReadError = String(error?.message ?? error).slice(0, 200);
  }
  return out;
}

function loadRun() {
  if (!existsSync(RUN_FILE)) return null;
  return JSON.parse(readFileSync(RUN_FILE, 'utf8'));
}
function saveRun(run) {
  mkdirSync(new URL('./runs/', import.meta.url), { recursive: true });
  run.updatedAt = new Date().toISOString();
  writeFileSync(RUN_FILE, toJson(run) + '\n');
}

/** Shared state of one Hoodi run. */
async function hoodiContext() {
  const chain = CHAINS[HOODI];
  const node = E.httpTransport(chain.rpc);
  const second = E.httpTransport(chain.second);
  const third = E.httpTransport(chain.third);
  for (const [url, t] of [[chain.rpc, node], [chain.second, second], [chain.third, third]]) {
    const id = BigInt(await t('eth_chainId', []));
    if (id !== chain.id) throw new Error(`${host(url)} answered chain id ${id}, expected ${chain.id}. Nothing was sent.`);
  }
  const lido = E.LIDO_DEPLOYMENTS[HOODI];
  const rocket = await E.resolveRocketPool(node, E.ROCKET_POOL_DEPLOYMENTS[HOODI]);
  const labels = {
    [lower(lido.stETH)]: 'Lido stETH',
    [lower(lido.wstETH)]: 'Lido wstETH',
    [lower(lido.withdrawalQueue)]: 'Lido withdrawal queue',
    [lower(rocket.depositPool)]: 'Rocket Pool deposit pool',
    [lower(rocket.rETH)]: 'Rocket Pool rETH',
    [lower(rocket.storage)]: 'RocketStorage',
    [lower(devSigner.address)]: 'dev EOA',
    '0x0000000000000000000000000000000000000000': 'zero address',
  };
  const app = await import('../../app/src/wallet/staking.ts');
  const send = await import('../../app/src/wallet/send.ts');
  return { chain, node, second, third, lido, rocket, labels, app, send, who: devSigner.address, valueSent: 0n };
}

/** Waits until the primary endpoint reports `nonce` as the account's latest nonce. */
async function waitNonce(ctx, nonce) {
  for (let i = 0; i < 30; i++) {
    const n = BigInt(await ctx.node('eth_getTransactionCount', [ctx.who, 'latest']));
    if (n >= nonce) return n;
    await sleep(2000);
  }
  throw new Error(`The primary endpoint still reports a nonce below ${nonce} after 60 s.`);
}

/**
 * Broadcasts one quote built by the app (sendEvm), waits for the receipt and
 * re-reads it, with the transaction, on the two other endpoints; reads the
 * holdings at block − 1 and block on the second endpoint.
 */
async function broadcast(ctx, quote, label, expectNonce) {
  if (!quote.simulation.ok) throw new Error(`${label}: the pre-flight eth_call failed (${quote.simulation.reason}). Nothing was sent.`);
  if (quote.chainId !== CHAINS[HOODI].id) throw new Error(`${label}: the quote is for chain ${quote.chainId}. Nothing was sent.`);
  if (quote.fee > HOODI_FEE_CAP) throw new Error(`${label}: worst-case fee ${quote.fee} wei is above the 0.01 ETH cap. Nothing was sent.`);
  if (ctx.valueSent + quote.amount > HOODI_VALUE_CAP) throw new Error(`${label}: would exceed the 1.5 ETH cap. Nothing was sent.`);
  if (quote.nonce !== expectNonce) throw new Error(`${label}: the quote's nonce ${quote.nonce} is not the expected ${expectNonce}. Nothing was sent.`);
  const sent = await ctx.send.sendEvm(ctx.chain.rpc, devSigner, quote, ctx.chain.explorer);
  ctx.valueSent += quote.amount;
  console.log(`  ${label}: sent ${sent.txid} (nonce ${quote.nonce}, gas limit ${quote.gasLimit}, max fee ${quote.maxFeePerGas}, tip ${quote.maxPriorityFeePerGas}, value ${quote.amount})`);
  const r1 = await receiptOf(ctx.node, sent.txid);
  const endpoints = [];
  for (const [url, t] of [[ctx.chain.rpc, ctx.node], [ctx.chain.second, ctx.second], [ctx.chain.third, ctx.third]]) {
    const [r, tx, client] = await Promise.all([receiptOf(t, sent.txid), t('eth_getTransactionByHash', [sent.txid]), t('web3_clientVersion', []).catch(() => 'unknown')]);
    endpoints.push({
      host: host(url),
      client: String(client).split('/').slice(0, 2).join('/'),
      status: r.status,
      block: BigInt(r.blockNumber),
      blockHash: r.blockHash,
      gasUsed: BigInt(r.gasUsed),
      effectiveGasPrice: BigInt(r.effectiveGasPrice),
      logs: r.logs.length,
      txFrom: lower(tx.from),
      txTo: lower(tx.to),
      txValue: BigInt(tx.value),
      txInputSelector: tx.input.slice(0, 10),
      txNonce: BigInt(tx.nonce),
    });
  }
  const e0 = endpoints[0];
  const agree = endpoints.every(
    (e) =>
      e.status === e0.status && e.block === e0.block && e.blockHash === e0.blockHash && e.gasUsed === e0.gasUsed && e.effectiveGasPrice === e0.effectiveGasPrice &&
      e.logs === e0.logs && e.txFrom === lower(ctx.who) && e.txTo === lower(quote.to) && e.txValue === quote.amount && e.txNonce === quote.nonce,
  );
  expect(agree, `${label}: the three endpoints (${endpoints.map((e) => `${e.host} ${e.client}`).join(', ')}) agree on status ${e0.status}, block ${e0.block}, gas used ${e0.gasUsed}, sender, target, value and nonce`);
  expect(e0.status === '0x1', `${label}: status 0x1`);
  const block = e0.block;
  const fee = e0.gasUsed * e0.effectiveGasPrice;
  const [pre, post] = await Promise.all([
    holdings(ctx.second, ctx.lido, ctx.rocket.rETH, ctx.who, hex(block - 1n)),
    holdings(ctx.second, ctx.lido, ctx.rocket.rETH, ctx.who, hex(block)),
  ]);
  const r2 = await receiptOf(ctx.second, sent.txid);
  const logs = decodeLogs(r2.logs, ctx.labels);
  await waitNonce(ctx, quote.nonce + 1n);
  return {
    label,
    hash: sent.txid,
    explorer: sent.explorerUrl,
    block,
    blockHash: e0.blockHash,
    status: e0.status,
    to: quote.to,
    value: quote.amount,
    inputSelector: e0.txInputSelector,
    nonce: quote.nonce,
    gasLimit: quote.gasLimit,
    gasUsed: e0.gasUsed,
    effectiveGasPrice: e0.effectiveGasPrice,
    fee,
    quotedWorstCaseFee: quote.fee,
    endpoints,
    logs,
    pre,
    post,
    delta: diffHoldings(pre, post),
  };
}

/** Plans an action with the app's planStakingAction and sends it (exact approval first when the plan needs one). */
async function runAction(ctx, action, label) {
  const plan = await ctx.app.planStakingAction(ctx.node, HOODI, ctx.who, action, 'test ETH');
  console.log(`\n  -- ${label}: ${ctx.app.stakingSummaryLines(plan).join('; ')} (contract: ${plan.contractLabel})`);
  for (const n of plan.notes) console.log(`     note: ${n}`);
  let nonce = BigInt(await ctx.node('eth_getTransactionCount', [ctx.who, 'latest']));
  const pending = BigInt(await ctx.node('eth_getTransactionCount', [ctx.who, 'pending']));
  if (pending !== nonce) throw new Error(`${label}: the dev EOA has ${pending - nonce} pending transaction(s). Nothing was sent.`);
  let q = await ctx.app.prepareStakingSend(ctx.chain.rpc, ctx.who, plan);
  const out = { label, action, summary: ctx.app.stakingSummaryLines(plan), plan: { youSend: plan.youSend, youReceive: plan.youReceive, approval: plan.approval, contract: plan.main.to } };
  if (q.step === 'approve') {
    if (lower(q.quote.to) !== lower(plan.approval.token) || q.quote.amount !== 0n) throw new Error(`${label}: the approval quote is not the plan's token approval. Nothing was sent.`);
    out.approve = await broadcast(ctx, q.quote, `${label} — exact approve`, nonce);
    nonce += 1n;
    for (let i = 0; i < 10; i++) {
      q = await ctx.app.prepareStakingSend(ctx.chain.rpc, ctx.who, plan);
      if (q.step === 'main') break;
      await sleep(3000);
    }
  }
  if (q.step !== 'main') throw new Error(`${label}: the approval is still not visible to the primary endpoint. Stopped.`);
  if (lower(q.quote.to) !== lower(plan.main.to) || q.quote.amount !== plan.main.value) throw new Error(`${label}: the quote differs from the plan's call. Nothing was sent.`);
  out.main = await broadcast(ctx, q.quote, label, nonce);
  out.planObject = plan;
  return out;
}

const findLog = (step, contract, event, pred = () => true) => step.logs.filter((l) => l.address === lower(contract) && l.event === event && pred(l));
const isAddr = (t, a) => topicAddr(t) === lower(a);
const ZERO = '0x0000000000000000000000000000000000000000';

function reportStep(step) {
  console.log(
    `     ${step.label}: block ${step.block}, status ${step.status}, gas used ${step.gasUsed} of ${step.gasLimit}, effective price ${step.effectiveGasPrice} wei, fee ${step.fee} wei (quoted worst case ${step.quotedWorstCaseFee})`,
  );
  for (const l of step.logs) console.log(`       log ${l.contract}: ${l.event} [${l.indexed.map((t) => (t.length === 66 && /^0x0{24}/.test(t) ? topicAddr(t) : BigInt(t).toString())).join(', ')}] (${l.data.join(', ')})`);
  const d = Object.entries(step.delta).filter(([, v]) => v !== 0n);
  console.log(`       holdings delta (block − 1 → block, ${host(CHAINS[HOODI].second)}): ${d.map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
}

/** The read-only F-73 simulations: an rETH burn from addresses carrying code. Nothing is sent. */
async function f73Simulations(ctx, holder, amount) {
  console.log(`\n  -- F-73 (read-only): burn(${amount}) on rETH from ${short(holder)} with its code overridden in the call`);
  const sep = E.httpTransport(CHAINS[SEPOLIA].rpc);
  const [proxyCode, implWord] = await Promise.all([
    sep('eth_getCode', [SEPOLIA_KERNEL_ACCOUNT, 'latest']),
    sep('eth_getStorageAt', [SEPOLIA_KERNEL_ACCOUNT, ERC1967_IMPL_SLOT, 'latest']),
  ]);
  const impl = '0x' + implWord.slice(26);
  const implCode = await sep('eth_getCode', [impl, 'latest']);
  const hoodiImplCode = await ctx.node('eth_getCode', [impl, 'latest']);
  // The delegate of account 0 of the public test mnemonic on Hoodi (read in the dry run).
  const pub = owners[0].signer.address;
  const pubCode = await ctx.node('eth_getCode', [pub, 'latest']);
  const sweeper = /^0xef0100/i.test(pubCode) ? '0x' + pubCode.slice(8, 48) : null;
  const variants = [
    { name: 'no override (the plain EOA, control)', overrides: null },
    { name: 'code 0x00 (STOP: accepts ETH, uses no gas)', overrides: { [holder]: { code: '0x00' } } },
    { name: 'code PUSH0 PUSH0 LOG0 STOP (an event on receipt, ~400 gas)', overrides: { [holder]: { code: '0x5f5fa000' } } },
    { name: 'code CALLVALUE PUSH0 SSTORE STOP (writes storage on receipt)', overrides: { [holder]: { code: '0x345f5500' } } },
    ...(sweeper
      ? [{ name: `EIP-7702 designator to ${sweeper} (the delegate of the public test account on Hoodi; it forwards received ETH with a CALL)`, overrides: { [holder]: { code: `0xef0100${sweeper.slice(2)}` } } }]
      : []),
    {
      name: `EIP-7702 designator to the Kernel v3.3 implementation ${short(impl)} (its code copied from Sepolia; Hoodi has ${hoodiImplCode === '0x' ? 'none' : 'code'} there)`,
      overrides: { [holder]: { code: `0xef0100${impl.slice(2)}` }, [impl]: { code: implCode } },
    },
    {
      name: `a Kernel v3.3 account: the ERC-1967 proxy code of ${short(SEPOLIA_KERNEL_ACCOUNT)} on Sepolia (${(proxyCode.length - 2) / 2} bytes) with its implementation slot, the implementation copied from Sepolia`,
      overrides: { [holder]: { code: proxyCode, stateDiff: { [ERC1967_IMPL_SLOT]: implWord } }, [impl]: { code: implCode } },
    },
  ];
  const call = { from: holder, to: ctx.rocket.rETH, data: E.toHex(E.encodeRethBurn(amount)) };
  const ethValue = await E.readRethEthValue(ctx.node, ctx.rocket.rETH, amount);
  const results = [];
  for (const v of variants) {
    const row = { variant: v.name, endpoints: {} };
    for (const [url, t] of [[CHAINS[HOODI].rpc, ctx.node], [CHAINS[HOODI].second, ctx.second]]) {
      try {
        const r = await t('eth_call', v.overrides ? [call, 'latest', v.overrides] : [call, 'latest']);
        row.endpoints[host(url)] = { ok: true, result: r };
      } catch (error) {
        row.endpoints[host(url)] = { ok: false, error: String(error?.message ?? error).slice(0, 200) };
      }
    }
    // The payout call itself, from a call trace (served by the erigon endpoint only).
    try {
      const trace = await ctx.second('debug_traceCall', [call, 'latest', { tracer: 'callTracer', ...(v.overrides ? { stateOverrides: v.overrides } : {}) }]);
      const flat = [];
      const walk = (n, depth) => {
        flat.push({ depth, type: n.type, from: lower(n.from), to: lower(n.to), value: n.value ? BigInt(n.value) : 0n, gas: BigInt(n.gas ?? '0x0'), gasUsed: BigInt(n.gasUsed ?? '0x0'), error: n.error ?? null });
        for (const c of n.calls ?? []) walk(c, depth + 1);
      };
      walk(trace, 0);
      const payout = flat.find((f) => f.depth > 0 && f.to === lower(holder) && f.value > 0n);
      row.trace = { topError: trace.error ?? null, payout: payout ?? null, innerFromHolder: flat.filter((f) => f.from === lower(holder) && f.depth > 0) };
    } catch (error) {
      row.trace = { unavailable: String(error?.message ?? error).slice(0, 200) };
    }
    const okAll = Object.values(row.endpoints).map((e) => e.ok);
    console.log(
      `     ${v.name}: ${okAll.every(Boolean) ? 'SUCCEEDS' : okAll.some(Boolean) ? 'ENDPOINTS DISAGREE' : 'REVERTS'} (${Object.entries(row.endpoints)
        .map(([h, e]) => `${h}: ${e.ok ? 'ok' : e.error}`)
        .join('; ')})` +
        (row.trace?.payout
          ? `; trace: payout ${row.trace.payout.type} of ${row.trace.payout.value} wei with gas ${row.trace.payout.gas}, used ${row.trace.payout.gasUsed}${row.trace.payout.error ? `, error "${row.trace.payout.error}"` : ''}` +
            (row.trace.innerFromHolder.length ? `; inner calls from the holder: ${row.trace.innerFromHolder.map((f) => `${f.type} to ${short(f.to)} value ${f.value} gas ${f.gas}${f.error ? ` error "${f.error}"` : ''}`).join(', ')}` : '')
          : row.trace?.unavailable
            ? `; trace unavailable: ${row.trace.unavailable}`
            : '; trace: no payout call found'),
    );
    results.push(row);
  }
  // A real deployed contract as the holder (wstETH: its receive() stakes the ETH it gets), via eth_simulateV1:
  // block 1 deposits 0.01 into Rocket Pool from it, block 2 burns half the rETH.
  let realContract = null;
  try {
    const rs = await E.readRocketPoolState(ctx.node, ctx.rocket);
    const { net } = E.rocketDepositSplit(STAKE, rs.depositFee);
    const minted = await E.readRethValue(ctx.node, ctx.rocket.rETH, net);
    const from = ctx.lido.wstETH;
    const blocks = [[{ ...E.rocketDepositCall(ctx.rocket.depositPool, STAKE), from }], [{ ...E.rethBurnCall(ctx.rocket.rETH, minted / 2n), from }]];
    const [d1, d2] = await simulate(ctx.node, blocks, { address: from, balance: E18 });
    realContract = { holder: from, deposit: d1.calls[0], burn: d2.calls[0] };
    console.log(
      `     a deployed contract (Lido wstETH ${short(from)}, whose receive() stakes incoming ETH) as the holder, eth_simulateV1: deposit ${d1.calls[0].ok ? 'ok' : `REVERTED ${d1.calls[0].revertReason}`}, burn ${d2.calls[0].ok ? 'ok' : `REVERTED ${d2.calls[0].revertReason ?? ''}`}`,
    );
  } catch (error) {
    realContract = { error: String(error?.message ?? error).slice(0, 200) };
    console.log(`     a deployed contract as the holder: simulation not possible (${realContract.error})`);
  }
  return { holder, amount, ethValueOfBurn: ethValue, kernelImplementation: impl, sweeperDelegate: sweeper, results, realContract };
}

/** Polls the request until finalised (or the window ends); claims through the engine's flow if it is. */
async function pollAndClaim(ctx, run, waitMinutes, pollMinutes) {
  const id = BigInt(run.pending.requestId);
  const deadline = Date.now() + waitMinutes * 60_000;
  run.pending.polls = run.pending.polls ?? [];
  for (;;) {
    const statuses = await E.readLidoWithdrawalRequests(ctx.node, ctx.lido, ctx.who);
    const mine = statuses.find((s) => s.requestId === id);
    const state = await E.readLidoState(ctx.node, ctx.lido);
    const poll = {
      at: new Date().toISOString(),
      isFinalized: mine?.isFinalized ?? null,
      isClaimed: mine?.isClaimed ?? null,
      lastRequestId: state.lastRequestId,
      lastFinalizedRequestId: state.lastFinalizedRequestId,
      oracleLastRefSlotTime: new Date(Number(state.oracleLastReportTime) * 1000).toISOString(),
    };
    run.pending.polls.push(poll);
    saveRun(run);
    console.log(`  poll ${poll.at}: request ${id} finalized ${poll.isFinalized}, claimed ${poll.isClaimed}; queue last ${poll.lastRequestId}, last finalized ${poll.lastFinalizedRequestId}; oracle last ref slot time ${poll.oracleLastRefSlotTime}`);
    if (mine === undefined) {
      console.log('  The request is no longer among the dev EOA\'s open requests (claimed or transferred). Stopped.');
      return false;
    }
    if (mine.isFinalized) break;
    if (Date.now() >= deadline) {
      run.pending.oracle = await oracleSchedule(ctx.node, ctx.lido);
      run.pending.status = 'not finalised within the window';
      saveRun(run);
      console.log(
        `  Not finalised within ${waitMinutes} minutes. Next report's reference slot (estimate): ${run.pending.oracle.nextRefSlotTime ?? 'unknown'}. ` +
          `The claim leg is left pending: request ${id}; run STAKING_LIVE=hoodi-claim after the next report.`,
      );
      return false;
    }
    await sleep(Math.max(0, Math.min(pollMinutes * 60_000, deadline - Date.now())));
  }
  // Claim.
  const step = await runAction(ctx, { kind: 'claim' }, `Lido claim of request ${id}`);
  const claim = step.planObject.claim;
  reportStep(step.main);
  const claimedLogs = findLog(step.main, ctx.lido.withdrawalQueue, 'WithdrawalClaimed');
  const paid = claimedLogs.reduce((a, l) => a + l.data[0], 0n);
  expect(claim.requestIds.length === 1 && claim.requestIds[0] === id, `the engine's claim plan names exactly request ${id} (hints ${claim.hints.join(', ')}, last checkpoint ${claim.lastCheckpointIndex})`);
  expect(claimedLogs.length === 1 && BigInt(claimedLogs[0].indexed[0]) === id && isAddr(claimedLogs[0].indexed[1], ctx.who) && isAddr(claimedLogs[0].indexed[2], ctx.who), 'WithdrawalClaimed(request, owner = receiver = dev EOA)');
  expect(paid === claim.total, `WithdrawalClaimed amount ${paid} = getClaimableEther ${claim.total}`);
  expect(step.main.delta.eth === claim.total - step.main.fee, `ETH delta ${step.main.delta.eth} = claimable ${claim.total} − fee ${step.main.fee}`);
  run.claim = { ...step.main, hints: claim.hints, claimable: claim.claimable, lastCheckpointIndex: claim.lastCheckpointIndex, paid };
  run.pending.status = 'claimed';
  saveRun(run);
  return true;
}

async function hoodiLive() {
  const previous = loadRun();
  if (previous?.leg && process.env.STAKING_REPEAT !== '1') {
    throw new Error(`${RUN_FILE.pathname} already records a Hoodi leg (${previous.leg.status}). Set STAKING_REPEAT=1 to run it again, or STAKING_LIVE=hoodi-claim to claim. Nothing was sent.`);
  }
  const ctx = await hoodiContext();
  const { lido, rocket, who } = ctx;
  console.log(`\n=== LIVE Hoodi, the full staking leg (dev EOA ${short(who)})`);
  const startBlock = BigInt(await ctx.node('eth_blockNumber', []));
  const before = await holdings(ctx.second, lido, rocket.rETH, who, hex(startBlock));
  console.log(`  before (block ${startBlock}): ${Object.entries(before).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  const needed = AMOUNTS.lidoStake + AMOUNTS.wstStake + AMOUNTS.rpDeposit; // the ETH the leg stakes or deposits
  if (needed > HOODI_VALUE_CAP) throw new Error('The leg’s amounts exceed the 1.5 ETH cap. Nothing was sent.');
  if (before.eth < needed + 10n ** 17n) throw new Error(`The dev EOA holds ${fmt(before.eth)} Hoodi ETH; the leg needs ${fmt(needed)} plus 0.1 for fees. Nothing was sent.`);
  const run = {
    startedAt: new Date().toISOString(),
    network: { caip2: HOODI, chainId: CHAINS[HOODI].id, endpoints: [host(CHAINS[HOODI].rpc), host(CHAINS[HOODI].second), host(CHAINS[HOODI].third)] },
    devEoa: who,
    contracts: { stETH: lido.stETH, wstETH: lido.wstETH, withdrawalQueue: lido.withdrawalQueue, rocketStorage: rocket.storage, rETH: rocket.rETH, depositPool: rocket.depositPool },
    amounts: AMOUNTS,
    fundsBefore: { block: startBlock, ...before },
    leg: { status: 'in progress' },
    steps: [],
  };
  saveRun(run);
  const lidoProblems = await E.verifyLidoDeployment(ctx.node, lido);
  expect(lidoProblems.length === 0, `Lido on Hoodi verified on-chain before sending${lidoProblems.length ? ': ' + lidoProblems.join(' ') : ''}`);
  if (lidoProblems.length) throw new Error('Lido verification failed. Nothing was sent.');
  const record = (s) => {
    const { planObject, ...rest } = s;
    run.steps.push(rest);
    saveRun(run);
  };
  const at = (step, sig, args) => uintAt(ctx.second, ...sig, args, hex(step.block - 1n));

  // (1) Lido stake 0.1 → stETH.
  const s1 = await runAction(ctx, { kind: 'stake', protocol: 'lido', receive: 'stETH', amount: AMOUNTS.lidoStake }, 'Lido stake 0.1 → stETH');
  reportStep(s1.main);
  {
    const m = s1.main;
    const submitted = findLog(m, lido.stETH, 'Submitted');
    const mint = findLog(m, lido.stETH, 'Transfer', (l) => isAddr(l.indexed[0], ZERO) && isAddr(l.indexed[1], who));
    const shares = findLog(m, lido.stETH, 'TransferShares', (l) => isAddr(l.indexed[0], ZERO) && isAddr(l.indexed[1], who));
    const minted = mint[0]?.data[0] ?? 0n;
    const sharesMinted = shares[0]?.data[0] ?? 0n;
    const expectedShares = await at(m, [lido.stETH, 'getSharesByPooledEth(uint256)'], [uintArg(AMOUNTS.lidoStake)]);
    expect(submitted.length === 1 && isAddr(submitted[0].indexed[0], who) && submitted[0].data[0] === AMOUNTS.lidoStake && submitted[0].data[1] === 0n, `Submitted(sender = dev EOA, amount ${submitted[0]?.data[0]}, referral ${submitted[0]?.data[1]})`);
    expect(minted <= AMOUNTS.lidoStake && AMOUNTS.lidoStake - minted <= 2n, `stETH minted (Transfer from 0) ${minted} = 0.1 ETH − ${AMOUNTS.lidoStake - minted} wei`);
    expect(sharesMinted === expectedShares, `TransferShares ${sharesMinted} = getSharesByPooledEth(0.1 ETH) at block − 1 (${expectedShares})`);
    expect(m.delta.shares === sharesMinted, `sharesOf delta ${m.delta.shares} = the shares minted`);
    expect(m.delta.stETH >= minted - 2n && m.delta.stETH <= minted + 2n, `stETH balance delta ${m.delta.stETH} vs the Transfer event ${minted} (difference ${m.delta.stETH - minted} wei)`);
    expect(m.delta.eth === -AMOUNTS.lidoStake - m.fee, `ETH delta ${m.delta.eth} = −0.1 ETH − fee ${m.fee}`);
    console.log(`     gas: ${m.gasUsed} on Hoodi vs Sepolia ${SEPOLIA_SUBMIT_GAS.first} (first stake, a new shares slot) / ${SEPOLIA_SUBMIT_GAS.later} (a later stake); the dev EOA's shares before this stake: ${m.pre.shares}`);
    s1.checks = { minted, sharesMinted, expectedShares, shortfallWei: AMOUNTS.lidoStake - minted, balanceDeltaVsEvent: m.delta.stETH - minted, firstStakeOnHoodi: m.pre.shares === 0n };
  }
  record(s1);

  // (2) 0.05 → wstETH by a plain transfer to the wstETH contract.
  const s2 = await runAction(ctx, { kind: 'stake', protocol: 'lido', receive: 'wstETH', amount: AMOUNTS.wstStake }, 'Lido stake 0.05 → wstETH (plain transfer)');
  reportStep(s2.main);
  {
    const m = s2.main;
    const mint = findLog(m, lido.wstETH, 'Transfer', (l) => isAddr(l.indexed[0], ZERO) && isAddr(l.indexed[1], who));
    const minted = mint[0]?.data[0] ?? 0n;
    const expected = await at(m, [lido.wstETH, 'getWstETHByStETH(uint256)'], [uintArg(AMOUNTS.wstStake)]);
    const submitted = findLog(m, lido.stETH, 'Submitted');
    expect(m.inputSelector === '0x', `the transaction carries no calldata (a plain transfer to wstETH; input "${m.inputSelector}")`);
    expect(submitted.length === 1 && isAddr(submitted[0].indexed[0], lido.wstETH) && submitted[0].data[0] === AMOUNTS.wstStake, 'Submitted(sender = the wstETH contract, amount 0.05 ETH)');
    expect(minted === expected, `wstETH minted ${minted} = getWstETHByStETH(0.05 ETH) at block − 1 (${expected})`);
    expect(m.delta.wstETH === minted && m.delta.stETH === 0n, `wstETH delta ${m.delta.wstETH}, stETH delta ${m.delta.stETH}`);
    expect(m.delta.eth === -AMOUNTS.wstStake - m.fee, `ETH delta ${m.delta.eth} = −0.05 ETH − fee ${m.fee}`);
    s2.checks = { minted, expected };
  }
  record(s2);

  // (3) wrap 0.02 stETH (exact approve, then wrap), unwrap 0.01 wstETH.
  const s3 = await runAction(ctx, { kind: 'wrap', amount: AMOUNTS.wrap }, 'Lido wrap 0.02 stETH');
  if (!s3.approve) expect(false, 'the wrap needed an exact approval first (none was sent: an allowance already existed)');
  else {
    reportStep(s3.approve);
    const ap = findLog(s3.approve, lido.stETH, 'Approval');
    expect(ap.length === 1 && isAddr(ap[0].indexed[0], who) && isAddr(ap[0].indexed[1], lido.wstETH) && ap[0].data[0] === AMOUNTS.wrap, `Approval(dev EOA, wstETH, ${ap[0]?.data[0]}) — exactly 0.02 stETH`);
    expect(s3.approve.post.allowanceStethToWsteth === AMOUNTS.wrap, `allowance after the approve ${s3.approve.post.allowanceStethToWsteth}`);
    expect(s3.approve.delta.eth === -s3.approve.fee, `ETH delta ${s3.approve.delta.eth} = −fee`);
  }
  reportStep(s3.main);
  {
    const m = s3.main;
    const mint = findLog(m, lido.wstETH, 'Transfer', (l) => isAddr(l.indexed[0], ZERO) && isAddr(l.indexed[1], who));
    const moved = findLog(m, lido.stETH, 'Transfer', (l) => isAddr(l.indexed[0], who) && isAddr(l.indexed[1], lido.wstETH));
    const minted = mint[0]?.data[0] ?? 0n;
    const expected = await at(m, [lido.wstETH, 'getWstETHByStETH(uint256)'], [uintArg(AMOUNTS.wrap)]);
    expect(moved.length === 1 && moved[0].data[0] === AMOUNTS.wrap, `stETH Transfer(dev EOA → wstETH) ${moved[0]?.data[0]}`);
    expect(minted === expected, `wstETH minted ${minted} = getWstETHByStETH(0.02) at block − 1 (${expected})`);
    expect(m.post.allowanceStethToWsteth === 0n, `allowance stETH → wstETH afterwards ${m.post.allowanceStethToWsteth}`);
    expect(m.delta.wstETH === minted, `wstETH delta ${m.delta.wstETH}`);
    expect(m.delta.stETH <= -AMOUNTS.wrap + 2n && m.delta.stETH >= -AMOUNTS.wrap - 2n, `stETH delta ${m.delta.stETH} (−0.02 within 2 wei; difference ${m.delta.stETH + AMOUNTS.wrap})`);
    expect(m.delta.eth === -m.fee, `ETH delta ${m.delta.eth} = −fee`);
    s3.checks = { minted, expected };
  }
  record(s3);
  const s3b = await runAction(ctx, { kind: 'unwrap', amount: AMOUNTS.unwrap }, 'Lido unwrap 0.01 wstETH');
  reportStep(s3b.main);
  {
    const m = s3b.main;
    const burn = findLog(m, lido.wstETH, 'Transfer', (l) => isAddr(l.indexed[0], who) && isAddr(l.indexed[1], ZERO));
    const paid = findLog(m, lido.stETH, 'Transfer', (l) => isAddr(l.indexed[0], lido.wstETH) && isAddr(l.indexed[1], who));
    const expected = await at(m, [lido.wstETH, 'getStETHByWstETH(uint256)'], [uintArg(AMOUNTS.unwrap)]);
    expect(burn.length === 1 && burn[0].data[0] === AMOUNTS.unwrap, `wstETH burnt (Transfer to 0) ${burn[0]?.data[0]}`);
    expect(paid.length === 1 && paid[0].data[0] === expected, `stETH paid (Transfer wstETH → dev EOA) ${paid[0]?.data[0]} = getStETHByWstETH(0.01) at block − 1 (${expected})`);
    expect(m.delta.wstETH === -AMOUNTS.unwrap, `wstETH delta ${m.delta.wstETH}`);
    expect(m.delta.stETH >= expected - 2n && m.delta.stETH <= expected + 2n, `stETH delta ${m.delta.stETH} vs the event (difference ${m.delta.stETH - expected})`);
    expect(m.delta.eth === -m.fee, `ETH delta ${m.delta.eth} = −fee`);
    s3b.checks = { stEthPaid: paid[0]?.data[0], expected };
  }
  record(s3b);

  // (4) withdrawal request of 0.03 stETH.
  const s4 = await runAction(ctx, { kind: 'unstake', amount: AMOUNTS.request }, 'Lido withdrawal request 0.03 stETH');
  if (s4.approve) {
    reportStep(s4.approve);
    const ap = findLog(s4.approve, lido.stETH, 'Approval');
    expect(ap.length === 1 && isAddr(ap[0].indexed[1], lido.withdrawalQueue) && ap[0].data[0] === AMOUNTS.request, `Approval(dev EOA, queue, ${ap[0]?.data[0]}) — exactly 0.03 stETH`);
  } else expect(false, 'the request needed an exact approval first (none was sent)');
  reportStep(s4.main);
  let requestId = null;
  {
    const m = s4.main;
    const req = findLog(m, lido.withdrawalQueue, 'WithdrawalRequested');
    const nft = findLog(m, lido.withdrawalQueue, 'Transfer', (l) => l.indexed.length === 3 && isAddr(l.indexed[0], ZERO) && isAddr(l.indexed[1], who));
    requestId = req.length === 1 ? BigInt(req[0].indexed[0]) : null;
    expect(req.length === 1 && isAddr(req[0].indexed[1], who) && isAddr(req[0].indexed[2], who) && req[0].data[0] === AMOUNTS.request, `WithdrawalRequested(id ${requestId}, requestor = owner = dev EOA, ${req[0]?.data[0]} stETH, ${req[0]?.data[1]} shares)`);
    expect(nft.length === 1 && BigInt(nft[0].indexed[2]) === requestId, `request NFT #${requestId} minted to the dev EOA (ERC-721 Transfer)`);
    expect(m.post.allowanceStethToQueue === 0n, `allowance stETH → queue afterwards ${m.post.allowanceStethToQueue}`);
    expect(m.delta.stETH <= -AMOUNTS.request + 2n && m.delta.stETH >= -AMOUNTS.request - 2n, `stETH delta ${m.delta.stETH} (difference ${m.delta.stETH + AMOUNTS.request})`);
    const statuses = await E.readLidoWithdrawalRequests(ctx.node, lido, who);
    const st = statuses.find((x) => x.requestId === requestId);
    const state = await E.readLidoState(ctx.node, lido);
    const schedule = await oracleSchedule(ctx.node, lido);
    console.log(
      `     getWithdrawalStatus(${requestId}): ${st ? `stETH ${st.amountOfStETH}, shares ${st.amountOfShares}, owner ${short(st.owner)}, timestamp ${new Date(Number(st.timestamp) * 1000).toISOString()}, finalized ${st.isFinalized}, claimed ${st.isClaimed}` : 'missing'}; ` +
        `queue last ${state.lastRequestId}, last finalized ${state.lastFinalizedRequestId}; oracle last processed ref slot ${schedule.lastProcessedRefSlot} (${schedule.lastProcessedRefSlotTime}); next ref slot (estimate) ${schedule.nextRefSlot ?? '?'} (${schedule.nextRefSlotTime ?? schedule.frameReadError})`,
    );
    s4.checks = { requestId, status: st ?? null, lastRequestId: state.lastRequestId, lastFinalizedRequestId: state.lastFinalizedRequestId, oracle: schedule };
    run.pending = { requestId, owner: who, amountOfStETH: st?.amountOfStETH, amountOfShares: st?.amountOfShares, requestedAt: st ? new Date(Number(st.timestamp) * 1000).toISOString() : null, status: 'waiting for finalisation' };
  }
  record(s4);

  // (5) Rocket Pool deposit 0.05 → rETH, then a burn of 0.02 at once.
  const rs = await E.readRocketPoolState(ctx.node, rocket);
  const settingsView = async (to, sig) => uintAt(ctx.node, to, sig, [], 'latest').then((v) => v, (e) => `unreadable (${String(e?.message ?? e).slice(0, 80)})`);
  const extra = {
    depositPoolBalance: await settingsView(rocket.depositPool, 'getBalance()'),
    maximumDepositPoolSize: await settingsView(rocket.settingsDeposit, 'getMaximumDepositPoolSize()'),
  };
  const lockBefore = await E.readRethDepositLock(ctx.node, rocket.storage, who, rs.depositDelayBlocks);
  console.log(
    `\n  Rocket Pool (read just now): deposit pool ${rocket.depositPool} from RocketStorage (${lower(rocket.depositPool) === lower(RECORDED_DEPOSIT_POOL) ? 'the same as recorded in phase 18' : `DIFFERENT from ${RECORDED_DEPOSIT_POOL} recorded in phase 18`}); ` +
      `deposits ${rs.depositEnabled ? 'enabled' : 'DISABLED'}, minimum ${fmt(rs.minimumDeposit)} ETH, fee ${rs.depositFee} / 1e18, maximum deposit now ${fmt(rs.maximumDepositAmount)} ETH, ` +
      `maximum pool size ${typeof extra.maximumDepositPoolSize === 'bigint' ? fmt(extra.maximumDepositPoolSize) : extra.maximumDepositPoolSize} ETH, pool balance ${typeof extra.depositPoolBalance === 'bigint' ? fmt(extra.depositPoolBalance) : extra.depositPoolBalance} ETH, ` +
      `exchange rate ${fmt(rs.exchangeRate)} ETH/rETH, collateral ${fmt(rs.totalCollateral)} ETH, deposit delay ${rs.depositDelayBlocks} blocks; stored user.deposit.block for the dev EOA ${lockBefore.lastDepositBlock}`,
  );
  run.rocketPool = { state: rs, ...extra, depositPoolAsRecorded: lower(rocket.depositPool) === lower(RECORDED_DEPOSIT_POOL), lockBefore };
  saveRun(run);
  const s5 = await runAction(ctx, { kind: 'stake', protocol: 'rocket-pool', amount: AMOUNTS.rpDeposit }, 'Rocket Pool deposit 0.05 → rETH');
  reportStep(s5.main);
  {
    const m = s5.main;
    const feeRate = await at(m, [rocket.settingsDeposit, 'getDepositFee()'], []);
    const { fee, net } = E.rocketDepositSplit(AMOUNTS.rpDeposit, feeRate);
    const expected = await at(m, [rocket.rETH, 'getRethValue(uint256)'], [uintArg(net)]);
    const mint = findLog(m, rocket.rETH, 'Transfer', (l) => isAddr(l.indexed[0], ZERO) && isAddr(l.indexed[1], who));
    const minted = mint[0]?.data[0] ?? 0n;
    const tokensMinted = findLog(m, rocket.rETH, 'TokensMinted');
    const received = findLog(m, rocket.depositPool, 'DepositReceived');
    expect(received.length === 1 && isAddr(received[0].indexed[0], who) && received[0].data[0] === AMOUNTS.rpDeposit, `DepositReceived(dev EOA, ${received[0]?.data[0]})`);
    expect(minted === expected, `rETH minted ${minted} = getRethValue(0.05 − fee ${fee} = ${net}) at block − 1 (${expected})`);
    expect(tokensMinted.length === 1 && tokensMinted[0].data[0] === minted && tokensMinted[0].data[1] === net, `TokensMinted(dev EOA, ${tokensMinted[0]?.data[0]} rETH, ${tokensMinted[0]?.data[1]} ETH) — the ETH figure is the net deposit`);
    expect(m.delta.rETH === minted, `rETH delta ${m.delta.rETH}`);
    expect(m.delta.eth === -AMOUNTS.rpDeposit - m.fee, `ETH delta ${m.delta.eth} = −0.05 ETH − fee ${m.fee}`);
    const lockAfter = await E.readRethDepositLock(ctx.second, rocket.storage, who, rs.depositDelayBlocks);
    expect(lockAfter.lastDepositBlock === 0n, `F-72: stored user.deposit.block for the dev EOA after the deposit = ${lockAfter.lastDepositBlock} (0: the deposit did not start the lock)`);
    s5.checks = { depositFeeRate: feeRate, protocolFee: fee, net, minted, expected, lockAfter };
  }
  record(s5);
  const s6 = await runAction(ctx, { kind: 'burn', amount: AMOUNTS.rpBurn }, 'Rocket Pool burn 0.02 rETH (at once after the deposit)');
  reportStep(s6.main);
  {
    const m = s6.main;
    const expected = await at(m, [rocket.rETH, 'getEthValue(uint256)'], [uintArg(AMOUNTS.rpBurn)]);
    const burned = findLog(m, rocket.rETH, 'TokensBurned');
    const gap = m.block - s5.main.block;
    expect(m.status === '0x1', `F-72: the burn SUCCEEDED ${gap} block(s) after the deposit (block ${s5.main.block} → ${m.block}), inside the ${rs.depositDelayBlocks}-block delay`);
    expect(burned.length === 1 && isAddr(burned[0].indexed[0], who) && burned[0].data[0] === AMOUNTS.rpBurn && burned[0].data[1] === expected, `TokensBurned(dev EOA, ${burned[0]?.data[0]} rETH, ${burned[0]?.data[1]} ETH) = getEthValue(0.02) at block − 1 (${expected})`);
    expect(m.delta.rETH === -AMOUNTS.rpBurn, `rETH delta ${m.delta.rETH}`);
    expect(m.delta.eth === expected - m.fee, `ETH delta ${m.delta.eth} = ${expected} received − fee ${m.fee}`);
    s6.checks = { ethReceived: expected, blocksAfterDeposit: gap };
  }
  record(s6);

  // F-73, read-only.
  const rethLeft = await uintAt(ctx.node, rocket.rETH, 'balanceOf(address)', [addrArg(who)], 'latest');
  run.f73 = await f73Simulations(ctx, who, rethLeft < 10n ** 16n ? rethLeft : 10n ** 16n);
  saveRun(run);

  // (6) Reconciliation over the whole leg.
  const endBlock = BigInt(await ctx.node('eth_blockNumber', []));
  const after = await holdings(ctx.second, lido, rocket.rETH, who, hex(endBlock));
  const total = diffHoldings(before, after);
  const sum = Object.fromEntries(Object.keys(before).map((k) => [k, run.steps.flatMap((s) => [s.approve, s.main].filter(Boolean)).reduce((a, x) => a + x.delta[k], 0n)]));
  const fees = run.steps.flatMap((s) => [s.approve, s.main].filter(Boolean)).reduce((a, x) => a + x.fee, 0n);
  console.log(`\n  after (block ${endBlock}): ${Object.entries(after).map(([k, v]) => `${k} ${v}`).join(', ')}; fees paid ${fees} wei`);
  for (const k of Object.keys(before)) {
    expect(total[k] === sum[k], `reconciled ${k}: before → after ${total[k]} = Σ per-transaction deltas ${sum[k]}${total[k] === sum[k] ? '' : ` (gap ${total[k] - sum[k]}: changes outside the leg's blocks, e.g. a rebase)`}`);
  }
  run.fundsAfter = { block: endBlock, ...after };
  run.reconciliation = { total, sumOfSteps: sum, feesPaid: fees, valueStaked: ctx.valueSent };
  run.leg.status = 'sent; claim pending';
  saveRun(run);

  // (4, continued) finalisation and the claim.
  const waitMinutes = Number(process.env.STAKING_FINALIZE_WAIT_MINUTES ?? '90');
  const pollMinutes = Number(process.env.STAKING_POLL_MINUTES ?? '10');
  const claimed = await pollAndClaim(ctx, run, waitMinutes, pollMinutes);
  run.leg.status = claimed ? 'complete (claimed)' : 'sent; claim pending';
  if (claimed) run.fundsAfterClaim = await holdings(ctx.second, lido, rocket.rETH, who, 'latest');
  saveRun(run);
  console.log(`\n  record: ${RUN_FILE.pathname}`);
}

async function hoodiClaim() {
  const run = loadRun();
  if (!run?.pending?.requestId) throw new Error(`${RUN_FILE.pathname} has no pending request. Nothing was sent.`);
  if (run.pending.status === 'claimed') {
    console.log(`  Request ${run.pending.requestId} was already claimed (${run.claim?.hash}).`);
    return;
  }
  const ctx = await hoodiContext();
  console.log(`\n=== LIVE Hoodi claim of request ${run.pending.requestId} (dev EOA ${short(ctx.who)})`);
  const claimed = await pollAndClaim(ctx, run, Number(process.env.STAKING_FINALIZE_WAIT_MINUTES ?? '0'), Number(process.env.STAKING_POLL_MINUTES ?? '10'));
  if (claimed) {
    run.leg.status = 'complete (claimed)';
    run.fundsAfterClaim = await holdings(ctx.second, ctx.lido, ctx.rocket.rETH, ctx.who, 'latest');
    saveRun(run);
  }
}

async function hoodiF73() {
  const ctx = await hoodiContext();
  const rethLeft = await uintAt(ctx.node, ctx.rocket.rETH, 'balanceOf(address)', [addrArg(ctx.who)], 'latest');
  if (rethLeft === 0n) throw new Error('The dev EOA holds no rETH on Hoodi; the F-73 simulations need a holder with rETH.');
  await f73Simulations(ctx, ctx.who, rethLeft < 10n ** 16n ? rethLeft : 10n ** 16n);
}

const LIVE = process.env.STAKING_LIVE ?? '';
const LEGS = { '': [], 1: ['sepolia', 'hoodi'], sepolia: ['sepolia'], hoodi: ['hoodi'], 'hoodi-claim': ['hoodi-claim'], 'hoodi-f73': ['hoodi-f73'] };
if (!(LIVE in LEGS)) throw new Error(`STAKING_LIVE=${LIVE} is not one of: ${Object.keys(LEGS).filter(Boolean).join(', ')}.`);
if (LEGS[LIVE].length > 0 && !devSigner) throw new Error('A live leg needs .dev-wallet/mnemonic.txt.');
if (process.env.STAKING_SKIP_DRY !== '1') {
  await dryRun(SEPOLIA);
  await dryRun(HOODI);
}
for (const leg of LEGS[LIVE]) {
  if (leg === 'sepolia') await sepoliaLive();
  if (leg === 'hoodi') await hoodiLive();
  if (leg === 'hoodi-claim') await hoodiClaim();
  if (leg === 'hoodi-f73') await hoodiF73();
}
console.log(`\nstaking-smoke: ${failures === 0 ? 'ALL OK' : `${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
