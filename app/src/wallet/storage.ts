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
