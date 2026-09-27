import React, { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { Button, WarningBox, WordGrid, screenStyle } from '../components';
import {
  NetworkEndpoint,
  getAllEndpoints,
  getEndpoint,
  resetEndpoint,
  setEndpointOverride,
} from '../config/networks';
import { DEFAULT_NETWORKS, type NetworkDefault } from '../config/defaults';
import { useTheme } from '../theme';
import { useWallet } from '../wallet/WalletContext';
import { requireLocalAuth } from '../wallet/biometric';
import {
  clearAaBundlerUrl,
  clearAaFactory,
  getAaConfig,
  setAaBundlerUrl,
  setAaFactory,
  type AaChainConfig,
} from '../wallet/aa';
import { clearWcProjectId, getWcProjectId, setWcProjectId } from '../wallet/walletconnect';

/**
 * One chain's endpoint row: shows the effective URL (default or override)
 * and expands into an inline editor with save / reset-to-default. Inline
 * TextInput rather than Alert.prompt because the latter is iOS-only.
 */
function EndpointRow({
  endpoint,
  onChanged,
}: {
  endpoint: NetworkEndpoint;
  onChanged: () => void;
}) {
  const theme = useTheme();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const { network, url, isOverride } = endpoint;

  const beginEdit = () => {
    setDraft(url ?? '');
    setEditing(true);
  };

  const save = async () => {
    try {
      await setEndpointOverride(network.chainId, draft);
      setEditing(false);
      onChanged();
    } catch (e) {
      Alert.alert('Invalid endpoint', e instanceof Error ? e.message : 'Could not save.');
    }
  };

  const reset = async () => {
    await resetEndpoint(network.chainId);
    setEditing(false);
    onChanged();
  };

  return (
    <View style={[styles.endpointRow, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <View style={styles.endpointHeader}>
        <Text style={[styles.endpointLabel, { color: theme.text }]}>{network.label}</Text>
        <Text style={[styles.endpointTag, { color: theme.textMuted }]}>
          {isOverride ? 'custom' : 'default'}
        </Text>
      </View>
      {editing ? (
        <View style={styles.endpointEditor}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="https://…"
            placeholderTextColor={theme.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={[
              styles.endpointInput,
              { color: theme.text, borderColor: theme.border, backgroundColor: theme.background },
            ]}
          />
          <View style={styles.endpointButtons}>
            <Button title="Save" onPress={() => void save()} style={styles.endpointButton} />
            <Button
              title="Cancel"
              variant="secondary"
              onPress={() => setEditing(false)}
              style={styles.endpointButton}
            />
          </View>
          {(isOverride || network.defaultUrl) && (
            <Button title="Reset to default" variant="secondary" onPress={() => void reset()} />
          )}
        </View>
      ) : (
        <View style={styles.endpointEditor}>
          <Text style={[styles.endpointUrl, { color: theme.textMuted }]} numberOfLines={2}>
            {url ?? 'Not configured'}
          </Text>
          {!url && network.note ? (
            <Text style={[styles.endpointNote, { color: theme.textMuted }]}>{network.note}</Text>
          ) : null}
          <Button title="Edit" variant="secondary" onPress={beginEdit} />
        </View>
      )}
    </View>
  );
}

/**
 * One editable AA field (bundler URL or factory address) with mandatory
 * save-time verification: the save button runs the checks and the value is
 * only persisted when they pass (../wallet/aa.ts refuses otherwise), so a
 * displayed value is always a verified one.
 */
function AaField({
  label,
  placeholder,
  value,
  statusLine,
  onSave,
  onClear,
  saveLabel = 'Verify & save',
}: {
  label: string;
  placeholder: string;
  value: string | null;
  /** Verification status for the stored value (shown when configured). */
  statusLine: string | null;
  /** Verifies and persists; throws with a plain message on any failure. */
  onSave: (draft: string) => Promise<void>;
  onClear: () => Promise<void>;
  /** Button label; override when onSave does no network verification. */
  saveLabel?: string;
}) {
  const theme = useTheme();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [verifying, setVerifying] = useState(false);

  const save = async () => {
    setVerifying(true);
    try {
      await onSave(draft);
      setEditing(false);
    } catch (e) {
      Alert.alert(
        'Not saved — verification failed',
        e instanceof Error ? e.message : 'Verification failed.',
      );
    } finally {
      setVerifying(false);
    }
  };

  return (
    <View style={styles.aaField}>
      <Text style={[styles.aaFieldLabel, { color: theme.textMuted }]}>{label}</Text>
      {editing ? (
        <View style={styles.endpointEditor}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={placeholder}
            placeholderTextColor={theme.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            style={[
              styles.endpointInput,
              { color: theme.text, borderColor: theme.border, backgroundColor: theme.background },
            ]}
          />
          {verifying ? (
            <Text style={[styles.aaStatus, { color: theme.textMuted }]}>
              Verifying before saving…
            </Text>
          ) : (
            <View style={styles.endpointButtons}>
              <Button title={saveLabel} onPress={() => void save()} style={styles.endpointButton} />
              <Button
                title="Cancel"
                variant="secondary"
                onPress={() => setEditing(false)}
                style={styles.endpointButton}
              />
            </View>
          )}
        </View>
      ) : (
        <View style={styles.endpointEditor}>
          <Text style={[styles.endpointUrl, { color: theme.textMuted }]} numberOfLines={2}>
            {value ?? 'Not configured'}
          </Text>
          {value && statusLine ? (
            <Text style={[styles.aaVerified, { color: theme.success }]}>{statusLine}</Text>
          ) : null}
          <View style={styles.endpointButtons}>
            <Button
              title="Edit"
              variant="secondary"
              onPress={() => {
                setDraft(value ?? '');
                setEditing(true);
              }}
              style={styles.endpointButton}
            />
            {value ? (
              <Button
                title="Clear"
                variant="secondary"
                onPress={() => void onClear()}
                style={styles.endpointButton}
              />
            ) : null}
          </View>
        </View>
      )}
    </View>
  );
}

/** AA configuration for one EVM chain: bundler URL + factory address. */
function AaChainRow({ network }: { network: NetworkDefault }) {
  const theme = useTheme();
  const [config, setConfig] = useState<AaChainConfig | null>(null);

  const reload = useCallback(() => {
    getAaConfig(network.chainId).then(setConfig, () => setConfig(null));
  }, [network.chainId]);

  useEffect(reload, [reload]);

  const shortDate = (iso: string | null) => (iso ? iso.slice(0, 10) : 'unknown date');

  return (
    <View style={[styles.endpointRow, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <View style={styles.endpointHeader}>
        <Text style={[styles.endpointLabel, { color: theme.text }]}>{network.label}</Text>
        <Text style={[styles.endpointTag, { color: theme.textMuted }]}>
          {config && config.bundlerUrl && config.factory ? 'ready' : 'incomplete'}
        </Text>
      </View>
      <AaField
        label="Bundler URL (ERC-4337 RPC)"
        placeholder="https://…"
        value={config?.bundlerUrl ?? null}
        statusLine={
          config?.bundlerUrl
            ? `Verified ✓ — eth_supportedEntryPoints includes EntryPoint v0.7 (checked ${shortDate(
                config.bundlerVerifiedAt,
              )})`
            : null
        }
        onSave={async (draft) => {
          await setAaBundlerUrl(network.chainId, draft);
          reload();
        }}
        onClear={async () => {
          await clearAaBundlerUrl(network.chainId);
          reload();
        }}
      />
      <AaField
        label="SimpleAccountFactory address"
        placeholder="0x…"
        value={config?.factory ?? null}
        statusLine={
          config?.factory
            ? `Verified ✓ — has code; implementation ${
                config.factoryImplementation ?? 'unknown'
              } has code and its entryPoint() is v0.7 (checked ${shortDate(
                config.factoryVerifiedAt,
              )})`
            : null
        }
        onSave={async (draft) => {
          const endpoint = await getEndpoint(network.chainId);
          if (!endpoint?.url) {
            throw new Error(
              `No ${network.label} RPC endpoint is configured; the factory is ` +
                'verified on-chain through it. Configure the endpoint above first.',
            );
          }
          await setAaFactory(network.chainId, draft, endpoint.url);
          reload();
        }}
        onClear={async () => {
          await clearAaFactory(network.chainId);
          reload();
        }}
      />
    </View>
  );
}

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

/**
 * Settings: RPC endpoint configuration per chain, token management entry
 * point, reveal the seed phrase behind a confirmation gate, and wipe the
 * wallet behind a double confirmation.
 */
export function SettingsScreen({ navigation }: Props) {
  const theme = useTheme();
  const { revealMnemonic, wipe } = useWallet();
  const [revealed, setRevealed] = useState<string | null>(null);
  const [endpoints, setEndpoints] = useState<NetworkEndpoint[]>([]);
  const [wcProjectId, setWcProjectIdState] = useState<string | null>(null);

  const reloadEndpoints = useCallback(() => {
    getAllEndpoints().then(setEndpoints, () => setEndpoints([]));
  }, []);

  useEffect(reloadEndpoints, [reloadEndpoints]);

  const reloadWcProjectId = useCallback(() => {
    getWcProjectId().then(setWcProjectIdState, () => setWcProjectIdState(null));
  }, []);

  useEffect(reloadWcProjectId, [reloadWcProjectId]);

  const onReveal = () => {
    Alert.alert(
      'Show recovery phrase?',
      'Make sure no one can see your screen. Anyone who sees these words can steal your funds.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Show it',
          style: 'destructive',
          onPress: async () => {
            // Biometric gate (task 7): revealing the seed requires local
            // authentication whenever the device has enrolled biometrics;
            // devices without biometrics proceed (see wallet/biometric.ts
            // for the full behavior matrix).
            const auth = await requireLocalAuth('Reveal recovery phrase');
            if (!auth.ok) {
              Alert.alert('Not revealed', auth.message);
              return;
            }
            const mnemonic = await revealMnemonic();
            if (mnemonic) {
              setRevealed(mnemonic);
            } else {
              Alert.alert('Not available', 'No recovery phrase found in secure storage.');
            }
          },
        },
      ],
    );
  };

  const onWipe = () => {
    // Double confirmation: wiping is irreversible without the paper backup.
    Alert.alert(
      'Wipe wallet?',
      'This deletes the recovery phrase from this device. The app returns to onboarding.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              'Are you absolutely sure?',
              'Without your written recovery phrase, the funds controlled by this wallet will be unrecoverable by anyone, forever.',
              [
                { text: 'Keep my wallet', style: 'cancel' },
                {
                  text: 'Wipe wallet',
                  style: 'destructive',
                  onPress: async () => {
                    setRevealed(null);
                    await wipe();
                  },
                },
              ],
            );
          },
        },
      ],
    );
  };

  return (
    <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Backup</Text>
        {revealed ? (
          <View style={styles.revealBlock}>
            <WarningBox>
              Never share these words. Shiba Wallet support will never ask for
              them. Hide them again as soon as you are done.
            </WarningBox>
            <WordGrid words={revealed.split(' ')} />
            <Button title="Hide recovery phrase" variant="secondary" onPress={() => setRevealed(null)} />
          </View>
        ) : (
          <Button title="Show recovery phrase" variant="secondary" onPress={onReveal} />
        )}
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Network endpoints</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Where balances are fetched from and, later, where transactions are
          broadcast. Endpoints are public configuration — no keys or secrets.
          Balances refresh with the new endpoint on the next pull-to-refresh.
        </Text>
        {endpoints.map((endpoint) => (
          <EndpointRow
            key={endpoint.network.chainId}
            endpoint={endpoint}
            onChanged={reloadEndpoints}
          />
        ))}
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>
          Account Abstraction (experimental)
        </Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Optional ERC-4337 setup per EVM chain: a bundler endpoint and a
          SimpleAccountFactory address. Both are verified before saving —
          the bundler must support EntryPoint v0.7, and the factory is
          checked on-chain through your configured RPC endpoint (it must
          have code, and its account implementation must point at EntryPoint
          v0.7). When both are set, the Send screen offers an experimental
          "Send from smart account" toggle. Off by default; nothing changes
          for regular sends.
        </Text>
        {DEFAULT_NETWORKS.filter((n) => n.kind === 'evm-jsonrpc').map((network) => (
          <AaChainRow key={network.chainId} network={network} />
        ))}
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>WalletConnect</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Lets external dApps connect to this wallet (Ethereum mainnet only
          for now). Requires a relay project id — create one for free at
          dashboard.reown.com. The id is public app configuration, not a
          secret; no account or personal data from this wallet is involved.
          If a connection was already opened this session, a changed id
          takes effect after the app restarts.
        </Text>
        <AaField
          label="Reown / WalletConnect project id"
          placeholder="32-character id from dashboard.reown.com"
          value={wcProjectId}
          statusLine={wcProjectId ? 'Saved — used to reach the WalletConnect relay.' : null}
          saveLabel="Save"
          onSave={async (draft) => {
            await setWcProjectId(draft);
            reloadWcProjectId();
          }}
          onClear={async () => {
            await clearWcProjectId();
            reloadWcProjectId();
          }}
        />
        <Button
          title="Open connections"
          variant="secondary"
          onPress={() => navigation.navigate('Connections')}
        />
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Tokens</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Track ERC-20 token balances on the Home screen (balances only —
          sending tokens is not supported yet).
        </Text>
        <Button
          title="Manage tokens"
          variant="secondary"
          onPress={() => navigation.navigate('Tokens')}
        />
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Danger zone</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Wiping removes the recovery phrase from this device's secure
          storage. Your written backup remains the only way to restore the
          wallet.
        </Text>
        <Button title="Wipe wallet from this device" variant="destructive" onPress={onWipe} />
      </View>

      <Text style={[styles.about, { color: theme.textMuted }]}>
        Shiba Wallet is non-custodial: keys are generated, stored and used
        only on this device.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 24,
    gap: 28,
  },
  section: {
    gap: 12,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  revealBlock: {
    gap: 14,
  },
  hint: {
    fontSize: 13,
    lineHeight: 19,
  },
  about: {
    fontSize: 12,
    textAlign: 'center',
  },
  endpointRow: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    gap: 10,
  },
  endpointHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  endpointLabel: {
    fontSize: 15,
    fontWeight: '600',
  },
  endpointTag: {
    fontSize: 12,
  },
  endpointEditor: {
    gap: 10,
  },
  endpointUrl: {
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
  endpointNote: {
    fontSize: 12,
    lineHeight: 17,
  },
  endpointInput: {
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  endpointButtons: {
    flexDirection: 'row',
    gap: 10,
  },
  endpointButton: {
    flex: 1,
  },
  aaField: {
    gap: 8,
  },
  aaFieldLabel: {
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  aaStatus: {
    fontSize: 13,
  },
  aaVerified: {
    fontSize: 12,
    lineHeight: 17,
  },
});
