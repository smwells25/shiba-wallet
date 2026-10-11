/**
 * Layer 2 fee facts for the testnet scripts (phase 19 item 0a).
 *
 * OP-stack chains (Base Sepolia, OP Sepolia) charge a transaction
 *   totalFee = operatorFee + gasUsed * (baseFee + priorityFee) + l1Fee
 * (docs.optimism.io/op-stack/transactions/fees, quoted in
 * app/src/wallet/send.ts). Their receipts carry the L1 part as extra JSON
 * fields next to the standard ones. Observed on 2026-10-11 in an OP Sepolia
 * type-2 receipt served by optimism-sepolia-rpc.publicnode.com
 * (web3_clientVersion "op-reth/v0.0.0-dev-unknown"): l1GasPrice, l1GasUsed,
 * l1Fee, l1BaseFeeScalar, l1BlobBaseFee, l1BlobBaseFeeScalar,
 * daFootprintGasScalar and blobGasUsed — and NO operator-fee field. Which
 * fields a node returns depends on its client and the active forks, so the
 * scripts print what is PRESENT rather than assume a set. Arbitrum Nitro
 * instead reports the parent-chain part as `gasUsedForL1`, already inside
 * gasUsed.
 *
 * The operator fee is not re-derived here: when asked, it is read from the
 * chain's own GasPriceOracle.getOperatorFee(gasUsed) at the inclusion block,
 * so the chain's current formula applies.
 *
 * Nothing here signs or sends; every function reads.
 */
import { decodeUint256, encodeFunctionCall, toHex } from '../../packages/chains-evm/dist/index.js';

/** The GasPriceOracle predeploy on OP-stack chains (app/src/wallet/send.ts OP_STACK_GAS_PRICE_ORACLE). */
const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F';

/** Layer 2 receipt fields printed when present, in this order. */
export const L2_RECEIPT_FIELDS = [
  'l1Fee',
  'l1GasUsed',
  'l1GasPrice',
  'l1FeeScalar',
  'l1BaseFeeScalar',
  'l1BlobBaseFee',
  'l1BlobBaseFeeScalar',
  'operatorFeeScalar',
  'operatorFeeConstant',
  'daFootprintGasScalar',
  'blobGasUsed',
  'gasUsedForL1',
];

/** The layer 2 fee fields present in `receipt`, as decimal strings. */
export function l2ReceiptFields(receipt) {
  const out = {};
  for (const key of L2_RECEIPT_FIELDS) {
    const value = receipt?.[key];
    if (value === undefined || value === null) continue;
    // A hex quantity becomes decimal; anything else (e.g. a decimal-string scalar) is printed as given.
    out[key] = typeof value === 'string' && value.startsWith('0x') ? BigInt(value).toString() : String(value);
  }
  return out;
}

/**
 * The operator fee for this receipt, read from GasPriceOracle.getOperatorFee
 * (gasUsed) at the inclusion block. Returns null when the read fails (no
 * oracle, or the node lacks that block's state).
 */
export async function operatorFeeAt(node, receipt) {
  try {
    const data = toHex(
      encodeFunctionCall('getOperatorFee(uint256)', [{ kind: 'uint256', value: BigInt(receipt.gasUsed) }]),
    );
    return decodeUint256(await node('eth_call', [{ to: GAS_PRICE_ORACLE, data }, receipt.blockNumber]));
  } catch {
    return null;
  }
}

/**
 * The fee a receipt says the sender paid: gasUsed × effectiveGasPrice plus
 * the receipt's l1Fee when present, plus `operatorFee` when given.
 */
export function receiptFeePaid(receipt, operatorFee = 0n) {
  const l2 = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
  const l1 = receipt.l1Fee !== undefined && receipt.l1Fee !== null ? BigInt(receipt.l1Fee) : 0n;
  return { l2, l1, operator: operatorFee ?? 0n, total: l2 + l1 + (operatorFee ?? 0n) };
}

/** One printable line of the receipt's fee facts. */
export function describeReceiptFees(receipt, operatorFee = null) {
  const fields = l2ReceiptFields(receipt);
  const paid = receiptFeePaid(receipt, operatorFee ?? 0n);
  const present = Object.keys(fields);
  return (
    `gasUsed ${BigInt(receipt.gasUsed)}, effectiveGasPrice ${BigInt(receipt.effectiveGasPrice)}, ` +
    `L2 execution fee ${paid.l2} wei` +
    (receipt.l1Fee !== undefined && receipt.l1Fee !== null ? ` + L1 data fee ${paid.l1} wei` : '') +
    (operatorFee !== null ? ` + operator fee ${paid.operator} wei (GasPriceOracle.getOperatorFee(gasUsed))` : '') +
    ` = ${paid.total} wei; layer 2 receipt fields present: ` +
    (present.length ? present.map((k) => `${k}=${fields[k]}`).join(' ') : 'none')
  );
}

/**
 * Checks that the sender's balance fell by exactly value + the fee the
 * receipt reports, reading the balance at the block before and the block of
 * inclusion (`node` must serve that state). Returns null when the node
 * cannot answer the historical read. Only meaningful when nothing else
 * moved the sender's balance in that block.
 */
export async function balanceDeltaCheck(node, receipt, from, value, operatorFee = 0n) {
  const block = BigInt(receipt.blockNumber);
  try {
    const before = BigInt(await node('eth_getBalance', [from, '0x' + (block - 1n).toString(16)]));
    const after = BigInt(await node('eth_getBalance', [from, '0x' + block.toString(16)]));
    const paid = receiptFeePaid(receipt, operatorFee);
    const delta = before - after;
    return { before, after, delta, expected: value + paid.total, exact: delta === value + paid.total };
  } catch {
    return null;
  }
}
