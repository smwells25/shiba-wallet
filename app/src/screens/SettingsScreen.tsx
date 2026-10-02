import React, { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { allowScreenCaptureAsync, preventScreenCaptureAsync } from 'expo-screen-capture';
import { Button, WarningBox, WordGrid, screenStyle } from '../components';
import { AccountsSection } from '../components/AccountsSection';
import {
  NetworkEndpoint,
  getAllEndpoints,
  getEndpoint,
  resetEndpoint,
  setEndpointOverride,
} from '../config/networks';
import { type NetworkDefault } from '../config/defaults';
import { describeDefaultChoice, describeDefaultFallbackNote } from '../config/endpoint-probe';
import { AUTO_LOCK_CHOICES } from '../config/prefs';
import { useTheme } from '../theme';
import { useWallet } from '../wallet/WalletContext';
import { usePrefs } from '../wallet/PrefsContext';
import { localAuthAvailable, requireLocalAuth } from '../wallet/biometric';
import {
  AA_ACCOUNT_TYPES,
  KERNEL_BUNDLER_NOTE,
  KERNEL_PREFILL,
  aaAccountTypeLabel,
  clearAaBundlerUrl,
  clearAaFactory,
  getAaConfig,
  setAaBundlerUrl,
  setAaFactory,
  setAaKernelFactory,
  setAaPaymaster,
  clearAaPaymaster,
  maskUrlForDisplay,
  type AaAccountType,
  type AaChainConfig,
} from '../wallet/aa';
import { clearWcProjectId, getWcProjectId, setWcProjectId } from '../wallet/walletconnect';
import {
  clearIndexerUrl,
  getIndexerConfig,
  setIndexerUrl,
  type IndexerConfig,
} from '../wallet/indexer';
import {
  clearNftIndexerUrl,
  getNftIndexerConfig,
  setNftIndexerUrl,
  type NftIndexerConfig,
} from '../wallet/nfts';
import { clearSwapApiKey, getSwapConfig, setSwapApiKey, type SwapConfig } from '../wallet/swap';
import {
  clearPriceDemoKey,
  getPriceConfig,
  setPriceDemoKey,
  type PriceConfig,
} from '../wallet/prices';
import {
  BLOCKBOOK_API_KEY_HEADER,
  clearBlockbookConfig,
  getBlockbookConfig,
  setBlockbookEndpoint,
  type BlockbookConfig,
} from '../wallet/blockbook';
import { EVM_CHAIN_ID } from '../wallet/send';

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

  const { network, url, isOverride, defaultChoice } = endpoint;
  // Which default candidate is active ("default (2 of 2: host)") and, when
  // the primary failed its probe, a short plain-language note. In-memory
  // state from config/networks.ts; nothing new is stored.
  const tag = isOverride ? 'custom' : defaultChoice ? describeDefaultChoice(defaultChoice) : 'default';
  const fallbackNote =
    !isOverride && defaultChoice
      ? describeDefaultFallbackNote(defaultChoice, network.defaultUrls)
      : null;

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
        <Text style={[styles.endpointTag, { color: theme.textMuted }]} numberOfLines={1}>
          {tag}
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
          {(isOverride || network.defaultUrls.length > 0) && (
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
          {fallbackNote ? (
            <Text style={[styles.endpointNote, { color: theme.textMuted }]}>{fallbackNote}</Text>
          ) : null}
          <Button title="Edit" variant="secondary" onPress={beginEdit} />
        </View>
      )}
    </View>
  );
}

/**
 * The endpoint row for a Blockbook-served chain (Dogecoin): base URL plus
 * an optional API key, saved together behind mandatory verification — the
 * save button runs a live UTXO query for the wallet's own address through
 * the exact request the engine's transport makes, and nothing persists
 * unless it answers with the Blockbook array shape
 * (../wallet/blockbook.ts refuses otherwise). The API key is stored in
 * AsyncStorage on this device only and is sent solely to the configured
 * host, as the api-key request header (BLOCKBOOK_API_KEY_HEADER).
 */
function BlockbookRow({
  endpoint,
  walletAddress,
  onChanged,
}: {
  endpoint: NetworkEndpoint;
  walletAddress: string | null;
  onChanged: () => void;
}) {
  const theme = useTheme();
  const { network } = endpoint;
  const [config, setConfig] = useState<BlockbookConfig | null>(null);
  const [editing, setEditing] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');
  const [keyDraft, setKeyDraft] = useState('');
  const [verifying, setVerifying] = useState(false);

  const reload = useCallback(() => {
    getBlockbookConfig(network.chainId).then(setConfig, () => setConfig(null));
  }, [network.chainId]);

  useEffect(reload, [reload]);

  const beginEdit = () => {
    setUrlDraft(config?.url ?? '');
    setKeyDraft(config?.apiKey ?? '');
    setEditing(true);
  };

  const save = async () => {
    setVerifying(true);
    try {
      if (!walletAddress) {
        throw new Error('No wallet address is available to verify the endpoint with.');
      }
      await setBlockbookEndpoint(network.chainId, urlDraft, keyDraft, walletAddress);
      setEditing(false);
      reload();
      onChanged();
    } catch (e) {
      Alert.alert(
        'Not saved — verification failed',
        e instanceof Error ? e.message : 'Verification failed.',
      );
    } finally {
      setVerifying(false);
    }
  };

  const clear = async () => {
    await clearBlockbookConfig(network.chainId);
    setEditing(false);
    reload();
    onChanged();
  };

  return (
    <View style={[styles.endpointRow, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <View style={styles.endpointHeader}>
        <Text style={[styles.endpointLabel, { color: theme.text }]}>{network.label}</Text>
        <Text style={[styles.endpointTag, { color: theme.textMuted }]}>
          {config?.url ? 'blockbook' : 'not set'}
        </Text>
      </View>
      {editing ? (
        <View style={styles.endpointEditor}>
          <Text style={[styles.aaFieldLabel, { color: theme.textMuted }]}>Blockbook base URL</Text>
          <TextInput
            value={urlDraft}
            onChangeText={setUrlDraft}
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
          <Text style={[styles.aaFieldLabel, { color: theme.textMuted }]}>
            API key (optional)
          </Text>
          <TextInput
            value={keyDraft}
            onChangeText={setKeyDraft}
            placeholder="Provider API key, if required"
            placeholderTextColor={theme.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            style={[
              styles.endpointInput,
              { color: theme.text, borderColor: theme.border, backgroundColor: theme.background },
            ]}
          />
          <Text style={[styles.endpointNote, { color: theme.textMuted }]}>
            The key is stored only on this device and sent only to this
            host, as the "{BLOCKBOOK_API_KEY_HEADER}" request header (the
            header NOWNodes uses). Saving verifies the endpoint first with
            a UTXO query for your own {network.symbol} address.
          </Text>
          {verifying ? (
            <Text style={[styles.aaStatus, { color: theme.textMuted }]}>
              Verifying before saving…
            </Text>
          ) : (
            <View style={styles.endpointButtons}>
              <Button title="Verify & save" onPress={() => void save()} style={styles.endpointButton} />
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
            {config?.url ?? 'Not configured'}
          </Text>
          {config?.url ? (
            <Text style={[styles.aaVerified, { color: theme.success }]}>
              Verified ✓ — /api/v2/utxo answered for your address (checked{' '}
              {config.verifiedAt ? config.verifiedAt.slice(0, 10) : 'unknown date'}).{' '}
              {config.apiKey ? 'API key set.' : 'No API key.'}
            </Text>
          ) : network.note ? (
            <Text style={[styles.endpointNote, { color: theme.textMuted }]}>{network.note}</Text>
          ) : null}
          <View style={styles.endpointButtons}>
            <Button title="Edit" variant="secondary" onPress={beginEdit} style={styles.endpointButton} />
            {config?.url ? (
              <Button
                title="Clear"
                variant="secondary"
                onPress={() => void clear()}
                style={styles.endpointButton}
              />
            ) : null}
          </View>
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
  prefill = null,
  prefillNote = null,
  onSave,
  onClear,
  saveLabel = 'Verify & save',
}: {
  label: string;
  placeholder: string;
  value: string | null;
  /** Verification status for the stored value (shown when configured). */
  statusLine: string | null;
  /**
   * Pinned default the editor starts from when no value is stored yet
   * (phase 4 item 6: the verified Sepolia factory). Saving still runs the
   * full verification — a prefill is a convenience, never a bypass.
   */
  prefill?: string | null;
  /** Explanatory line shown under the editor when the prefill was used. */
  prefillNote?: string | null;
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
          {prefill && draft === prefill && prefillNote ? (
            <Text style={[styles.aaVerified, { color: theme.textMuted }]}>{prefillNote}</Text>
          ) : null}
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
            {value ? maskUrlForDisplay(value) : 'Not configured'}
          </Text>
          {value && statusLine ? (
            <Text style={[styles.aaVerified, { color: theme.success }]}>{statusLine}</Text>
          ) : null}
          <View style={styles.endpointButtons}>
            <Button
              title="Edit"
              variant="secondary"
              onPress={() => {
                // Start from the stored value, else the pinned prefill
                // (the verified Sepolia defaults in test mode).
                setDraft(value ?? prefill ?? '');
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

/**
 * AA configuration for one EVM chain: bundler URL + account type + factory
 * address, keyed by the ACTIVE chain's CAIP-2 id (network.chainId is
 * 'eip155:11155111' while Sepolia test mode is on, so mainnet and Sepolia
 * AA setups never share a key). The account type (phase 7 item 1) selects
 * which factory editor and which on-chain verification run: SimpleAccount
 * (docs/AA_STACK.md procedure; pre-filled in Sepolia mode with the pinned
 * factory from config/evm-chain.ts) or Kernel v3.3 (engine
 * verifyKernelDeployment; pre-filled on both networks with the engine's
 * KERNEL_V3_3 factory). Saving always re-runs the verification before
 * anything persists, and saving one type replaces the other. The bundler
 * URL has no prefill on purpose: bundler endpoints embed the user's API
 * key and stay runtime configuration, never shipped defaults.
 */
function AaChainRow({ network }: { network: NetworkDefault }) {
  const theme = useTheme();
  const { evmChain } = usePrefs();
  const [config, setConfig] = useState<AaChainConfig | null>(null);
  // The type whose editor is shown; starts at the stored type.
  const [selectedType, setSelectedType] = useState<AaAccountType | null>(null);

  const reload = useCallback(() => {
    getAaConfig(network.chainId).then(
      (c) => {
        setConfig(c);
        setSelectedType((prev) => prev ?? (c.factory ? c.accountType : 'kernel-v3.3'));
      },
      () => setConfig(null),
    );
  }, [network.chainId]);

  useEffect(reload, [reload]);

  const shortDate = (iso: string | null) => (iso ? iso.slice(0, 10) : 'unknown date');
  const simplePrefill = network.chainId === evmChain.caip2 ? evmChain.aaPrefill : null;
  const type: AaAccountType = selectedType ?? 'kernel-v3.3';
  // The stored factory belongs to the selected type only when the types match.
  const storedForType = config?.factory && config.accountType === type ? config : null;
  const otherTypeStored = config?.factory && config.accountType !== type ? config.accountType : null;

  return (
    <View style={[styles.endpointRow, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <View style={styles.endpointHeader}>
        <Text style={[styles.endpointLabel, { color: theme.text }]}>{network.label}</Text>
        <Text style={[styles.endpointTag, { color: theme.textMuted }]}>
          {config && config.bundlerUrl && config.factory
            ? `ready · ${aaAccountTypeLabel(config.accountType)}`
            : 'incomplete'}
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
      <Text style={[styles.aaFieldLabel, { color: theme.textMuted }]}>Smart-account type</Text>
      <View style={styles.endpointButtons}>
        {AA_ACCOUNT_TYPES.map((t) => (
          <Button
            key={t}
            title={t === type ? `✓ ${aaAccountTypeLabel(t)}` : aaAccountTypeLabel(t)}
            variant={t === type ? 'primary' : 'secondary'}
            onPress={() => setSelectedType(t)}
            style={styles.endpointButton}
          />
        ))}
      </View>
      {type === 'kernel-v3.3' ? (
        <Text style={[styles.endpointNote, { color: theme.textMuted }]}>
          Kernel v3.3 is an ERC-7579 modular account with this account&apos;s key as
          its owner (ECDSA validator). It supports message signing for dApps
          (ERC-1271; ERC-6492 before it is deployed). {KERNEL_BUNDLER_NOTE}
        </Text>
      ) : (
        <Text style={[styles.endpointNote, { color: theme.textMuted }]}>
          SimpleAccount (the eth-infinitism v0.7 sample) sends and batches calls,
          but it has no ERC-1271 support, so it cannot sign messages or logins
          for dApps.
        </Text>
      )}
      {config && config.eip7702Owners.length > 0 ? (
        <Text style={[styles.endpointNote, { color: theme.textMuted }]}>
          {config.eip7702Owners.length === 1 ? 'One account uses' : `${config.eip7702Owners.length} accounts use`}{' '}
          its own address as the smart account on this network (EIP-7702, Kernel v3.3; see
          Upgrade this account). Those accounts need only the bundler; the type below applies to
          every other account.
        </Text>
      ) : null}
      {otherTypeStored ? (
        <Text style={[styles.endpointNote, { color: theme.warningText }]}>
          This network is currently set up as {aaAccountTypeLabel(otherTypeStored)}. Saving a{' '}
          {aaAccountTypeLabel(type)} factory replaces that setup (a different smart-account
          address; funds at the old one stay there).
        </Text>
      ) : null}
      {type === 'kernel-v3.3' ? (
        <AaField
          key="kernel-v3.3"
          label="KernelFactory address (Kernel v3.3)"
          placeholder="0x…"
          value={storedForType?.factory ?? null}
          prefill={KERNEL_PREFILL.factory}
          prefillNote={
            `Pinned Kernel v3.3 deployment from the wallet engine (the same addresses on ` +
            `mainnet and Sepolia): implementation ${KERNEL_PREFILL.implementation}, meta ` +
            `factory ${KERNEL_PREFILL.metaFactory}, ECDSA validator ` +
            `${KERNEL_PREFILL.ecdsaValidator}. Saving re-runs the full on-chain ` +
            'verification through your RPC endpoint.'
          }
          statusLine={
            storedForType
              ? `Verified ✓ — factory, implementation ${
                  storedForType.factoryImplementation ?? 'unknown'
                }, meta factory and ECDSA validator have code; entrypoint() is v0.7; ` +
                `accountId() is ${storedForType.kernelAccountId ?? 'unknown'}; the meta factory ` +
                `approves the factory (checked ${shortDate(storedForType.factoryVerifiedAt)})`
              : null
          }
          onSave={async (draft) => {
            const endpoint = await getEndpoint(network.chainId);
            if (!endpoint?.url) {
              throw new Error(
                `No ${network.label} RPC endpoint is configured; the Kernel deployment is ` +
                  'verified on-chain through it. Configure the endpoint above first.',
              );
            }
            await setAaKernelFactory(network.chainId, draft, endpoint.url);
            reload();
          }}
          onClear={async () => {
            await clearAaFactory(network.chainId);
            reload();
          }}
        />
      ) : (
        <AaField
          key="simple"
          label="SimpleAccountFactory address"
          placeholder="0x…"
          value={storedForType?.factory ?? null}
          prefill={simplePrefill?.factory ?? null}
          prefillNote={
            simplePrefill
              ? `Pinned Sepolia default (verified on-chain 2026-09-27; implementation ` +
                `${simplePrefill.implementation}, EntryPoint v0.7 ${simplePrefill.entryPoint}). ` +
                'Saving re-runs the full on-chain verification through your RPC endpoint.'
              : null
          }
          statusLine={
            storedForType
              ? `Verified ✓ — has code; implementation ${
                  storedForType.factoryImplementation ?? 'unknown'
                } has code and its entryPoint() is v0.7 (checked ${shortDate(
                  storedForType.factoryVerifiedAt,
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
      )}
      <AaField
        label="Paymaster URL (ERC-7677, optional)"
        placeholder="https://…"
        value={config?.paymasterUrl ?? null}
        statusLine={
          config?.paymasterUrl
            ? `Verified ✓ — answers pm_getPaymasterStubData (checked ${shortDate(
                config.paymasterVerifiedAt,
              )}). Gas on smart-account sends is sponsored.`
            : null
        }
        onSave={async (draft) => {
          await setAaPaymaster(network.chainId, draft, config?.paymasterContext ?? '');
          reload();
        }}
        onClear={async () => {
          await clearAaPaymaster(network.chainId);
          reload();
        }}
      />
      {config?.paymasterUrl ? (
        <AaField
          label="Paymaster context (JSON, optional)"
          placeholder='{"policyId":"…"}'
          value={config?.paymasterContext ?? null}
          statusLine={
            config?.paymasterContext
              ? 'Sent verbatim to the paymaster with each sponsorship request.'
              : null
          }
          onSave={async (draft) => {
            await setAaPaymaster(network.chainId, config.paymasterUrl!, draft);
            reload();
          }}
          onClear={async () => {
            await setAaPaymaster(network.chainId, config.paymasterUrl!, '');
            reload();
          }}
        />
      ) : null}
    </View>
  );
}

/**
 * History-indexer configuration for one EVM chain. Reuses the AaField
 * verify-before-save pattern: saving runs eth_chainId plus a one-transfer
 * alchemy_getAssetTransfers probe (../wallet/indexer.ts), and nothing is
 * persisted when either check fails.
 */
function IndexerChainRow({
  network,
  walletAddress,
}: {
  network: NetworkDefault;
  walletAddress: string | null;
}) {
  const theme = useTheme();
  const [config, setConfig] = useState<IndexerConfig | null>(null);

  const reload = useCallback(() => {
    getIndexerConfig(network.chainId).then(setConfig, () => setConfig(null));
  }, [network.chainId]);

  useEffect(reload, [reload]);

  const shortDate = (iso: string | null) => (iso ? iso.slice(0, 10) : 'unknown date');

  return (
    <View style={[styles.endpointRow, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <View style={styles.endpointHeader}>
        <Text style={[styles.endpointLabel, { color: theme.text }]}>{network.label}</Text>
        <Text style={[styles.endpointTag, { color: theme.textMuted }]}>
          {config?.url ? 'ready' : 'not set'}
        </Text>
      </View>
      <AaField
        label="History indexer URL (Transfers API)"
        placeholder="https://…"
        value={config?.url ?? null}
        statusLine={
          config?.url
            ? `Verified ✓ — chain id matches and alchemy_getAssetTransfers ` +
              `answered with a well-formed response (checked ${shortDate(config.verifiedAt)})`
            : null
        }
        onSave={async (draft) => {
          if (!walletAddress) {
            throw new Error('No wallet address is available to verify the endpoint with.');
          }
          await setIndexerUrl(network.chainId, draft, walletAddress);
          reload();
        }}
        onClear={async () => {
          await clearIndexerUrl(network.chainId);
          reload();
        }}
      />
    </View>
  );
}

/**
 * NFT-indexer configuration for one EVM chain (phase 7 item 4), beside the
 * history indexer and with the same verify-before-save UX: saving runs a
 * one-entry getNFTsForOwner probe and binds the indexer's answer to this
 * chain through the configured RPC endpoint (../wallet/nfts.ts); nothing
 * is persisted when any check fails.
 */
function NftIndexerChainRow({
  network,
  walletAddress,
}: {
  network: NetworkDefault;
  walletAddress: string | null;
}) {
  const theme = useTheme();
  const [config, setConfig] = useState<NftIndexerConfig | null>(null);

  const reload = useCallback(() => {
    getNftIndexerConfig(network.chainId).then(setConfig, () => setConfig(null));
  }, [network.chainId]);

  useEffect(reload, [reload]);

  const shortDate = (iso: string | null) => (iso ? iso.slice(0, 10) : 'unknown date');

  return (
    <View style={[styles.endpointRow, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <View style={styles.endpointHeader}>
        <Text style={[styles.endpointLabel, { color: theme.text }]}>{network.label}</Text>
        <Text style={[styles.endpointTag, { color: theme.textMuted }]}>
          {config?.url ? 'ready' : 'not set'}
        </Text>
      </View>
      <AaField
        label="NFT indexer URL (NFT API base)"
        placeholder="https://…/nft/v3/…"
        value={config?.url ?? null}
        statusLine={
          config?.url
            ? `Verified ✓ — getNFTsForOwner answered and its block ${
                config.verifiedBlock ?? '?'
              } matches ${network.label} (checked ${shortDate(config.verifiedAt)})`
            : null
        }
        onSave={async (draft) => {
          if (!walletAddress) {
            throw new Error('No wallet address is available to verify the endpoint with.');
          }
          const endpoint = await getEndpoint(network.chainId);
          if (!endpoint?.url) {
            throw new Error(
              `No ${network.label} RPC endpoint is configured; the indexer's network is ` +
                'confirmed through it. Configure the endpoint above first.',
            );
          }
          await setNftIndexerUrl(network.chainId, draft, walletAddress, endpoint.url, {
            chainLabel: network.label,
          });
          reload();
        }}
        onClear={async () => {
          await clearNftIndexerUrl(network.chainId);
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
  const { revealMnemonic, wipe, accounts } = useWallet();
  const {
    sepolia,
    setSepolia,
    hideAmounts,
    setHideAmounts,
    autoLockMs,
    setAutoLockMs,
    showFiat,
    setShowFiat,
  } = usePrefs();
  const [revealed, setRevealed] = useState<string | null>(null);

  // Block screenshots while the revealed recovery phrase is on screen
  // (and re-allow when it is hidden or the screen unmounts). Uses a
  // dedicated key so other screens' guards are unaffected.
  useEffect(() => {
    if (revealed) {
      preventScreenCaptureAsync('seed-reveal').catch(() => {});
      return () => {
        allowScreenCaptureAsync('seed-reveal').catch(() => {});
      };
    }
    return undefined;
  }, [revealed]);
  const [endpoints, setEndpoints] = useState<NetworkEndpoint[]>([]);
  const [wcProjectId, setWcProjectIdState] = useState<string | null>(null);
  // Auto-lock is only offered when a local-auth prompt would actually
  // appear; see the note in the Privacy & security section below.
  const [authAvailable, setAuthAvailable] = useState<boolean | null>(null);

  const reloadEndpoints = useCallback(() => {
    getAllEndpoints().then(setEndpoints, () => setEndpoints([]));
    // sepolia in the deps: flipping the developer toggle swaps the EVM row
    // (and the AA/indexer sections keyed off it) immediately.
  }, [sepolia]);

  useEffect(reloadEndpoints, [reloadEndpoints]);

  useEffect(() => {
    let cancelled = false;
    localAuthAvailable().then(
      (ok) => {
        if (!cancelled) setAuthAvailable(ok);
      },
      () => {
        if (!cancelled) setAuthAvailable(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // The EVM-dependent sections (history indexer, Account Abstraction) are
  // keyed by the ACTIVE EVM network so their configuration lands under the
  // active chain id — 'eip155:11155111' in Sepolia test mode. forChainId
  // (the stable slot id) still links each row to its wallet account.
  const evmEndpoints = endpoints.filter((e) => e.network.kind === 'evm-jsonrpc');

  const reloadWcProjectId = useCallback(() => {
    getWcProjectId().then(setWcProjectIdState, () => setWcProjectIdState(null));
  }, []);

  useEffect(reloadWcProjectId, [reloadWcProjectId]);

  const [swapConfig, setSwapConfigState] = useState<SwapConfig | null>(null);
  const reloadSwapConfig = useCallback(() => {
    getSwapConfig().then(setSwapConfigState, () => setSwapConfigState(null));
  }, []);

  useEffect(reloadSwapConfig, [reloadSwapConfig]);

  const [priceConfig, setPriceConfigState] = useState<PriceConfig | null>(null);
  const reloadPriceConfig = useCallback(() => {
    getPriceConfig().then(setPriceConfigState, () => setPriceConfigState(null));
  }, []);

  useEffect(reloadPriceConfig, [reloadPriceConfig]);

  const onReveal = () => {
    Alert.alert(
      'Show recovery phrase?',
      'Make sure no one can see your screen. Anyone who sees these words can steal the funds of every account in this wallet.',
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
      <AccountsSection />

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Backup</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          One recovery phrase backs up ALL of your accounts — every account
          in the list above, including hidden ones, on every chain.
        </Text>
        {revealed ? (
          <View style={styles.revealBlock}>
            <WarningBox>
              Never share these words. They control every account in this
              wallet, not just the active one. Shiba Wallet support will never
              ask for them. Hide them again as soon as you are done.
            </WarningBox>
            <WordGrid words={revealed.split(' ')} />
            {/*
              CLIPBOARD HYGIENE (phase 4, item 5.3): there is deliberately
              NO copy button here. The system clipboard is readable by
              other apps (and, on some platforms, synced across devices or
              kept in a clipboard history), and expo-clipboard exposes no
              sensitive-content flag, history exclusion, or expiry
              (verified against docs.expo.dev/versions/v57.0.0/sdk/clipboard
              and the installed 57.0.2 type definitions: SetStringOptions
              has only inputFormat). Writing it down on paper is the
              recovery model; the seed phrase never belongs on the
              clipboard.
            */}
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              These words are shown only — there is deliberately no copy
              button, because anything on the clipboard can be read by
              other apps. Write them down on paper.
            </Text>
            <Button title="Hide recovery phrase" variant="secondary" onPress={() => setRevealed(null)} />
          </View>
        ) : (
          <Button title="Show recovery phrase" variant="secondary" onPress={onReveal} />
        )}
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Privacy & security</Text>
        <View style={styles.toggleRow}>
          <Text style={[styles.toggleLabel, { color: theme.text }]}>Hide amounts</Text>
          <Switch value={hideAmounts} onValueChange={(v) => void setHideAmounts(v)} />
        </View>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Masks every balance and activity amount as •••• (also toggleable
          with the eye on the Home screen). Addresses stay visible.
        </Text>
        {authAvailable ? (
          <>
            <Text style={[styles.toggleLabel, { color: theme.text }]}>
              Auto-lock after returning from background
            </Text>
            <View style={styles.endpointButtons}>
              {AUTO_LOCK_CHOICES.map((choice) => (
                <Button
                  key={choice.label}
                  title={autoLockMs === choice.ms ? `✓ ${choice.label}` : choice.label}
                  variant={autoLockMs === choice.ms ? 'primary' : 'secondary'}
                  onPress={() => void setAutoLockMs(choice.ms)}
                  style={styles.endpointButton}
                />
              ))}
            </View>
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              When the app has been in the background at least this long, it
              locks behind the same biometric prompt as sending (with your
              device passcode as the system fallback). Screen state is kept —
              locking never discards what you were doing.
            </Text>
          </>
        ) : authAvailable === false ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Auto-lock is unavailable on this device: no biometric hardware or
            enrollment was found, so the unlock prompt could not appear. The
            wallet deliberately does not substitute its own PIN screen — an
            in-app PIN would be weaker than your device's own lock screen,
            which already protects the secure storage holding your recovery
            phrase. Set up a device passcode and biometrics to enable
            auto-lock.
          </Text>
        ) : null}
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Prices</Text>
        <View style={styles.toggleRow}>
          <Text style={[styles.toggleLabel, { color: theme.text }]}>Show fiat values (USD)</Text>
          <Switch value={showFiat} onValueChange={(v) => void setShowFiat(v)} />
        </View>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Shows an approximate US-dollar value next to balances and on the
          send and swap confirmation screens. Prices are fetched from
          CoinGecko (api.coingecko.com), which sees your IP address and
          which assets are being priced — never your addresses or balances.
          Turning this off stops all price requests. Prices are indicative
          only; the exact crypto amount is always the one that counts, and
          test-network assets are never priced.
        </Text>
        {showFiat ? (
          <>
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              Optional: a free CoinGecko Demo API key (from your CoinGecko
              developer dashboard) gives a higher rate limit than keyless
              requests. It is stored only on this device and sent only to
              api.coingecko.com. Saving runs one live price request with the
              key first, and nothing is saved if it fails. CoinGecko does not
              offer a way to confirm a Demo key is genuine, so a pass means
              the request with the key worked.
            </Text>
            <AaField
              label="CoinGecko Demo API key (optional)"
              placeholder="Demo API key from CoinGecko"
              value={priceConfig?.demoApiKey ?? null}
              statusLine={
                priceConfig?.demoApiKey
                  ? `Checked ✓ — a live price request with this key succeeded (${
                      priceConfig.verifiedAt ? priceConfig.verifiedAt.slice(0, 10) : 'unknown date'
                    })`
                  : null
              }
              onSave={async (draft) => {
                await setPriceDemoKey(draft);
                reloadPriceConfig();
              }}
              onClear={async () => {
                await clearPriceDemoKey();
                reloadPriceConfig();
              }}
            />
          </>
        ) : null}
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Network endpoints</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Where balances are fetched from and where transactions are
          broadcast. Endpoint URLs are public configuration; Dogecoin's
          Blockbook endpoint may additionally need a provider API key,
          which is stored only on this device and sent only to that host.
          Balances refresh with the new endpoint on the next
          pull-to-refresh. Without a custom endpoint, each chain uses the
          first of its built-in public defaults that answers; if that one
          stops answering, the next is tried automatically.
        </Text>
        {endpoints.map((endpoint) =>
          endpoint.network.kind === 'blockbook' ? (
            <BlockbookRow
              key={endpoint.network.chainId}
              endpoint={endpoint}
              walletAddress={
                accounts.find((a) => a.chainId === endpoint.forChainId)?.address ?? null
              }
              onChanged={reloadEndpoints}
            />
          ) : (
            <EndpointRow
              key={endpoint.network.chainId}
              endpoint={endpoint}
              onChanged={reloadEndpoints}
            />
          ),
        )}
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>
          Ethereum history indexer
        </Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Transaction history on the Activity screen needs an indexer: a
          standard JSON-RPC endpoint cannot list transactions by address.
          Paste an endpoint that serves the Transfers API
          (alchemy_getAssetTransfers). The URL usually contains your own
          API key — it is stored only on this device and sent only to the
          endpoint itself. Saving verifies the endpoint first and refuses
          URLs for the wrong chain.
        </Text>
        {evmEndpoints.map((e) => (
          <IndexerChainRow
            key={e.network.chainId}
            network={e.network}
            walletAddress={
              accounts.find((a) => a.chainId === e.forChainId)?.address ?? null
            }
          />
        ))}
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>NFT indexer</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          The NFTs screen needs an indexer that lists the NFTs an address
          owns (ERC-721 and ERC-1155). Paste the base URL of an endpoint that
          serves Alchemy&apos;s NFT API v3 — it looks like
          https://eth-mainnet.g.alchemy.com/nft/v3/your-key (Sepolia:
          eth-sepolia). This is a separate URL from the history indexer
          above, even when both use the same API key. It is stored only on
          this device and sent only to that host. Saving checks that the
          indexer answers and that it is indexing this network. NFT images
          load from the indexer&apos;s image cache when possible, otherwise
          from the NFT&apos;s own host or the public ipfs.io gateway, which
          see your IP address.
        </Text>
        {evmEndpoints.map((e) => (
          <NftIndexerChainRow
            key={e.network.chainId}
            network={e.network}
            walletAddress={
              accounts.find((a) => a.chainId === e.forChainId)?.address ?? null
            }
          />
        ))}
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>
          Account Abstraction (experimental)
        </Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Optional ERC-4337 setup per EVM chain: a bundler endpoint, a
          smart-account type (Kernel v3.3 or SimpleAccount) and its factory.
          Everything is verified before saving — the bundler must support
          EntryPoint v0.7, and the factory is checked on-chain through your
          configured RPC endpoint. When set, the Send and Swap screens offer
          an experimental "from smart account" toggle (token sends and swaps
          run as one atomic batch), and WalletConnect can connect dApps to
          the smart account. Off by default; nothing changes for regular
          sends.
        </Text>
        {evmEndpoints.map((e) => (
          <AaChainRow key={e.network.chainId} network={e.network} />
        ))}
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>
          Upgrade this account (EIP-7702)
        </Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Turns the active account into a Kernel v3.3 smart account at the same
          address, on the active network, and shows its current status. You can
          undo it at any time. The wallet only ever delegates to the pinned
          Kernel v3.3 contract and never signs an account delegation for a dApp.
        </Text>
        <Button
          title="Upgrade this account"
          variant="secondary"
          onPress={() => navigation.navigate('UpgradeAccount')}
        />
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>WalletConnect</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Lets external dApps connect to this wallet on the active EVM
          chain (Ethereum mainnet, or Sepolia while test mode is on).
          Requires a relay project id — create one for free at
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
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Contacts</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Named addresses for each chain, picked from the Send screen. A name
          is shown only for an exact address match, always with the full
          address; look-alike addresses get a warning instead.
        </Text>
        <Button
          title="Manage contacts"
          variant="secondary"
          onPress={() => navigation.navigate('Contacts')}
        />
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Tokens</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Track ERC-20 tokens on the Home screen: balances, and sending
          with the network fee paid in ETH.
        </Text>
        <Button
          title="Manage tokens"
          variant="secondary"
          onPress={() => navigation.navigate('Tokens')}
        />
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Token approvals</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          See which contracts may move your tracked tokens and NFT collections
          without asking you again, and revoke them. Revoking is an ordinary
          transaction with a normal network fee.
        </Text>
        <Button
          title="Token approvals"
          variant="secondary"
          onPress={() => navigation.navigate('Approvals')}
        />
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Swaps</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Swapping (the Swap link on the Home screen) is priced by the 0x
          aggregator and needs your own API key — create one for free at
          dashboard.0x.org. The key is stored only on this device and sent
          only to api.0x.org with quote requests; it is never bundled or
          committed anywhere. Saving verifies the key first with one live
          quote request (nothing is traded), and a rejected key is not
          saved. The feature stays off until a key is saved here.
        </Text>
        <AaField
          label="0x API key"
          placeholder="API key from dashboard.0x.org"
          value={swapConfig?.apiKey ?? null}
          statusLine={
            swapConfig?.apiKey
              ? `Verified ✓ — a live quote request succeeded (checked ${
                  swapConfig.verifiedAt ? swapConfig.verifiedAt.slice(0, 10) : 'unknown date'
                })`
              : null
          }
          onSave={async (draft) => {
            const taker = accounts.find((a) => a.chainId === EVM_CHAIN_ID)?.address;
            if (!taker) {
              throw new Error('No Ethereum address is available to verify the key with.');
            }
            await setSwapApiKey(draft, taker);
            reloadSwapConfig();
          }}
          onClear={async () => {
            await clearSwapApiKey();
            reloadSwapConfig();
          }}
        />
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Developer</Text>
        <View style={styles.toggleRow}>
          <Text style={[styles.toggleLabel, { color: theme.text }]}>Sepolia test mode</Text>
          <Switch value={sepolia} onValueChange={(v) => void setSepolia(v)} />
        </View>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Switches the app's EVM chain to the Sepolia test network (chain id
          11155111): balances, sends, WalletConnect and the smart-account
          path all run against Sepolia with test ETH, an orange TESTNET
          banner replaces the mainnet warning, and explorer links go to
          sepolia.etherscan.io. Sepolia keeps its own endpoint, indexer and
          Account Abstraction configuration — nothing from mainnet is
          reused, and turning the toggle off restores mainnet exactly as it
          was. The Account Abstraction section pre-fills the verified
          Sepolia SimpleAccountFactory; the bundler URL still has to be
          pasted by you, because bundler endpoints contain your own API key.
          Tracked ERC-20 tokens are mainnet assets and are hidden while
          test mode is on.
        </Text>
        {sepolia ? (
          <Text style={[styles.hint, { color: '#e07800' }]}>
            Test mode is ON. Your addresses are the same on Sepolia as on
            mainnet — but anything sent here is test ETH with no value.
          </Text>
        ) : null}
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
    flexShrink: 1,
    marginLeft: 8,
    textAlign: 'right',
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
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  toggleLabel: {
    fontSize: 15,
    fontWeight: '600',
  },
});
