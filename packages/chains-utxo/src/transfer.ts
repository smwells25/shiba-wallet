import { addressToScriptPubKey, isP2pkhScript, isP2wpkhScript, type UtxoNetwork } from './address.js';
import { dustThreshold, selectCoins, type InputKind, type Utxo } from './coinselect.js';
import { BITCOIN_CORE_DUST_POLICY } from './dust.js';
import { bytesToHex } from './encoding.js';
import {
  serializeTransaction,
  signTransaction,
  transactionId,
  type InputSigner,
  type UnsignedTransaction,
} from './tx.js';
import type { UtxoTransport } from './transport.js';

/**
 * The wallet-facing flow: turn "send X sats to this address" into a fully
 * signed raw transaction. buildTransfer() is pure (no I/O); the only
 * network touches are the injected transport's getUtxos/broadcastTx.
 */

export interface TransferParams {
  network: UtxoNetwork;
  /** The wallet address being spent from; all UTXOs must belong to it. */
  fromAddress: string;
  /** Spendable coins for fromAddress, as returned by the transport. */
  utxos: Utxo[];
  toAddress: string;
  /** Amount to send, in satoshis. */
  amount: bigint;
  /** Fee rate in satoshis per virtual byte. */
  feeRate: number;
  /** Defaults to fromAddress (change returns to the sender). */
  changeAddress?: string;
  /**
   * Transaction version. Defaults to 2, the current Bitcoin wallet norm
   * (enables BIP-68 relative locktime semantics). Dogecoin nodes still
   * produce version-1 transactions; both are accepted on both networks.
   */
  version?: number;
  locktime?: number;
}

export interface BuiltTransfer {
  tx: UnsignedTransaction;
  fee: bigint;
  /** Signing scheme the inputs will use, derived from fromAddress. */
  inputKind: InputKind;
}

/**
 * Pure construction: decodes addresses, runs coin selection, and lays out
 * the unsigned transaction (recipient output first, change output last).
 */
export function buildTransfer(params: TransferParams): BuiltTransfer {
  const { network, fromAddress, utxos, toAddress, amount, feeRate } = params;
  if (amount <= 0n) throw new Error(`Transfer amount must be positive, got ${amount}`);

  const inputScript = addressToScriptPubKey(fromAddress, network);
  let inputKind: InputKind;
  if (isP2wpkhScript(inputScript)) inputKind = 'p2wpkh';
  else if (isP2pkhScript(inputScript)) inputKind = 'p2pkh';
  else throw new Error('Can only spend from P2WPKH or P2PKH addresses');

  // The chain's dust policy governs both outputs: the recipient output is
  // refused here if it would be dust, and coin selection folds would-be
  // dust change into the fee. Networks without a policy get Bitcoin Core's.
  const dustPolicy = network.dustPolicy ?? BITCOIN_CORE_DUST_POLICY;
  const toScriptPubKey = addressToScriptPubKey(toAddress, network);
  const recipientDust = dustThreshold(toScriptPubKey, dustPolicy);
  if (amount < recipientDust) {
    throw new Error(
      `Amount is below the ${network.name} dust limit: the smallest output this wallet ` +
        `will create is ${formatCoins(recipientDust)} (${recipientDust} base units), and ` +
        `nodes would not relay a transaction with a smaller output at a normal fee.`,
    );
  }

  const outputs = [{ value: amount, scriptPubKey: toScriptPubKey }];
  const changeScriptPubKey = addressToScriptPubKey(params.changeAddress ?? fromAddress, network);

  const selection = selectCoins({
    utxos,
    outputs,
    feeRate,
    inputKind,
    changeScriptPubKey,
    dustPolicy,
  });

  return {
    inputKind,
    fee: selection.fee,
    tx: {
      version: params.version ?? 2,
      inputs: selection.inputs.map((utxo) => ({
        txid: utxo.txid,
        vout: utxo.vout,
        value: utxo.value,
        scriptPubKey: inputScript,
      })),
      outputs: selection.change ? [...outputs, selection.change] : outputs,
      locktime: params.locktime ?? 0,
    },
  };
}

/** Base units to a whole-coin decimal string (8 decimals, trailing zeros trimmed). */
function formatCoins(baseUnits: bigint): string {
  const whole = baseUnits / 100_000_000n;
  const fraction = (baseUnits % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/**
 * Signs a built transfer and broadcasts it through the injected transport.
 * Everything up to the broadcastTx call is offline; the signer is the
 * DerivedAccount from @shiba-wallet/core (or anything with its shape).
 * Resolves to the txid, which is also computed locally and cross-checked
 * against the backend's answer so a mismatched broadcast cannot pass
 * silently.
 */
export async function signAndBroadcast(
  built: BuiltTransfer,
  signer: InputSigner | InputSigner[],
  transport: UtxoTransport,
): Promise<string> {
  const signed = signTransaction(built.tx, signer);
  const rawHex = bytesToHex(serializeTransaction(signed.tx, signed.signedInputs));
  const localTxid = transactionId(signed.tx, signed.signedInputs);
  const remoteTxid = await transport.broadcastTx(rawHex);
  if (remoteTxid !== localTxid) {
    throw new Error(`Backend txid ${remoteTxid} does not match local txid ${localTxid}`);
  }
  return localTxid;
}
