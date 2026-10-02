import * as SecureStore from 'expo-secure-store';

/**
 * NON-CUSTODIAL INVARIANT — the single most important property of this
 * wallet. The BIP-39 mnemonic is the root of every key on every chain, and
 * it lives ONLY in the device's hardware-backed secure storage:
 * expo-secure-store, which is the iOS Keychain on iOS and the Android
 * Keystore-encrypted SharedPreferences on Android.
 *
 *   - It is never written to AsyncStorage or any other plain storage.
 *   - It is never logged (no console.log of mnemonics or seeds anywhere).
 *   - It is never sent over the network to anyone, including us.
 *
 * Every read and write of the mnemonic in the app goes through this module
 * so the invariant is enforceable in one place. If you find yourself
 * importing expo-secure-store anywhere else to touch key material, stop and
 * route it through here instead.
 */

const MNEMONIC_KEY = 'shiba-wallet.mnemonic.v1';

// WHEN_UNLOCKED_THIS_DEVICE_ONLY: the item is readable only while the device
// is unlocked and is never migrated to a new device by OS backups. Restoring
// a wallet on a new device must go through the user's written seed backup —
// that is the recovery model, by design.
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export async function saveMnemonic(mnemonic: string): Promise<void> {
  await SecureStore.setItemAsync(MNEMONIC_KEY, mnemonic, SECURE_OPTIONS);
}

export async function loadMnemonic(): Promise<string | null> {
  return SecureStore.getItemAsync(MNEMONIC_KEY, SECURE_OPTIONS);
}

export async function deleteMnemonic(): Promise<void> {
  await SecureStore.deleteItemAsync(MNEMONIC_KEY, SECURE_OPTIONS);
}

// ---------------------------------------------------------------------------
// Session keys (phase 8 item 2)
// ---------------------------------------------------------------------------

/**
 * Session private keys (see ./sessions.ts) are key material too, so they get
 * the same storage class as the mnemonic: expo-secure-store with
 * WHEN_UNLOCKED_THIS_DEVICE_ONLY, one entry per account + chain + permission
 * id, never AsyncStorage. A session key can only act within its on-chain
 * grant, but it can spend within that grant, so it is treated like a key.
 * ids come from sessions.ts sessionVaultId ("<chain decimal>.<account>.<permission id>");
 * the installed expo-secure-store 57.0.4 allows only alphanumerics, ".", "-"
 * and "_" in keys (SecureStore.d.ts), which the pattern below enforces.
 */
const SESSION_KEY_PREFIX = 'shiba-wallet.session-key.v1.';
const SESSION_VAULT_ID = /^[0-9]+\.0x[0-9a-f]{40}\.[0-9a-f]{8}$/;

function sessionEntry(id: string): string {
  if (!SESSION_VAULT_ID.test(id)) throw new Error('Invalid session key id');
  return SESSION_KEY_PREFIX + id;
}

export const sessionKeyVault = {
  async save(id: string, privateKeyHex: string): Promise<void> {
    if (!/^0x[0-9a-f]{64}$/i.test(privateKeyHex)) throw new Error('A session key is 32 bytes of hex');
    await SecureStore.setItemAsync(sessionEntry(id), privateKeyHex, SECURE_OPTIONS);
  },
  async load(id: string): Promise<string | null> {
    return SecureStore.getItemAsync(sessionEntry(id), SECURE_OPTIONS);
  },
  async remove(id: string): Promise<void> {
    await SecureStore.deleteItemAsync(sessionEntry(id), SECURE_OPTIONS);
  },
};
