import type { NftSendParams } from './wallet/send-nft';

/** Route names and params for the single native stack. */
export type RootStackParamList = {
  // Onboarding (shown while no wallet exists)
  Welcome: undefined;
  Backup: undefined;
  ConfirmBackup: undefined;
  Import: undefined;
  // Main app (shown once a wallet exists)
  Home: undefined;
  Receive: { chainId: string };
  /**
   * tokenId (a CAIP-19 id from the tracked-token store) switches the send
   * screen into ERC-20 token mode; nft (phase 7 item 4) switches it into
   * NFT mode (ERC-721 / ERC-1155 safeTransferFrom on the active EVM chain);
   * with neither, the chain's native coin is sent.
   */
  Send: { chainId: string; tokenId?: string; nft?: NftSendParams };
  Activity: { chainId: string };
  /** EVM-only swap flow (phase 5 item 1); the active EVM chain applies. */
  Swap: undefined;
  Settings: undefined;
  Tokens: undefined;
  Connections: undefined;
  /** Contacts management (phase 6 item 4); lists the active networks. */
  Contacts: undefined;
  /** NFT gallery for the active account on the active EVM chain (phase 7 item 4). */
  Nfts: undefined;
  /** One NFT, by CAIP-19 id (decimal token id), from the gallery's list. */
  NftDetail: { assetId: string };
  /** Token approvals manager for the active account on the active EVM chain (phase 7 item 5). */
  Approvals: undefined;
  /** EIP-7702 "Upgrade this account" for the active account on the active EVM chain (phase 8 item 1). */
  UpgradeAccount: undefined;
  /** Session keys (phase 8 item 2) on the active account's Kernel account, active EVM chain. */
  Sessions: undefined;
  /** Guardians / social recovery (phase 8 item 4) for the active account's Kernel account. */
  Guardians: undefined;
  /** Recover a Kernel account with guardians (new owner = the active account), or restore a record. */
  RecoverAccount: undefined;
  /** The guardian side: review, approve and submit a recovery request as the active account. */
  ApproveRecovery: undefined;
  /** Passkey signer (phase 8 item 3) for the active account's deployed Kernel account, active EVM chain. */
  Passkey: undefined;
};
