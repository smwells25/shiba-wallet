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
   * screen into ERC-20 token mode; omitted, the chain's native coin is sent.
   */
  Send: { chainId: string; tokenId?: string };
  Activity: { chainId: string };
  /** EVM-only swap flow (phase 5 item 1); the active EVM chain applies. */
  Swap: undefined;
  Settings: undefined;
  Tokens: undefined;
  Connections: undefined;
  /** Contacts management (phase 6 item 4); lists the active networks. */
  Contacts: undefined;
};
