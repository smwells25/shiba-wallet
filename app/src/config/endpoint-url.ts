/**
 * The single check every user-entered endpoint URL passes before the app
 * saves it or sends a verification request to it (RPC overrides, the
 * Blockbook endpoint, the history and NFT indexers, and the smart-account
 * bundler, node and paymaster URLs).
 *
 * Rule: endpoints must use https://. Plain http:// would send balances,
 * addresses, signed transactions and any API key embedded in the URL in
 * clear text, where anyone on the network path can read or alter them, and
 * it keeps the privacy disclosure (docs/PRIVACY.md) honest about data being
 * encrypted in transit.
 *
 * The ONE exception is a loopback host, so a developer can point the app
 * at a node running on the same machine: localhost, 127.0.0.1, ::1 (written
 * [::1] in a URL), and 10.0.2.2, which the Android emulator maps to the
 * host computer's loopback interface. Traffic to these never leaves the
 * device or the developer's machine. The match is exact on the host name:
 * other private addresses (192.168.x.x, 10.x.x.x) and look-alikes such as
 * http://localhost@example.com (whose host is example.com) are refused.
 *
 * The URL is parsed with a small regular expression rather than the URL
 * class, because the URL implementation available under React Native has
 * historically lacked parts of the standard API.
 *
 * Kept free of React Native imports so the Node check scripts can load it
 * directly.
 */

/** The refusal sentence shown in Settings when a URL is not https. */
export const INSECURE_ENDPOINT_MESSAGE =
  'Endpoints must use https:// (plain http:// is accepted only for localhost or 10.0.2.2 during development).';

/**
 * Hosts that may use plain http:// (compared lowercase, IPv6 without its
 * brackets).
 */
export const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '::1', '10.0.2.2'];

/**
 * Validates and normalizes an endpoint URL. Returns the trimmed URL with
 * trailing slashes removed and the scheme lowercased; throws an Error with
 * a plain-language message otherwise. Performs no network access.
 */
export function assertSecureEndpointUrl(raw: string): string {
  const match = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(raw.trim());
  if (!match) throw new Error(INSECURE_ENDPOINT_MESSAGE);
  const scheme = match[1]!.toLowerCase();
  const rest = match[2]!.replace(/\/+$/, '');
  if (scheme !== 'https' && scheme !== 'http') throw new Error(INSECURE_ENDPOINT_MESSAGE);
  if (/\s/.test(rest) || [...rest].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) {
    throw new Error('Endpoint URLs cannot contain spaces or control characters.');
  }
  const host = hostOf(rest);
  if (host === null) {
    throw new Error(`That endpoint URL is incomplete: it needs a host name after ${scheme}://.`);
  }
  if (scheme === 'http' && !LOOPBACK_HOSTS.includes(host)) {
    throw new Error(INSECURE_ENDPOINT_MESSAGE);
  }
  return `${scheme}://${rest}`;
}

/**
 * The lowercase host name of the part after "scheme://" (IPv6 without
 * brackets), or null when the host is missing or the port is malformed.
 * Any user information before the LAST "@" of the authority is skipped, so
 * http://localhost@example.com yields example.com.
 */
function hostOf(rest: string): string | null {
  const authority = rest.split(/[/?#]/, 1)[0] ?? '';
  const at = authority.lastIndexOf('@');
  const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
  let host: string;
  let port: string | undefined;
  if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']');
    if (close < 0) return null;
    host = hostPort.slice(1, close);
    const after = hostPort.slice(close + 1);
    if (after !== '') {
      if (!after.startsWith(':')) return null;
      port = after.slice(1);
    }
  } else {
    const colon = hostPort.indexOf(':');
    host = colon >= 0 ? hostPort.slice(0, colon) : hostPort;
    if (colon >= 0) port = hostPort.slice(colon + 1);
  }
  if (host === '') return null;
  if (port !== undefined && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
    return null;
  }
  return host.toLowerCase();
}
