import type { NftSendParams } from './wallet/send-nft';
import type { SendRequestPrefill } from './wallet/payment-request';

/**
 * Settings sections another screen can open directly (phase 11 item 6
 * finding F7): Settings scrolls to the section once it has been laid out.
 */
export type SettingsSectionId = 'network-endpoints' | 'history-indexer' | 'nft-indexer';

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
   * with neither, the chain's native coin is sent. `request` (phase 14
   * item 1) pre-fills the form from a scanned or pasted payment request
   * when the request switched the screen between the native coin and a
   * token; every value stays editable.
   */
  Send: { chainId: string; tokenId?: string; nft?: NftSendParams; request?: SendRequestPrefill };
  Activity: { chainId: string };
  /** EVM-only swap flow (phase 5 item 1); the active EVM chain applies. */
  Swap: undefined;
  /** `section`: scroll to that section on open (e.g. the NFT indexer from the NFTs screen). */
  Settings: { section?: SettingsSectionId } | undefined;
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
  /**
   * Recover a Kernel account with guardians (new owner = the active account), or restore a record.
   * role 'heir': opened from the Inheritance screen for an heir's takeover (wording only).
   */
  RecoverAccount: { role?: 'heir' } | undefined;
  /** The guardian side: review, approve and submit a recovery request as the active account (role 'heir': wording only). */
  ApproveRecovery: { role?: 'heir' } | undefined;
  /** Inheritance switch (phase 14 item 4), a test-network demonstration on the guardian modules. */
  Inheritance: undefined;
  /** Passkey signer (phase 8 item 3) for the active account's deployed Kernel account, active EVM chain. */
  Passkey: undefined;
  /**
   * Change the owner key of the active account's deployed Kernel v3.3 account
   * (factory-derived or recovered) to another account of this wallet.
   */
  OwnerRotation: undefined;
  /**
   * Proof of address ownership (phase 11 item 3): sign a challenge the user
   * holds with the active account (EOA or its Kernel smart account).
   */
  ProveOwnership: undefined;
  /**
   * App-enforced spending limits (phase 12 item 3) for the active account on
   * the active EVM network; nothing on-chain enforces them.
   */
  SpendingLimits: undefined;
  /**
   * Import a single Ethereum private key as an additional account (feature
   * 12). The recovery phrase does not back such an account up (ADR D9).
   */
  ImportKey: undefined;
  /**
   * The in-app browser (feature 79): a fixed list of allowlisted apps on test
   * networks only, connected through the same approval sheet as
   * WalletConnect. `origin` opens that allowlisted site directly; anything
   * not on the list is ignored.
   */
  Apps: { origin?: string } | undefined;
};
