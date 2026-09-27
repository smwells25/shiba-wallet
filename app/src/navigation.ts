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
  Send: { chainId: string };
  Settings: undefined;
  Tokens: undefined;
};
