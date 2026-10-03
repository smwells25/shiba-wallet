export {
  BITCOIN,
  DOGECOIN,
  BITCOIN_TESTNET,
  DOGECOIN_TESTNET,
  DOGECOIN_WIF_VERSION,
  addressToScriptPubKey,
  scriptPubKeyToAddress,
  p2pkhScript,
  p2shScript,
  p2wpkhScript,
  p2wshScript,
  isP2pkhScript,
  isP2wpkhScript,
} from './address.js';
export type { UtxoNetwork } from './address.js';
export {
  DUST_P2PKH,
  DUST_P2WPKH,
  dustThreshold,
  estimateVsize,
  feeForVsize,
  selectCoins,
} from './coinselect.js';
export {
  BITCOIN_CORE_DUST_POLICY,
  DOGECOIN_CORE_DUST_POLICY,
  DOGECOIN_HARD_DUST_LIMIT,
  DOGECOIN_SOFT_DUST_LIMIT,
} from './dust.js';
export type { DustPolicy } from './dust.js';
export type {
  CoinSelectionParams,
  CoinSelectionResult,
  InputKind,
  Utxo,
} from './coinselect.js';
export {
  SEQUENCE_FINAL,
  SIGHASH_ALL,
  dsha256,
  encodeDerSignature,
  legacySighash,
  segwitV0Sighash,
  serializeTransaction,
  signTransaction,
  transactionId,
} from './tx.js';
export type {
  InputSigner,
  SignedInput,
  SignedTransaction,
  TransactionInput,
  TransactionOutput,
  UnsignedTransaction,
} from './tx.js';
export { esploraTransport } from './transport.js';
export type { UtxoTransport } from './transport.js';
export { buildTransfer, signAndBroadcast } from './transfer.js';
export type { BuiltTransfer, TransferParams } from './transfer.js';
export { esploraHistoryProvider } from './history.js';
export { blockbookTransport } from './blockbook.js';
export { blockbookHistoryProvider } from './blockbook-history.js';
