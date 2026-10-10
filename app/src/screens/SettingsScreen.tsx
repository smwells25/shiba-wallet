import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, Share, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import type { RootStackParamList, SettingsSectionId } from '../navigation';
import { allowScreenCaptureAsync, preventScreenCaptureAsync } from 'expo-screen-capture';
import { Button, WarningBox, WordGrid, screenStyle } from '../components';
import { localDateLabel } from '../config/dates';
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
import { INSECURE_ENDPOINT_MESSAGE } from '../config/endpoint-url';
import { AUTO_LOCK_CHOICES } from '../config/prefs';
import { EVM_MAINNET, EVM_PROFILES, EVM_TEST_PROFILES, l1CostInGasNote, type TestNetworkId } from '../config/evm-chain';

import {
  FEATURE_READINESS,
  READINESS_INTRO,
  READINESS_STATUS_LABEL,
  READINESS_TESTNET_HINT,
  readinessDisplayReason,
  readinessEvidenceLine,
  readinessGate,
  type FeatureReadiness,
  type PhraseProtectionState,
} from '../config/readiness';
import { useTheme, type Theme } from '../theme';
import { useWallet } from '../wallet/WalletContext';
import { usePrefs } from '../wallet/PrefsContext';
import {
  SCREEN_PROTECTION_ALWAYS_NOTE,
  SCREEN_PROTECTION_PLATFORM_NOTE,
  SCREEN_PROTECTION_SWITCH_LABEL,
  SCREEN_PROTECTION_TITLE,
  appScreenProtection,
  describeScreenProtectionStatus,
} from '../wallet/screen-protection';
import { localAuthAvailable, requireLocalAuth } from '../wallet/biometric';
import { storageProtection, upgradePhraseProtection, type StorageProtection } from '../wallet/storage';
import {
  PROTECT_BUTTON_TITLE,
  protectConfirmMessage,
  PROTECT_CONFIRM_TITLE,
  describeProtectionStatus,
  describeRevealFailure,
  describeUpgradeOutcome,
} from '../wallet/phrase-protection-copy';
import {
  AA_ACCOUNT_TYPES,
  bundlerVerifiedLine,
  kernelDeploymentNote,
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
import { clearWcProjectId, getWcProjectId, setWcProjectId, testNetworkLabelsOr } from '../wallet/walletconnect';
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
import { exportAllRecordsText, loadRecoveryRecords } from '../wallet/recovery';
import { passkeyGateNow } from '../wallet/passkey-native';
import { PASSKEY_AUDIT_NOTE, PASSKEY_EXPLANATION, PASSKEY_SELF_CALL_RISK } from '../wallet/passkeys';
import { settingsTokensFeeSentence } from '../wallet/token-gas';
import {
  SPENDING_HONESTY_SENTENCE,
  SPENDING_SECTION_TITLE,
  SPENDING_SETTINGS_HINT,
} from '../wallet/spending-policy';

/** "A, B and C" / "A, B or C". */
function listJoin(items: string[], conjunction: 'and' | 'or'): string {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} ${conjunction} ${items[items.length - 1]}` : items.join('');
}

/**
 * Settings → Developer: what the test-network choice does, built from the
 * test profiles (config/evm-chain.ts) so a new profile is described without
 * editing this text, and nothing here assumes how many test networks exist.
 */
const DEVELOPER_TEST_NETWORK_HINT = (() => {
  const nets = listJoin(EVM_TEST_PROFILES.map((p) => `${p.label} (chain id ${p.chainIdDecimal})`), 'or');
  const hosts = listJoin(
    EVM_TEST_PROFILES.map((p) => /^https:\/\/([^/]+)\//.exec(p.explorerTxBase)?.[1] ?? p.explorerTxBase),
    'or',
  );
  const kernel = EVM_TEST_PROFILES.filter((p) => p.kernelV33Verified).map((p) => p.label);
  const simple = EVM_TEST_PROFILES.filter((p) => p.aaPrefill !== null).map((p) => p.label);
  return (
    `Switches the app’s EVM chain to a test network — ${nets}, each paid in test ETH: balances, sends, ` +
    'WalletConnect and the smart-account path all run against the chosen network, an orange TESTNET banner ' +
    `replaces the mainnet warning, and explorer links go to ${hosts}. Each network keeps its own endpoint, ` +
    'indexer and Account Abstraction configuration — nothing is shared between mainnet and the test networks ' +
    'or between test networks, and choosing Off restores mainnet exactly as it was. The Account Abstraction ' +
    (simple.length > 0 ? `section pre-fills the verified SimpleAccountFactory on ${listJoin(simple, 'and')} and ` : 'section pre-fills ') +
    `the Kernel v3.3 factory on ${listJoin(kernel, 'and')}; the bundler URL still has to be pasted by you for ` +
    'each network, because bundler endpoints contain your own API key. Tracked ERC-20 tokens are kept per ' +
    'network too: each test network starts with the test tokens known for it (no value), and your mainnet ' +
    'token list is unchanged.'
  );
})();

/**
 * The chains where the pinned Kernel v3.3 addresses were checked on-chain
 * (config/evm-chain.ts kernelV33Verified), as a plain list for the AA
 * pre-fill note: "Ethereum mainnet, Ethereum Sepolia and Base Sepolia".
 */
const KERNEL_VERIFIED_CHAINS_TEXT = (() => {
  const names = EVM_PROFILES.filter((p) => p.kernelV33Verified).map((p) =>
    p.testnet ? p.label : `${p.label} mainnet`,
  );
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join('');
})();

/**
 * Status line for a stored endpoint URL that fails the https rule on read
 * (saved before the rule existed): the app does not use it, and the user
 * removes it explicitly. `reason` is the stored value's refusal message
 * from config/endpoint-url.ts.
 */
function ignoredUrlStatus(reason: string, removeHint: string): string {
  return `A saved URL is not used: ${reason} ${removeHint}`;
}

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
        {/* No line limit: the tag names the default endpoint's host, which a
            long test-network host would otherwise cut off; it wraps instead. */}
        <Text style={[styles.endpointTag, { color: theme.textMuted }]}>{tag}</Text>
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
          {(isOverride || endpoint.ignoredReason !== undefined || network.defaultUrls.length > 0) && (
            <Button
              title="Reset to default"
              variant="secondary"
              onPress={() =>
                isOverride || endpoint.ignoredReason !== undefined
                  ? confirmClear(`custom ${network.label} endpoint`, () => void reset())
                  : void reset()
              }
            />
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
          {endpoint.ignoredReason ? (
            <Text style={[styles.endpointNote, { color: theme.warningText }]}>
              {ignoredUrlStatus(
                endpoint.ignoredReason,
                'The default endpoint is used instead; Edit, then Reset to default, removes it.',
              )}
            </Text>
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
            host, as the &quot;{BLOCKBOOK_API_KEY_HEADER}&quot; request header (the
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
              {localDateLabel(config.verifiedAt)}).{' '}
              {config.apiKey ? 'API key set.' : 'No API key.'}
            </Text>
          ) : config?.ignoredUrlReason ? (
            <Text style={[styles.endpointNote, { color: theme.warningText }]}>
              {ignoredUrlStatus(config.ignoredUrlReason, 'Clear removes it.')}
            </Text>
          ) : network.note ? (
            <Text style={[styles.endpointNote, { color: theme.textMuted }]}>{network.note}</Text>
          ) : null}
          <View style={styles.endpointButtons}>
            <Button title="Edit" variant="secondary" onPress={beginEdit} style={styles.endpointButton} />
            {config?.url || config?.ignoredUrlReason ? (
              <Button
                title="Clear"
                variant="secondary"
                accessibilityLabel={`Clear the ${network.label} Blockbook endpoint`}
                onPress={() => confirmClear(`${network.label} Blockbook endpoint and API key`, () => void clear())}
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
/**
 * One feature of the mainnet readiness table (config/readiness.ts): its
 * status chip, the plain reason, the checklist ids behind it, and whether
 * this build enforces the status.
 */
function ReadinessRow({
  feature,
  phrase,
  theme,
}: {
  feature: FeatureReadiness;
  /** This phone's phrase storage, so the reason never contradicts the protection section. */
  phrase: PhraseProtectionState;
  theme: Theme;
}) {
  // The checklist ids are for reviewers: collapsed behind one line.
  const [showDetails, setShowDetails] = useState(false);
  const chip =
    feature.status === 'mainnet-ok'
      ? { color: theme.success, border: theme.success, background: theme.card }
      : feature.status === 'testnet-only'
        ? { color: theme.onTestnetFill, border: theme.testnetFill, background: theme.testnetFill }
        : { color: theme.warningText, border: theme.warningBorder, background: theme.warningSurface };
  return (
    <View style={[styles.endpointRow, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <View style={styles.endpointHeader}>
        <Text style={[styles.endpointLabel, styles.readinessTitle, { color: theme.text }]}>{feature.title}</Text>
        <View style={[styles.readinessChip, { borderColor: chip.border, backgroundColor: chip.background }]}>
          <Text style={[styles.readinessChipText, { color: chip.color }]}>{READINESS_STATUS_LABEL[feature.status]}</Text>
        </View>
      </View>
      <Text style={[styles.hint, { color: theme.text }]}>{readinessDisplayReason(feature, phrase)}</Text>
      <Text style={[styles.endpointNote, { color: theme.textMuted }]}>
        {feature.status === 'mainnet-ok'
          ? 'Cleared by the checklist.'
          : feature.enforced
            ? 'Switched off on main networks in this build; it works on the test networks.'
            : 'Still works on mainnet in this build; not yet cleared for real funds.'}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: showDetails }}
        accessibilityLabel="Details for reviewers"
        onPress={() => setShowDetails((v) => !v)}
        hitSlop={8}
      >
        <Text style={[styles.endpointNote, { color: theme.accent }]}>
          Details for reviewers {showDetails ? '(hide)' : '(show)'}
        </Text>
      </Pressable>
      {showDetails ? (
        <Text style={[styles.endpointNote, { color: theme.textMuted }]}>{readinessEvidenceLine(feature)}</Text>
      ) : null}
    </View>
  );
}

/**
 * Asks before a stored endpoint, key or address is removed (phase 11 item 6
 * finding F10): Clear is one tap away from Edit, and getting a verified
 * value back means pasting and verifying it again.
 */
function confirmClear(what: string, onConfirm: () => void) {
  Alert.alert(
    `Clear the ${what}?`,
    'It is removed from this phone. To use it again you will need to paste it and verify it again.',
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: onConfirm },
    ],
  );
}

function AaField({
  label,
  placeholder,
  value,
  statusLine,
  ignoredReason = null,
  prefill = null,
  prefillNote = null,
  onSave,
  onClear,
  saveLabel = 'Verify & save',
  locked = false,
}: {
  label: string;
  placeholder: string;
  value: string | null;
  /** Verification status for the stored value (shown when configured). */
  statusLine: string | null;
  /**
   * Set when a URL is stored but fails the https rule on read, so `value`
   * is null: the refusal reason, shown as a warning status line with the
   * Clear button (the only way the stored value is removed).
   */
  ignoredReason?: string | null;
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
  /**
   * True when the mainnet readiness table does not allow this setting on
   * this network: Edit is switched off (Clear still works). The setters
   * refuse too, so this is presentation only.
   */
  locked?: boolean;
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
          {!value && ignoredReason ? (
            <Text style={[styles.aaVerified, { color: theme.warningText }]}>
              {ignoredUrlStatus(ignoredReason, 'Clear removes it.')}
            </Text>
          ) : null}
          <View style={styles.endpointButtons}>
            <Button
              title="Edit"
              variant="secondary"
              disabled={locked}
              onPress={() => {
                // Start from the stored value, else the pinned prefill
                // (the verified Sepolia defaults in test mode).
                setDraft(value ?? prefill ?? '');
                setEditing(true);
              }}
              style={styles.endpointButton}
            />
            {value || ignoredReason ? (
              <Button
                title="Clear"
                variant="secondary"
                accessibilityLabel={`Clear ${label}`}
                onPress={() => confirmClear(label, () => void onClear())}
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

  // The device's local day of the stored UTC timestamp (config/dates.ts).
  const shortDate = (iso: string | null) => localDateLabel(iso);
  const simplePrefill = network.chainId === evmChain.caip2 ? evmChain.aaPrefill : null;
  const type: AaAccountType = selectedType ?? 'kernel-v3.3';
  // The stored factory belongs to the selected type only when the types match.
  const storedForType = config?.factory && config.accountType === type ? config : null;
  const otherTypeStored = config?.factory && config.accountType !== type ? config.accountType : null;
  // Mainnet readiness (config/readiness.ts): smart accounts and paymasters
  // are test-network only. The setters in aa.ts refuse on such a network;
  // here the editors are locked and the reason is shown.
  const typeGate = readinessGate(type === 'simple' ? 'simple-account' : 'kernel-smart-account', network.chainId);
  const kernelGate = readinessGate('kernel-smart-account', network.chainId);
  const simpleGate = readinessGate('simple-account', network.chainId);
  const paymasterGate = readinessGate('paymaster', network.chainId);
  const anyTypeAllowed = kernelGate === null || simpleGate === null;

  return (
    <View style={[styles.endpointRow, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <View style={styles.endpointHeader}>
        <Text style={[styles.endpointLabel, { color: theme.text }]}>{network.label}</Text>
        <Text style={[styles.endpointTag, { color: theme.textMuted }]}>
          {!anyTypeAllowed
            ? 'test networks only'
            : config && config.bundlerUrl && config.factory
              ? `ready · ${aaAccountTypeLabel(config.accountType)}`
              : 'incomplete'}
        </Text>
      </View>
      {typeGate ? (
        <Text style={[styles.endpointNote, { color: theme.warningText }]}>
          {typeGate.feature.reason} {typeGate.hint}
        </Text>
      ) : null}
      <AaField
        label="Bundler URL (ERC-4337 RPC)"
        placeholder="https://…"
        value={config?.bundlerUrl ?? null}
        ignoredReason={config?.bundlerUrlIgnoredReason ?? null}
        locked={!anyTypeAllowed}
        statusLine={
          config?.bundlerUrl
            ? bundlerVerifiedLine(config, network.label, shortDate(config.bundlerVerifiedAt))
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
            selected={t === type}
            onPress={() => setSelectedType(t)}
            style={styles.endpointButton}
          />
        ))}
      </View>
      {type === 'kernel-v3.3' ? (
        <Text style={[styles.endpointNote, { color: theme.textMuted }]}>
          Kernel v3.3 is an ERC-7579 modular account with this account&apos;s key as
          its owner (ECDSA validator). It supports message signing for dApps
          (ERC-1271; ERC-6492 before it is deployed). {kernelDeploymentNote(config?.bundlerUrl ?? null)}
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
          locked={kernelGate !== null}
          prefill={KERNEL_PREFILL.factory}
          prefillNote={
            `Pinned Kernel v3.3 deployment from the wallet engine (the same addresses on ` +
            `${KERNEL_VERIFIED_CHAINS_TEXT}, each checked on-chain): implementation ${KERNEL_PREFILL.implementation}, meta ` +
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
          locked={simpleGate !== null}
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
        ignoredReason={config?.paymasterUrlIgnoredReason ?? null}
        locked={paymasterGate !== null}
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
          locked={paymasterGate !== null}
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
            // On a network where sponsorship is not allowed (mainnet
            // readiness) this save is refused; clear the paymaster URL instead.
            try {
              await setAaPaymaster(network.chainId, config.paymasterUrl!, '');
            } catch (e) {
              Alert.alert('Not saved', e instanceof Error ? e.message : String(e));
            }
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

  // The device's local day of the stored UTC timestamp (config/dates.ts).
  const shortDate = (iso: string | null) => localDateLabel(iso);

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
        ignoredReason={config?.ignoredUrlReason ?? null}
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

  // The device's local day of the stored UTC timestamp (config/dates.ts).
  const shortDate = (iso: string | null) => localDateLabel(iso);

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
        ignoredReason={config?.ignoredUrlReason ?? null}
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
export function SettingsScreen({ navigation, route }: Props) {
  const theme = useTheme();

  // Section anchors (F7): a screen can open Settings at a section
  // (route param `section`). Each anchored section reports its y offset in
  // the scroll content; while a section is pending, every layout pass of
  // that section scrolls to it again, because sections above it (endpoint
  // lists, status lines) finish loading after the first pass and push it
  // down. The user's first drag ends the pending state.
  const scrollRef = useRef<ScrollView>(null);
  const pendingSection = useRef<SettingsSectionId | null>(route.params?.section ?? null);
  const requestedSection = route.params?.section ?? null;
  const sectionOffsets = useRef<Partial<Record<SettingsSectionId, number>>>({});
  const scrollToSection = useCallback((y: number) => {
    scrollRef.current?.scrollTo({ y: Math.max(0, y - 8), animated: true });
  }, []);
  useEffect(() => {
    pendingSection.current = requestedSection;
    // Already laid out (Settings was open and got new params): scroll now.
    const known = requestedSection ? sectionOffsets.current[requestedSection] : undefined;
    if (known !== undefined) scrollToSection(known);
  }, [requestedSection, scrollToSection]);
  const onSectionLayout = useCallback(
    (id: SettingsSectionId, y: number) => {
      sectionOffsets.current[id] = y;
      if (pendingSection.current === id) scrollToSection(y);
    },
    [scrollToSection],
  );
  const { revealMnemonic, wipe, accounts, accountList, watchOnlyAccounts } = useWallet();
  // Imported accounts (feature 12, ADR D9): the phrase does not back them up,
  // so the backup, reveal and wipe texts name them.
  const importedAccounts = accountList.filter((a) => a.imported);
  const importedNames = importedAccounts.map((a) => a.name).join(', ');
  const {
    sepolia,
    testNetwork,
    setTestNetwork,
    evmChain,
    hideAmounts,
    setHideAmounts,
    autoLockMs,
    setAutoLockMs,
    showFiat,
    setShowFiat,
  } = usePrefs();
  // Settings → Privacy (phase 17 item 0): the app-wide screen protection.
  const { screenProtection, setScreenProtection } = usePrefs();
  const screenProtectionStatus = React.useSyncExternalStore(
    appScreenProtection().subscribe,
    appScreenProtection().status,
  );
  // A failed attempt is also retried whenever Settings comes into view.
  useFocusEffect(
    useCallback(() => {
      void appScreenProtection().retryIfFailed();
    }, []),
  );
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
  }, []);

  // testNetwork is a deliberate trigger here even though the effect body does
  // not read it: changing the developer test-network choice (including
  // Sepolia ↔ Base Sepolia, where the on/off `sepolia` flag stays true) must
  // reload the endpoint list at once so the EVM row (and the AA and indexer
  // sections keyed off it) swap to the active network immediately.
  useEffect(() => {
    reloadEndpoints();
  }, [reloadEndpoints, testNetwork]);

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

  // Where the recovery phrase is kept (wallet/storage.ts). Re-read on
  // focus, after "Protect with biometrics" and after a reveal, because a
  // biometric change elsewhere on the phone can change it at any time.
  const [protection, setProtection] = useState<StorageProtection | null>(null);
  const [protecting, setProtecting] = useState(false);
  const reloadProtection = useCallback(() => {
    storageProtection().then(setProtection, () => setProtection(null));
  }, []);
  useFocusEffect(reloadProtection);
  // The readiness reasons name this phone's phrase storage (F6).
  const phraseState: PhraseProtectionState =
    protection?.phrase === 'protected'
      ? 'protected'
      : protection?.phrase === 'standard' || protection?.phrase === 'unreadable'
        ? 'unprotected'
        : 'unknown';

  const onProtect = () => {
    // PROTECT_CONFIRM_MESSAGE, extended when imported keys move too.
    Alert.alert(PROTECT_CONFIRM_TITLE, protectConfirmMessage(protection), [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Protect',
        onPress: async () => {
          setProtecting(true);
          try {
            const result = await upgradePhraseProtection().catch((e: unknown) => ({
              outcome: 'failed' as const,
              detail: e instanceof Error ? e.message : null,
            }));
            const { title, message } = describeUpgradeOutcome(result);
            Alert.alert(title, message);
          } finally {
            setProtecting(false);
            reloadProtection();
          }
        },
      },
    ]);
  };

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
            // The gate opens the PHRASE even while an imported account is
            // active, so the one prompt opens what is actually shown.
            const auth = await requireLocalAuth('Reveal recovery phrase', { kind: 'phrase' });
            if (!auth.ok) {
              Alert.alert('Not revealed', auth.message);
              return;
            }
            const mnemonic = await revealMnemonic();
            if (mnemonic) {
              setRevealed(mnemonic);
              reloadProtection();
            } else {
              // Explain why from a fresh status read (e.g. a biometric
              // change made the protected copy unreadable).
              const status = await storageProtection();
              setProtection(status);
              const { title, message } = describeRevealFailure(status);
              Alert.alert(title, message);
            }
          },
        },
      ],
    );
  };

  const protectionView = protection ? describeProtectionStatus(protection) : null;

  const onWipe = () => {
    // Recovery records (phase 8 item 4) are the only way a restored wallet
    // finds an account whose owner changed, and they live only on this
    // device: offer the export first. Wiping removes nothing on-chain.
    loadRecoveryRecords().then(
      ({ entries }) => {
        const text = exportAllRecordsText(entries);
        if (!text) {
          confirmWipe();
          return;
        }
        Alert.alert(
          'Export your recovery records first?',
          `This device holds ${entries.length} recovery record(s). They contain no secrets, but a wallet ` +
            'restored from a recovery phrase needs them to find accounts whose owner changed. Wiping deletes ' +
            'them from this device (nothing on-chain changes: guardians stay installed).',
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Export',
              onPress: () => {
                Share.share({ message: text, title: 'Recovery records' }).then(
                  () => confirmWipe(),
                  () => confirmWipe(),
                );
              },
            },
            { text: 'Continue without exporting', style: 'destructive', onPress: confirmWipe },
          ],
        );
      },
      () => confirmWipe(),
    );
  };

  const confirmWipe = () => {
    // Double confirmation: wiping is irreversible without the paper backup.
    Alert.alert(
      'Wipe wallet?',
      (importedAccounts.length > 0
        ? `This also deletes the private keys of your imported accounts (${importedNames}). Your recovery ` +
          'phrase cannot bring them back: they are lost unless you kept each private key yourself. '
        : '') +
      'This deletes the recovery phrase from this device. The app returns to onboarding. Session ' +
        'keys and the session list are deleted too, but sessions granted on-chain stay active until ' +
        'they expire — revoke them first (Settings → Session keys) if you still can. Recovery records ' +
        'and recovered-account links are deleted from this device; guardians stay installed on-chain. ' +
        'Passkey details are deleted from this device too, but an installed passkey stays installed in ' +
        'your smart account — remove it first (Settings → Passkey) if you no longer want it.',
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
    <ScrollView
      ref={scrollRef}
      style={screenStyle(theme)}
      contentContainerStyle={styles.content}
      onScrollBeginDrag={() => {
        pendingSection.current = null;
      }}
    >
      <AccountsSection onImportKey={() => navigation.navigate('ImportKey')} />

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Backup</Text>
        {importedAccounts.length === 0 ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            {watchOnlyAccounts.length === 0
              ? 'One recovery phrase backs up ALL of your accounts — every account in the list above, including hidden ones, on every chain.'
              : 'One recovery phrase backs up every account in the list above that this wallet holds a key for, including hidden ones, on every chain.'}
          </Text>
        ) : (
          <>
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              One recovery phrase backs up every account in the list above
              that comes from it, including hidden ones, on every chain.
            </Text>
            <WarningBox>
              {`It does NOT back up your imported accounts (${importedNames}). Each one is lost with this ` +
                'phone unless you keep its private key yourself: use Show private key in the list above to ' +
                'make a copy.'}
            </WarningBox>
          </>
        )}
        {watchOnlyAccounts.length > 0 ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Watch-only addresses have no key in this wallet, so the recovery phrase does not back them up and
            is not needed for them: to watch one again on another phone, add its address again.
          </Text>
        ) : null}
        {revealed ? (
          <View style={styles.revealBlock}>
            <WarningBox>
              {importedAccounts.length === 0
                ? 'Never share these words. They control every account in this wallet, not just the ' +
                  'active one. Shiba Wallet support will never ask for them. Hide them again as soon as ' +
                  'you are done.'
                : 'Never share these words. They control every account in this wallet that comes from ' +
                  'them, not just the active one. Shiba Wallet support will never ask for them. Hide ' +
                  `them again as soon as you are done. They do not restore your imported accounts ` +
                  `(${importedNames}).`}
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

      {protectionView?.text ? (
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>Recovery phrase protection</Text>
          {protectionView.warning ? (
            <WarningBox>{protectionView.text}</WarningBox>
          ) : (
            <Text style={[styles.hint, { color: theme.textMuted }]}>{protectionView.text}</Text>
          )}
          {protectionView.note ? (
            <Text style={[styles.hint, { color: theme.textMuted }]}>{protectionView.note}</Text>
          ) : null}
          {protectionView.importedNote ? (
            <Text style={[styles.hint, { color: theme.textMuted }]}>{protectionView.importedNote}</Text>
          ) : null}
          {protectionView.showProtectButton ? (
            <Button
              title={protecting ? 'Protecting…' : PROTECT_BUTTON_TITLE}
              variant="secondary"
              disabled={protecting}
              onPress={onProtect}
            />
          ) : null}
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Privacy & security</Text>
        <View style={styles.toggleRow}>
          <Text style={[styles.toggleLabel, { color: theme.text }]}>Hide amounts</Text>
          <Switch
            accessibilityLabel="Hide amounts"
            accessibilityRole="switch"
            accessibilityState={{ checked: hideAmounts }}
            value={hideAmounts}
            onValueChange={(v) => void setHideAmounts(v)}
          />
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
                  selected={autoLockMs === choice.ms}
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
            in-app PIN would be weaker than your device&apos;s own lock screen,
            which already protects the secure storage holding your recovery
            phrase. Set up a device passcode and biometrics to enable
            auto-lock.
          </Text>
        ) : null}
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>{SCREEN_PROTECTION_TITLE}</Text>
        <View style={styles.toggleRow}>
          <Text style={[styles.toggleLabel, { color: theme.text, flexShrink: 1, marginRight: 12 }]}>
            {SCREEN_PROTECTION_SWITCH_LABEL}
          </Text>
          <Switch
            accessibilityLabel={SCREEN_PROTECTION_SWITCH_LABEL}
            accessibilityRole="switch"
            accessibilityState={{ checked: screenProtection }}
            value={screenProtection}
            onValueChange={(v) => void setScreenProtection(v)}
          />
        </View>
        <Text style={[styles.hint, { color: theme.textMuted }]}>{SCREEN_PROTECTION_PLATFORM_NOTE}</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>{SCREEN_PROTECTION_ALWAYS_NOTE}</Text>
        <Text
          style={[
            styles.hint,
            { color: screenProtectionStatus.state === 'failed' ? theme.danger : theme.textMuted },
          ]}
        >
          {describeScreenProtectionStatus(screenProtectionStatus)}
        </Text>
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Prices</Text>
        <View style={styles.toggleRow}>
          <Text style={[styles.toggleLabel, { color: theme.text }]}>Show fiat values (USD)</Text>
          <Switch
            accessibilityLabel="Show fiat values (USD)"
            accessibilityRole="switch"
            accessibilityState={{ checked: showFiat }}
            value={showFiat}
            onValueChange={(v) => void setShowFiat(v)}
          />
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
                      localDateLabel(priceConfig.verifiedAt)
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

      <View style={styles.section} onLayout={(e) => onSectionLayout('network-endpoints', e.nativeEvent.layout.y)}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Network endpoints</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Where balances are fetched from and where transactions are
          broadcast. Endpoint URLs are public configuration; Dogecoin&apos;s
          Blockbook endpoint may additionally need a provider API key,
          which is stored only on this device and sent only to that host.
          Balances refresh with the new endpoint on the next
          pull-to-refresh. Without a custom endpoint, each chain uses the
          first of its built-in public defaults that answers; if that one
          stops answering, the next is tried automatically.{' '}
          {INSECURE_ENDPOINT_MESSAGE}
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

      <View style={styles.section} onLayout={(e) => onSectionLayout('history-indexer', e.nativeEvent.layout.y)}>
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
          URLs for the wrong chain. {INSECURE_ENDPOINT_MESSAGE}
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

      <View style={styles.section} onLayout={(e) => onSectionLayout('nft-indexer', e.nativeEvent.layout.y)}>
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
          see your IP address. {INSECURE_ENDPOINT_MESSAGE}
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
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Mainnet readiness</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>{READINESS_INTRO}</Text>
        {FEATURE_READINESS.map((f) => (
          <ReadinessRow key={f.id} feature={f} phrase={phraseState} theme={theme} />
        ))}
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          The ids under “Details for reviewers” (C1–C3, W1–W20 and the finding numbers) refer to the
          project&apos;s threat model: its mainnet-readiness checklist and its list of findings.{' '}
          {READINESS_TESTNET_HINT}
        </Text>
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>
          Account Abstraction (experimental)
        </Text>
        <Text style={[styles.hint, { color: theme.warningText }]}>
          Smart accounts, their modules and gas sponsorship are limited to test networks (see
          Mainnet readiness above): on a main network these settings cannot be saved and the
          smart-account options do not appear on the Send, Swap and WalletConnect screens.
          Clearing a setting saved earlier still works.
        </Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Optional ERC-4337 setup per EVM chain: a bundler endpoint, a
          smart-account type (Kernel v3.3 or SimpleAccount) and its factory.
          Everything is verified before saving — the bundler must answer
          eth_chainId with this network&apos;s chain id and support EntryPoint
          v0.7, and the factory is checked on-chain through your configured
          RPC endpoint. When set, the Send and Swap screens offer
          an experimental &quot;from smart account&quot; toggle (token sends and swaps
          run as one atomic batch), and WalletConnect can connect dApps to
          the smart account. Off by default; nothing changes for regular
          sends. {INSECURE_ENDPOINT_MESSAGE}
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
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Session keys</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Let a separate key on this device (or a dApp, over WalletConnect) make only the calls you
          list, until a deadline you choose. Your Kernel account enforces the limits on-chain, and you
          can revoke a session at any time. Needs a deployed Kernel v3.3 smart account or an upgraded
          account. Sessions and their keys are not part of the recovery phrase: they do not survive a
          wipe or a restore, so revoke them before wiping.
        </Text>
        <Button
          title="Sessions"
          variant="secondary"
          onPress={() => navigation.navigate('Sessions')}
        />
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Guardians (social recovery)</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Let people you choose replace the key of your deployed Kernel smart account if you lose your
          recovery phrase. This is a trade-off, not a safety guarantee: enough guardians together could
          also take the account, and guardians can sign messages as the account from the moment they are
          installed (with no delay and no veto). Not available for an account upgraded with EIP-7702. The
          guardian modules have no published audit of their deployed versions.
        </Text>
        <Button
          title="Guardians for this account"
          variant="secondary"
          onPress={() => navigation.navigate('Guardians')}
        />
        <Button
          title="Inheritance (demonstration)"
          variant="secondary"
          onPress={() => navigation.navigate('Inheritance')}
        />
        <Button
          title="Recover an account with guardians"
          variant="secondary"
          onPress={() => navigation.navigate('RecoverAccount')}
        />
        <Button
          title="Approve a recovery (as a guardian)"
          variant="secondary"
          onPress={() => navigation.navigate('ApproveRecovery')}
        />
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Passkey (device biometrics signer)</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>{PASSKEY_EXPLANATION}</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>{PASSKEY_SELF_CALL_RISK}</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Needs a deployed Kernel v3.3 smart account (not an EIP-7702 upgrade). {PASSKEY_AUDIT_NOTE}
        </Text>
        {(() => {
          const gate = passkeyGateNow();
          return gate.ok ? null : <WarningBox>{gate.reason}</WarningBox>;
        })()}
        <Button title="Passkey for this account" variant="secondary" onPress={() => navigation.navigate('Passkey')} />
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>WalletConnect</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          {`Lets external dApps connect to this wallet on the active EVM chain (${EVM_MAINNET.label} mainnet, or ${testNetworkLabelsOr()} while test mode is on). `}
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
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Apps (in-app browser)</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          A short, fixed list of apps that open inside the wallet, on test networks only. They connect through the same
          approval sheet as WalletConnect. Their connections are listed on the Connected apps screen (the &quot;Open
          connections&quot; button in the WalletConnect section above, or &quot;Manage connections&quot; in Apps), and a
          site that is open can be disconnected from the Connection button on its browser bar.
        </Text>
        <Button title="Open Apps" variant="secondary" onPress={() => navigation.navigate('Apps')} />
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
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Prove address ownership</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Sign a challenge you were given (or your own statement) with this account or its smart
          account, and share a proof anyone can check. Website logins are not signed here — they go
          through WalletConnect.
        </Text>
        <Button
          title="Prove ownership"
          variant="secondary"
          onPress={() => navigation.navigate('ProveOwnership')}
        />
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Tokens</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Track ERC-20 tokens on the Home screen: balances, and sending
          them. {settingsTokensFeeSentence()} Each network has its own list
          ({evmChain.label} now), and Find my tokens lists what your address
          holds when a history indexer is configured.
        </Text>
        <Button
          title="Manage tokens"
          variant="secondary"
          onPress={() => navigation.navigate('Tokens')}
        />
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>{SPENDING_SECTION_TITLE}</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>{SPENDING_SETTINGS_HINT}</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>{SPENDING_HONESTY_SENTENCE}</Text>
        <Button
          title="Spending limits"
          variant="secondary"
          onPress={() => navigation.navigate('SpendingLimits')}
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
                  localDateLabel(swapConfig.verifiedAt)
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
        <Text style={[styles.toggleLabel, { color: theme.text }]}>Test network</Text>
        <View style={styles.choiceChips}>
          {[
            { label: 'Off (mainnet)', value: null },
            ...EVM_TEST_PROFILES.map((p) => ({ label: p.label, value: p.caip2 as TestNetworkId })),
          ].map((choice) => (
            <Button
              key={choice.label}
              title={testNetwork === choice.value ? `✓ ${choice.label}` : choice.label}
              variant={testNetwork === choice.value ? 'primary' : 'secondary'}
              selected={testNetwork === choice.value}
              accessibilityHint="Chooses which network the app's Ethereum account uses"
              onPress={() => void setTestNetwork(choice.value)}
              style={styles.choiceChip}
            />
          ))}
        </View>
        <Text style={[styles.hint, { color: theme.textMuted }]}>{DEVELOPER_TEST_NETWORK_HINT}</Text>
        {sepolia ? (
          <Text style={[styles.hint, { color: theme.testnetFill }]}>
            Test mode is ON ({evmChain.label}). Your addresses are the same on
            {' '}{evmChain.label} as on mainnet — but anything sent here is test
            ETH with no value.
          </Text>
        ) : null}
        {evmChain.l1DataFee ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            {evmChain.label} is a layer-2 network: every transaction also pays a
            layer 1 data fee for publishing its data on Ethereum. Send confirm
            screens show it as a separate line — the network&apos;s fee-oracle
            estimate plus 50% headroom, because this fee cannot be capped — and
            include it in the max network fee, the total and Max. Smart-account
            sends pay it through the bundler&apos;s gas estimate instead.
            {evmChain.swapsOffered ? '' : ` Swaps are not offered here (0x does not support ${evmChain.label}).`}
          </Text>
        ) : null}
        {evmChain.l1CostInGas ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>{l1CostInGasNote(evmChain)}</Text>
        ) : null}
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Danger zone</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Wiping removes the recovery phrase from this device&apos;s secure
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
  // Choice chips whose labels are several words ("Ethereum Sepolia"): they
  // flow onto more rows instead of squeezing four into one row, where each
  // was too narrow for a single word and the text broke mid-word. With the
  // minimum width, two chips share a row when the row is at least 290
  // points wide, otherwise each takes a row of its own; the width left for
  // the label (140 minus the button's padding and border, about 97 points)
  // is meant to hold the longest single word of these labels at the
  // button's 16-point font, so a label breaks only between words. That was
  // reasoned from the styles, not measured on a device.
  choiceChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  choiceChip: {
    flexGrow: 1,
    flexBasis: '40%',
    minWidth: 140,
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
  readinessTitle: {
    flexShrink: 1,
  },
  readinessChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 3,
    paddingHorizontal: 10,
    marginLeft: 8,
  },
  readinessChipText: {
    fontSize: 12,
    fontWeight: '700',
  },
});
