import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { Button, WarningBox, screenStyle } from '../components';
import { useTheme, type Theme } from '../theme';
import { useWallet } from '../wallet/WalletContext';
import { usePrefs } from '../wallet/PrefsContext';
import { requireLocalAuth } from '../wallet/biometric';
import { EVM_CHAIN_ID } from '../wallet/send';
import { getEndpoint } from '../config/networks';
import {
  aaAccountTypeLabel,
  aaAccountTypeSignsMessages,
  createAaClientFromConfig,
  getAaConfig,
  isAaConfigured,
  resolveAaSender,
  type AaAccountType,
  type AaClientBundle,
} from '../wallet/aa';
import {
  formatProofText,
  makeEoaProof,
  makeSmartAccountProof,
  proofVerifyNote,
  screenProofChallenge,
  suggestedChallenge,
  type OwnershipProof,
} from '../wallet/proof';

type Props = NativeStackScreenProps<RootStackParamList, 'ProveOwnership'>;

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

interface SmartOption {
  address: string;
  accountType: AaAccountType;
}

/**
 * Proof of address ownership (phase 11 item 3, feature 85). The user types
 * or pastes a challenge they hold (a verifier's code, a statement), signs it
 * with the active account after the biometric gate, and shares the proof:
 * message, address, signature and how to verify it.
 *  - Own address: EIP-191 personal_sign.
 *  - Kernel smart account (when a verified one exists on the active chain):
 *    the ERC-1271 envelope, ERC-6492-wrapped while undeployed — the same
 *    signHashAsSmartAccount path WalletConnect smart-account sessions use.
 * The challenge screen (wallet/proof.ts screenProofChallenge) refuses
 * EIP-712 requests, transactions, EIP-7702 authorizations, hex data and
 * website sign-ins for a site the user did not type: dApp logins belong on
 * WalletConnect, where the wallet can check which site is asking.
 */
export function ProveOwnershipScreen({ navigation }: Props) {
  const theme = useTheme();
  const { accounts, activeAccount, signWith } = useWallet();
  const { evmChain } = usePrefs();
  const eoa = accounts.find((a) => a.chainId === EVM_CHAIN_ID)?.address ?? null;
  const accountIndex = activeAccount?.index ?? null;
  const [smart, setSmart] = useState<SmartOption | null | undefined>(undefined);
  const [signAs, setSignAs] = useState<'eoa' | 'smart'>('eoa');
  const [challenge, setChallenge] = useState('');
  const [site, setSite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proof, setProof] = useState<OwnershipProof | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    navigation.setOptions({ title: 'Prove ownership' });
  }, [navigation]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  // The active account's Kernel smart account on the active chain, when a
  // verified configuration exists (the same lookup WalletConnect uses).
  useEffect(() => {
    let cancelled = false;
    (async (): Promise<SmartOption | null> => {
      if (!eoa || accountIndex === null) return null;
      const bundle = await loadBundle(evmChain.caip2, evmChain.chainIdDecimal, accountIndex);
      if (!bundle || !aaAccountTypeSignsMessages(bundle.accountType)) return null;
      return { address: await resolveAaSender(bundle, eoa), accountType: bundle.accountType };
    })().then(
      (option) => {
        if (!cancelled) setSmart(option);
      },
      () => {
        if (!cancelled) setSmart(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [eoa, accountIndex, evmChain.caip2, evmChain.chainIdDecimal]);

  if (!eoa || accountIndex === null) {
    return (
      <View style={[screenStyle(theme), styles.center]}>
        <Text style={{ color: theme.textMuted }}>No Ethereum account is available.</Text>
      </View>
    );
  }

  // A smart-account choice never silently falls back: without a smart
  // account the screen shows (and signs as) this account only.
  const mode: 'eoa' | 'smart' = smart ? signAs : 'eoa';
  const useSmart = mode === 'smart' && smart != null;
  const proving = useSmart ? smart.address : eoa;
  const network = { caip2: evmChain.caip2, chainId: evmChain.chainIdDecimal, name: evmChain.label };
  const inputStyle = [styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.card }];

  const onSign = async () => {
    setError(null);
    const screened = screenProofChallenge(challenge, { signer: proving, typedSite: site });
    if (!screened.ok) {
      setError(screened.reason);
      return;
    }
    const auth = await requireLocalAuth('Sign an ownership proof');
    if (!auth.ok) {
      setError(auth.message);
      return;
    }
    setBusy(true);
    try {
      let made: OwnershipProof;
      if (useSmart) {
        const bundle = await loadBundle(evmChain.caip2, evmChain.chainIdDecimal, accountIndex);
        if (!bundle || !aaAccountTypeSignsMessages(bundle.accountType)) {
          throw new Error('The smart-account settings changed; nothing was signed. Reopen this screen.');
        }
        // The OWNER key signs; signHashAsSmartAccount refuses unless the
        // owner's smart account is exactly the address shown.
        made = await signWith(EVM_CHAIN_ID, eoa, (owner) =>
          makeSmartAccountProof(bundle, owner, screened, smart.address, network),
        );
      } else {
        made = await signWith(EVM_CHAIN_ID, eoa, async (owner) => makeEoaProof(owner, screened, network));
      }
      setProof(made);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (proof) {
    const text = formatProofText(proof);
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: theme.text }]}>Your proof</Text>
        <Row label="Address" value={proof.address} mono theme={theme} />
        <Row label="Network" value={`${proof.network.name} (chain ID ${proof.network.chainId})`} theme={theme} />
        <Row
          label="Signed as"
          value={
            proof.kind === 'eoa'
              ? `${activeAccount?.name ?? 'Your account'} (EIP-191 message signature)`
              : `Smart account — ${aaAccountTypeLabel((proof.accountType ?? 'kernel-v3.3') as AaAccountType)}` +
                (proof.erc6492 ? ', not deployed yet (ERC-6492-wrapped)' : ' (ERC-1271)')
          }
          theme={theme}
        />
        <Row label="Message" value={proof.message} mono theme={theme} />
        <Row label="Signature" value={proof.signature} mono theme={theme} />
        <Text style={[styles.note, { color: theme.text }]}>{proofVerifyNote(proof)}</Text>
        <Button
          title={copied ? 'Copied ✓' : 'Copy proof'}
          onPress={async () => {
            await Clipboard.setStringAsync(text);
            setCopied(true);
          }}
        />
        <Button
          title="Share proof"
          variant="secondary"
          onPress={() => {
            Share.share({ message: text }).catch(() => undefined);
          }}
        />
        <Text style={[styles.note, { color: theme.textMuted }]}>
          The proof contains no secret: only the message, your address and the signature. Copied
          text can be read by other apps.
        </Text>
        <Button
          title="Sign another"
          variant="secondary"
          onPress={() => {
            setProof(null);
            setChallenge('');
            setSite('');
          }}
        />
      </ScrollView>
    );
  }

  return (
    <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={[styles.title, { color: theme.text }]}>Prove you own an address</Text>
      <Text style={[styles.note, { color: theme.text }]}>
        Sign a challenge that someone gave you — a code from a support desk, an exchange or a
        verifier — or write your own statement. Anyone can then check the signature against your
        address. Signing costs nothing and moves no funds.
      </Text>
      <WarningBox>
        Only sign challenges you hold yourself. Never paste something a stranger sends you. Logins to
        websites go through WalletConnect, where the wallet checks which site is asking; this screen
        refuses them unless you type the site yourself.
      </WarningBox>

      <Text style={[styles.label, { color: theme.textMuted }]}>Prove ownership of</Text>
      <View style={styles.choiceRow}>
        <Button
          title={mode === 'eoa' ? '✓ This account' : 'This account'}
          variant={mode === 'eoa' ? 'primary' : 'secondary'}
          selected={mode === 'eoa'}
          onPress={() => setSignAs('eoa')}
          style={styles.flex}
        />
        {smart ? (
          <Button
            title={mode === 'smart' ? '✓ Smart account' : 'Smart account'}
            variant={mode === 'smart' ? 'primary' : 'secondary'}
            selected={mode === 'smart'}
            onPress={() => setSignAs('smart')}
            style={styles.flex}
          />
        ) : null}
      </View>
      <Row label={`On ${evmChain.label}`} value={proving} mono theme={theme} />
      {smart === undefined ? (
        <Text style={[styles.note, { color: theme.textMuted }]}>Checking for a smart account…</Text>
      ) : useSmart ? (
        <Text style={[styles.note, { color: theme.textMuted }]}>
          Signed by your smart account ({aaAccountTypeLabel(smart.accountType)}) with ERC-1271, and
          ERC-6492-wrapped if it is not deployed yet. Your account key signs on its behalf. The proof
          is checked on {evmChain.label}.
        </Text>
      ) : null}

      <Text style={[styles.label, { color: theme.textMuted }]}>Challenge</Text>
      <TextInput
        value={challenge}
        onChangeText={(t) => {
          setChallenge(t);
          setError(null);
        }}
        accessibilityLabel="Challenge to sign"
        placeholder="Paste or type the challenge"
        placeholderTextColor={theme.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        style={[...inputStyle, styles.multiline, { fontFamily: mono }]}
      />
      <View style={styles.choiceRow}>
        <Button
          title="Paste"
          variant="secondary"
          onPress={async () => {
            const pasted = await Clipboard.getStringAsync().catch(() => '');
            setChallenge(pasted);
            setError(null);
          }}
          style={styles.flex}
        />
        <Button
          title="Write one for me"
          variant="secondary"
          onPress={() => {
            setChallenge(suggestedChallenge(proving));
            setError(null);
          }}
          style={styles.flex}
        />
      </View>

      <Text style={[styles.label, { color: theme.textMuted }]}>Site (only for a website sign-in message)</Text>
      <TextInput
        value={site}
        onChangeText={(t) => {
          setSite(t);
          setError(null);
        }}
        accessibilityLabel="Site domain"
        placeholder="example.com"
        placeholderTextColor={theme.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        style={inputStyle}
      />

      {error ? <WarningBox>{error}</WarningBox> : null}
      {busy ? (
        <ActivityIndicator color={theme.accent} />
      ) : (
        <Button title="Sign proof" onPress={() => void onSign()} />
      )}
      <Text style={[styles.note, { color: theme.textMuted }]}>
        What is signed is exactly the text above (EIP-191 personal message). You confirm with your
        fingerprint, face or device passcode first.
      </Text>
    </ScrollView>
  );
}

/** The active chain's verified smart-account bundle, as WalletConnect loads it (no 7702 owner path). */
async function loadBundle(caip2: string, chainIdDecimal: string, accountIndex: number): Promise<AaClientBundle | null> {
  const config = await getAaConfig(caip2);
  if (!isAaConfigured(config)) return null;
  const endpoint = await getEndpoint(EVM_CHAIN_ID);
  if (!endpoint?.url) return null;
  return createAaClientFromConfig(config, { nodeUrl: endpoint.url, chainId: BigInt(chainIdDecimal), accountIndex });
}

function Row({
  label,
  value,
  mono: monoValue,
  theme,
}: {
  label: string;
  value: string;
  mono?: boolean;
  theme: Theme;
}) {
  return (
    <View style={[styles.row, { borderColor: theme.border }]}>
      <Text style={[styles.label, { color: theme.textMuted }]}>{label}</Text>
      <Text selectable style={[styles.value, { color: theme.text }, monoValue ? { fontFamily: mono, fontSize: 13 } : null]}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 24,
    gap: 14,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
  },
  note: {
    fontSize: 13,
    lineHeight: 19,
  },
  label: {
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  value: {
    fontSize: 15,
    fontWeight: '600',
  },
  row: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingBottom: 8,
    gap: 3,
  },
  choiceRow: {
    flexDirection: 'row',
    gap: 10,
  },
  flex: {
    flex: 1,
  },
  input: {
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  multiline: {
    minHeight: 110,
    textAlignVertical: 'top',
  },
});
