/**
 * Sends test ETH from the dev EOA (the mnemonic in .dev-wallet) to an
 * address on a test network with a plain EIP-1559 transfer. Intended for
 * topping up test accounts during live validation.
 *
 * Usage: TO=0x... ETH=0.0015 [NODE_URL=...] [FUND_DRY_RUN=1] node scripts/testnet/fund.mjs
 *   NODE_URL may point at Ethereum Sepolia (default), Base Sepolia
 *   (https://base-sepolia-rpc.publicnode.com), Arbitrum Sepolia
 *   (https://arbitrum-sepolia-rpc.publicnode.com), Hoodi
 *   (https://ethereum-hoodi-rpc.publicnode.com) or OP Sepolia
 *   (https://optimism-sepolia-rpc.publicnode.com) — the first default
 *   candidate of each app profile (app/src/config/evm-chain.ts); other
 *   chains, mainnets in particular, are refused.
 *
 * The gas limit is eth_estimateGas + 20%. On Arbitrum that estimate already
 * contains the parent-chain (L1) cost as extra gas units
 * (docs.arbitrum.io/arbitrum-essentials/how-to-estimate-gas), so the worst
 * case printed below (gas limit × max fee per gas) is the whole fee. Hoodi is
 * a layer 1 network like Ethereum Sepolia.
 *
 * On the OP-stack profiles (Base Sepolia, OP Sepolia: the app profiles with
 * l1DataFee, app/src/config/evm-chain.ts) the L1 data fee and the operator
 * fee are charged ON TOP of gas × price, and op-geth refuses a transaction
 * whose sender cannot cover gasLimit × maxFeePerGas + L1 cost + operator
 * cost + value (see the sources in app/src/wallet/send.ts). The script
 * therefore prices the exact unsigned transaction it is about to sign with
 * the app's own quoteOpStackFees (GasPriceOracle.getL1Fee on the serialized
 * unsigned transaction and getOperatorFee(gasLimit), plus the app's 50% L1
 * reserve), prints the L1 estimate, the reserve and the operator fee, and
 * includes them in the printed worst case; it refuses to send when the
 * balance cannot cover the worst case plus the value. The transaction
 * itself (nonce, fees, gas limit, recipient, value) is built exactly as
 * before on every chain; only the quote, the balance check and the printed
 * figures were added (phase 19 item 0a).
 *
 * After inclusion it prints the receipt's gasUsed and effectiveGasPrice, the
 * layer 2 receipt fields the node returned (scripts/testnet/l2-receipt.mjs),
 * the fee paid against the printed worst case, and whether the sender's
 * balance fell by exactly value + gasUsed × effectiveGasPrice + l1Fee (+ the
 * operator fee read from the oracle at that block).
 *
 * FUND_DRY_RUN=1 builds and prices the transaction (the dev EOA's address,
 * nonce and balance are read) but signs and sends nothing.
 */
import { readFileSync } from 'node:fs';
import { ChainRegistry, HdKeyring, evmKeyProvider } from '../../packages/core/dist/index.js';
import { NodeClient, httpTransport, signEip1559 } from '../../packages/chains-evm/dist/index.js';
// The app's own OP-stack fee quote (Node type stripping loads the .ts file,
// as app/scripts/check-base.mjs does); not re-implemented here.
import { chainHasL1DataFee, quoteOpStackFees } from '../../app/src/wallet/send.ts';
import { SEPOLIA_RPC } from './config.mjs';
import { balanceDeltaCheck, describeReceiptFees, operatorFeeAt, receiptFeePaid } from './l2-receipt.mjs';

const TO = process.env.TO;
const ETH = process.env.ETH;
const NODE_URL = process.env.NODE_URL ?? SEPOLIA_RPC;
const DRY_RUN = process.env.FUND_DRY_RUN === '1';
if (!TO || !/^0x[0-9a-fA-F]{40}$/.test(TO) || !ETH || !/^\d+(\.\d+)?$/.test(ETH)) {
  console.error('Set TO (0x + 40 hex) and ETH (decimal amount).');
  process.exit(1);
}

function parseEth(text) {
  const [whole, frac = ''] = text.split('.');
  return BigInt(whole) * 10n ** 18n + BigInt((frac + '0'.repeat(18)).slice(0, 18));
}

const node = httpTransport(NODE_URL);
const nodeClient = new NodeClient(node);
const chainId = await nodeClient.chainId();
// Test networks only: Ethereum Sepolia by default; Base Sepolia, Arbitrum
// Sepolia, Hoodi (560048) or OP Sepolia (11155420) when the node reports
// them. Anything else (a mainnet in particular) is refused.
const ALLOWED_TEST_CHAINS = [11155111n, 84532n, 421614n, 560048n, 11155420n];
if (!ALLOWED_TEST_CHAINS.includes(chainId)) throw new Error(`Not a supported test network: chain id ${chainId}`);

const mnemonic = readFileSync(new URL('../../.dev-wallet/mnemonic.txt', import.meta.url), 'utf8').trim();
const registry = new ChainRegistry();
registry.register(evmKeyProvider);
const payer = HdKeyring.fromMnemonic(mnemonic, registry).getAccount('eip155:1');

// A recipient with code (for example a deployed or delegated smart account)
// may need more than a plain transfer's 21,000 gas, so the limit is estimated.
const value = parseEth(ETH);
const gasHex = await node('eth_estimateGas', [{ from: payer.address, to: TO, value: '0x' + value.toString(16) }]);
const fees = await nodeClient.suggestFees();
const gasLimit = (BigInt(gasHex) * 120n) / 100n;
const tx = {
  chainId,
  nonce: await nodeClient.getTransactionCount(payer.address),
  maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  maxFeePerGas: fees.maxFeePerGas,
  gasLimit,
  to: TO,
  value,
};
const l2Worst = gasLimit * fees.maxFeePerGas;
// OP stack only: the L1 data fee and operator fee of THIS unsigned transaction.
const opStack = chainHasL1DataFee(chainId) ? await quoteOpStackFees(node, tx) : null;
const worstCase = l2Worst + (opStack ? opStack.l1DataFee + opStack.operatorFee : 0n);
console.log(
  `Chain ${chainId}: gas estimate ${BigInt(gasHex)}, limit ${gasLimit}, maxFeePerGas ${fees.maxFeePerGas}, ` +
    `maxPriorityFeePerGas ${fees.maxPriorityFeePerGas}, ` +
    (opStack
      ? `gas worst case ${l2Worst} wei + L1 data fee ${opStack.l1DataFeeEstimate} wei (getL1Fee on the ` +
        `${opStack.unsignedTxBytes}-byte unsigned transaction; reserved with headroom: ${opStack.l1DataFee} wei) + ` +
        `operator fee ${opStack.operatorFee} wei = worst case ${worstCase} wei`
      : `worst case ${worstCase} wei`),
);
const balance = await nodeClient.getBalance(payer.address);
console.log(`Sender ${payer.address} holds ${balance} wei (nonce ${tx.nonce}); value + worst case = ${value + worstCase} wei`);
if (balance < value + worstCase) {
  throw new Error(`The sender cannot cover the value plus the worst-case fee (${value + worstCase} wei). Nothing was sent.`);
}
if (DRY_RUN) {
  console.log('FUND_DRY_RUN: nothing was signed or sent.');
  process.exit(0);
}
const signed = signEip1559(tx, payer);
const hash = await nodeClient.sendRawTransaction(signed.rawHex);
console.log(`Sent ${ETH} ETH from ${payer.address} to ${TO}: ${hash}`);
for (let i = 0; i < 60; i++) {
  const receipt = await node('eth_getTransactionReceipt', [hash]);
  if (receipt) {
    const operatorFee = opStack ? await operatorFeeAt(node, receipt) : null;
    console.log(`status ${receipt.status} in block ${Number(receipt.blockNumber)}; ${describeReceiptFees(receipt, operatorFee)}`);
    const paid = receiptFeePaid(receipt, operatorFee ?? 0n);
    // Ratio in basis points of the printed worst case (integer arithmetic).
    console.log(`fee paid ${paid.total} wei = ${Number((paid.total * 10_000n) / worstCase) / 100}% of the printed worst case ${worstCase} wei`);
    if (opStack) {
      console.log(
        `L1 data fee: quoted ${opStack.l1DataFeeEstimate} wei, charged ${paid.l1} wei; ` +
          `the L1 part is ${paid.total ? (Number(paid.l1) / Number(paid.total)).toExponential(3) : 0} of the fee paid`,
      );
    }
    const delta = await balanceDeltaCheck(node, receipt, payer.address, value, operatorFee ?? 0n);
    console.log(
      delta
        ? `balance delta ${delta.delta} wei (block-1 ${delta.before} → block ${delta.after}); value + fee = ${delta.expected} wei; ` +
            `${delta.exact ? 'EXACT match' : `MISMATCH by ${delta.delta - delta.expected} wei`}`
        : 'balance delta: the node did not serve the historical balances',
    );
    process.exit(receipt.status === '0x1' ? 0 : 1);
  }
  await new Promise((r) => setTimeout(r, 4000));
}
throw new Error('No receipt after 4 minutes');
