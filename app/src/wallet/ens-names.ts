// Explicit .ts extensions on relative imports: this module is loaded
// directly by scripts/check-names.mjs under Node's type stripping.
import {
  EnsResolutionError,
  normalizeEnsNameAscii,
  resolveEnsAddress,
  reverifyEnsResolution,
  type EnsForwardResolution,
  type EnsNameProblem,
  type JsonRpcTransport,
} from '@shiba-wallet/chains-evm';
import type { EvmChainProfile } from '../config/evm-chain.ts';
import { endpointHost } from '../config/endpoint-probe.ts';

/**
 * ENS names in the Send recipient field (phase 14 item 2, feature 74): the
 * plain-language layer over the engine's Universal Resolver lookup
 * (packages/chains-evm/src/ens.ts, which cites the ENS documentation).
 *
 * Rules this module states and the Send screen enforces:
 *
 *  - Only names in the engine's conservative ASCII subset (letters, digits,
 *    hyphens, dots) are looked up; everything else is refused with a plain
 *    sentence. No Unicode normalisation is attempted, because a partial
 *    one could resolve a look-alike name to an attacker's address.
 *  - Which registry answers is decided by the ACTIVE network: Ethereum
 *    mainnet uses mainnet ENS; Ethereum Sepolia uses ENS on Sepolia, which
 *    is a separate test-network registry; every other network (Base
 *    Sepolia) refuses, because ENS lives on Ethereum and a name's address
 *    for another chain is a separate record (ENSIP-11) this wallet does not
 *    read.
 *  - Offchain names (CCIP-Read, EIP-3668) are refused: following them would
 *    send the name and the device's IP address to a server chosen by the
 *    name's resolver.
 *  - The name is never stored as the recipient: the resolved address is
 *    what gets validated, matched against contacts and own accounts, risk
 *    checked, quoted and signed. The name is resolved again just before the
 *    quote, and a changed address stops the review.
 *
 * Free of React Native imports so the check script can run the exact code
 * the app runs, with a fake JSON-RPC transport.
 */

/** Where a name lookup goes on the active network, or why there is none. */
export type EnsRegistry =
  | { ok: true; chainId: bigint; label: string }
  | { ok: false; reason: string };

/**
 * The ENS registry the active EVM profile uses. Only the chain id decides:
 * 1 is mainnet ENS, 11155111 is ENS on Sepolia; anything else is refused.
 */
export function ensRegistryFor(profile: Pick<EvmChainProfile, 'chainIdDecimal' | 'label'>): EnsRegistry {
  if (profile.chainIdDecimal === '1') {
    return { ok: true, chainId: 1n, label: 'ENS on Ethereum mainnet' };
  }
  if (profile.chainIdDecimal === '11155111') {
    return {
      ok: true,
      chainId: 11155111n,
      label: 'ENS on Ethereum Sepolia (test-network names, separate from mainnet names)',
    };
  }
  return {
    ok: false,
    reason:
      `ENS names are not looked up on ${profile.label}. ENS lives on Ethereum, and a ` +
      'name’s address for another network is a separate record that this wallet does ' +
      'not read yet. Paste the address instead.',
  };
}

/**
 * True when the recipient text should be treated as a name rather than an
 * address: it contains a dot, does not start with "0x", and contains no
 * colon. Hexadecimal input always stays on the address path (EIP-681's rule
 * that hexadecimal addresses take precedence over names applies to typed
 * input too), so resolution never gets in the way of typing an address.
 * Text with a colon is a URI (a payment request such as
 * "bitcoin:bc1q…?amount=0.01", or any other scheme) and is never a name:
 * ENS names cannot contain a colon in the subset this wallet looks up, and
 * sending a URI down the name path would show name errors for something
 * that is not a name (phase 14 emulator finding 1).
 */
export function looksLikeName(text: string): boolean {
  const t = text.trim();
  return t.includes('.') && !/^0x/i.test(t) && !t.includes(':');
}

/**
 * The refusal for a name that is decided WITHOUT any network request: a
 * name outside the supported ASCII subset, or a network where names are not
 * looked up. Null when the name may be looked up. The Send screen shows
 * this sentence at once (no "Looking up…" and no privacy line, because
 * nothing is sent anywhere); lookUpRecipientName applies the same two rules
 * in the same order.
 */
export function localNameRefusal(
  input: string,
  profile: Pick<EvmChainProfile, 'chainIdDecimal' | 'label'>,
): string | null {
  const check = normalizeEnsNameAscii(input);
  if (!check.ok) return nameProblemSentence(check.problem);
  const registry = ensRegistryFor(profile);
  return registry.ok ? null : registry.reason;
}

/**
 * The Send form's error line, or null when it would only repeat the name
 * panel's refusal shown just above it (the sentence must never render
 * twice). Any other error is returned unchanged.
 */
export function formErrorBesideName(
  formError: string | null,
  nameRefusal: string | null,
): string | null {
  if (formError === null) return null;
  return nameRefusal !== null && formError === nameRefusal ? null : formError;
}

/** The form error when Review is tapped while the recipient name cannot be used. */
export const NAME_NOT_USABLE_SENTENCE =
  'The recipient name above cannot be used; the reason is shown under the recipient field.';

/** The plain sentence for each name the engine's ASCII subset refuses. */
export function nameProblemSentence(problem: EnsNameProblem): string {
  switch (problem) {
    case 'empty':
      return 'Enter a recipient address.';
    case 'not-ascii-subset':
      return (
        'Only names made of the letters a–z, digits 0–9, hyphens and dots are ' +
        'supported yet (no accents, other scripts, emoji, "_" or "$"). Paste the address instead.'
      );
    case 'empty-label':
      return 'This name has an empty part (two dots together, or a dot at the start or end).';
    case 'single-label':
      return 'A name needs at least one dot, for example name.eth.';
    case 'label-extension':
      return (
        'ENS does not allow a hyphen as both the third and fourth character of a part of ' +
        'a name (as in "xn--"), so this is not a valid name.'
      );
    case 'too-long':
      return 'This name is too long.';
  }
}

/** The privacy sentence shown with every name lookup. */
export function ensPrivacyNote(endpointUrl: string | null): string {
  const where = endpointUrl ? `your network endpoint (${endpointHost(endpointUrl)})` : 'your network endpoint';
  return `Names are looked up through ${where}, which sees the name you looked up.`;
}

/** The sentence for an ENS-level failure (transport failures keep their own wording). */
export function describeNameError(error: unknown, name: string, registryLabel: string): string {
  if (!(error instanceof EnsResolutionError)) {
    return `The name ${name} could not be looked up right now. Check your connection and try again, or paste the address.`;
  }
  switch (error.reason) {
    case 'offchain':
      return (
        `${name} is stored off-chain: looking it up needs a request to a server chosen by ` +
        'the name’s resolver (CCIP-Read). This wallet does not make those requests, so ' +
        'the name cannot be used here. Paste the address instead.'
      );
    case 'no-resolver':
      return `${name} is not registered with ${registryLabel} (it has no resolver). Check the spelling, or paste the address.`;
    case 'no-address':
      return `${name} exists in ${registryLabel} but has no Ethereum address set. Paste the address instead.`;
    case 'resolver-error':
      return `${registryLabel} could not resolve ${name}: its resolver returned an error. Paste the address instead.`;
    case 'wrong-chain':
      return 'The network endpoint answered for a different network, so the name was not looked up. Check Settings → Network endpoints.';
    case 'unsupported-chain':
      return `ENS names are not looked up on this network. Paste the address instead.`;
    case 'invalid-name':
      return 'This is not a name this wallet can look up. Paste the address instead.';
    case 'malformed':
      return `The answer for ${name} was not in the expected form, so it was not used. Paste the address instead.`;
  }
}

/** Shown when the name points elsewhere at Review time than when it was displayed. */
export function nameChangedSentence(name: string): string {
  return `The name ${name} now points to a different address than the one shown. Check the new address below, then tap Review again.`;
}

/** The resolved-name line on the form and the confirm screen. */
export function resolvedNameLine(
  resolution: Pick<EnsForwardResolution, 'name' | 'address'>,
  registryLabel: string,
): string {
  return `${resolution.name} → ${resolution.address} (resolved by ${registryLabel}). The address, not the name, is what will be used.`;
}

/** The outcome of looking up what the user typed. */
export type NameLookup =
  | { kind: 'resolved'; resolution: EnsForwardResolution; registryLabel: string }
  | { kind: 'refused'; message: string };

/**
 * Normalizes and resolves `input` on the active profile through
 * `transport` (an endpoint of that profile; the caller applies the endpoint
 * failover rule around this call). Every ENS-level failure becomes a
 * 'refused' outcome with a plain sentence; transport failures are rethrown
 * so failover can see them.
 */
export async function lookUpRecipientName(
  transport: JsonRpcTransport,
  input: string,
  profile: Pick<EvmChainProfile, 'chainIdDecimal' | 'label'>,
): Promise<NameLookup> {
  const check = normalizeEnsNameAscii(input);
  if (!check.ok) return { kind: 'refused', message: nameProblemSentence(check.problem) };
  const registry = ensRegistryFor(profile);
  if (!registry.ok) return { kind: 'refused', message: registry.reason };
  try {
    const resolution = await resolveEnsAddress(transport, check.name, registry.chainId);
    return { kind: 'resolved', resolution, registryLabel: registry.label };
  } catch (e) {
    if (e instanceof EnsResolutionError) {
      return { kind: 'refused', message: describeNameError(e, check.name, registry.label) };
    }
    throw e;
  }
}

/**
 * The Review-time check: resolve the shown name again. Returns the current
 * resolution when it still points to the same address; otherwise a refusal
 * (a changed address carries the new resolution so the form can show it).
 */
export type NameRecheck =
  | { kind: 'same'; resolution: EnsForwardResolution }
  | { kind: 'changed'; resolution: EnsForwardResolution; message: string }
  | { kind: 'refused'; message: string };

export async function recheckRecipientName(
  transport: JsonRpcTransport,
  shown: Pick<EnsForwardResolution, 'name' | 'address' | 'chainId'>,
  registryLabel: string,
): Promise<NameRecheck> {
  try {
    const { changed, current } = await reverifyEnsResolution(transport, shown);
    if (changed) return { kind: 'changed', resolution: current, message: nameChangedSentence(shown.name) };
    return { kind: 'same', resolution: current };
  } catch (e) {
    if (e instanceof EnsResolutionError) {
      return { kind: 'refused', message: describeNameError(e, shown.name, registryLabel) };
    }
    throw e;
  }
}
