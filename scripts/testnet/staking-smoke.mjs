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
 * LIVE (STAKING_LIVE=1): Ethereum Sepolia — the dev EOA stakes 0.001 test
 * ETH for stETH THROUGH THE APP'S OWN CODE (app/src/wallet/staking.ts
 * planStakingAction → prepareStakingSend → send.ts sendEvm, the path the
 * Staking screen uses), then the receipt, the stETH minted and the balance
 * and share deltas are re-read on a SECOND public endpoint. No unstake on
 * Sepolia (Lido's queue there is paused). Hoodi — only when the dev EOA
 * holds at least 0.03 Hoodi ETH: a Lido stake of 0.001 and a Rocket Pool
 * deposit of 0.01 (the minimum), the same way; otherwise the leg prints
 * that it was skipped and why.
 *
 * Run from the repository root after `npm run build`:
 *   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
 *   node scripts/testnet/staking-smoke.mjs
 *   STAKING_LIVE=1 node scripts/testnet/staking-smoke.mjs
 *
 * Secrets: the dev mnemonic is read from the git-ignored .dev-wallet and
 * never printed; addresses are printed shortened.
 */
import { existsSync, readFileSync } from 'node:fs';
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
    expect(a.ok && minted > 0n && minted <= STAKE && STAKE - minted <= 2n, `A stake 0.01 → stETH minted ${minted} wei (${STAKE - minted} wei below the ETH sent)`);

    // B: stake → wstETH (plain transfer).
    const [b] = await simulate(node, [[at(E.lidoStakeCall(lido, STAKE, 'wstETH'))]], override);
    expect(b.ok && tokenIn(b, lido.wstETH) > 0n, `B stake 0.01 → wstETH minted ${tokenIn(b, lido.wstETH)} (plain transfer, receive())`);

    // C: stake, approve exact, wrap, unwrap.
    const half = STAKE / 2n;
    const [c] = await simulate(
      node,
      [[at(E.lidoStakeCall(lido, STAKE)), at(E.wstethWrapApproveCall(lido, half)), at(E.wstethWrapCall(lido, half)), at(E.wstethUnwrapCall(lido, half / 2n))]],
      override,
    );
    expect(c.ok, `C stake + approve(wstETH, ${half}) + wrap + unwrap: ${c.calls.map((x) => (x.ok ? 'ok' : `REVERT ${x.revertReason}`)).join(', ')}`);

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
      expect(d.ok && nft !== undefined, `D approve(queue, ${half}) + requestWithdrawals: request NFT ${nft ? `#${nft.tokenId}` : 'missing'} minted to the owner`);
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
      expect(e1.ok && rMinted === expected, `E deposit 0.01 → rETH minted ${rMinted} (getRethValue(amount − fee) = ${expected})`);
      const lock = await E.readRethDepositLock(node, rocket.contracts.storage, who, rocket.state.depositDelayBlocks);
      const code = await node('eth_getCode', [who, 'latest']);
      const delegated = typeof code === 'string' && code.toLowerCase().startsWith('0xef0100') ? `0x${code.slice(8, 48)}` : null;
      console.log(
        `  rETH burn of ${burnAmount} in the next simulated block: ${e2.ok ? 'SUCCEEDED — this deposit did not start the deposit-delay lock' : `REVERTED (${e2.calls[0].revertReason})`}; ` +
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

/** One live action through the app's own glue, verified on a second endpoint. */
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
  // Independent re-read on the second endpoint.
  const r2 = await receiptOf(second, sent.txid);
  const blockNo = BigInt(r2.blockNumber);
  const transferTopic = E.TRANSFER_EVENT_TOPIC;
  const mints = r2.logs.filter(
    (l) => l.address.toLowerCase() === token.toLowerCase() && l.topics[0] === transferTopic && BigInt(l.topics[1]) === 0n && BigInt(l.topics[2]) === BigInt(devSigner.address),
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

async function live() {
  if (!devSigner) throw new Error('STAKING_LIVE needs .dev-wallet/mnemonic.txt.');
  console.log(`\n=== LIVE (dev EOA ${short(devSigner.address)})`);
  // Sepolia: stake 0.001 test ETH → stETH. No unstake (the queue is paused).
  const sepBalance = BigInt(await E.httpTransport(CHAINS[SEPOLIA].rpc)('eth_getBalance', [devSigner.address, 'latest']));
  console.log(`  Sepolia balance ${fmt(sepBalance)} test ETH`);
  if (sepBalance < 2n * 10n ** 15n) throw new Error('The dev EOA holds less than 0.002 Sepolia ETH; nothing was sent.');
  await liveAction(SEPOLIA, { kind: 'stake', protocol: 'lido', receive: 'stETH', amount: 10n ** 15n }, 'Sepolia Lido stake 0.001');

  // Hoodi: only with funds, and only once the app has its Hoodi profile.
  const hoodiBalance = BigInt(await E.httpTransport(CHAINS[HOODI].rpc)('eth_getBalance', [devSigner.address, 'latest']));
  if (hoodiBalance < 3n * 10n ** 16n) {
    console.log(`  Hoodi leg SKIPPED: the dev EOA holds ${fmt(hoodiBalance)} Hoodi ETH (needs at least 0.03). Nothing was sent on Hoodi.`);
    return;
  }
  await liveAction(HOODI, { kind: 'stake', protocol: 'lido', receive: 'stETH', amount: 10n ** 15n }, 'Hoodi Lido stake 0.001');
  await liveAction(HOODI, { kind: 'stake', protocol: 'rocket-pool', amount: STAKE }, 'Hoodi Rocket Pool deposit 0.01');
}

await dryRun(SEPOLIA);
await dryRun(HOODI);
if (process.env.STAKING_LIVE === '1') await live();
console.log(`\nstaking-smoke: ${failures === 0 ? 'ALL OK' : `${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
