import { bigintToHex, toBytes, toHex } from './encoding.js';
import type { JsonRpcTransport } from './rpc.js';

/**
 * Pre-flight simulation, first slice (phase 2, task 6): run the call through
 * eth_call before asking the user to sign, and translate a revert into a
 * human-readable reason. Full asset-diff simulation (feature 49's end state)
 * needs richer infrastructure and comes later; this already catches the
 * majority of doomed transactions (bad calldata, insufficient token balance,
 * failing require) at zero cost.
 */

export interface SimulationRequest {
  from: string;
  to: string;
  value?: bigint;
  data?: Uint8Array;
}

export type SimulationResult =
  | { ok: true; returnData: string }
  | { ok: false; reason: string; raw?: string };

/** Error(string) selector: keccak256("Error(string)")[0..4]. */
const ERROR_STRING_SELECTOR = '0x08c379a0';
/** Panic(uint256) selector: keccak256("Panic(uint256)")[0..4]. */
const PANIC_SELECTOR = '0x4e487b71';

/** Well-known Panic codes from the Solidity documentation. */
const PANIC_CODES: Record<number, string> = {
  0x01: 'assertion failed',
  0x11: 'arithmetic overflow or underflow',
  0x12: 'division by zero',
  0x21: 'invalid enum value',
  0x31: 'pop on empty array',
  0x32: 'array index out of bounds',
  0x41: 'out of memory',
  0x51: 'call to an uninitialized function',
};

/** Decodes revert bytes into a readable reason. Exported for reuse. */
export function decodeRevertReason(revertData: string): string {
  if (!revertData || revertData === '0x') {
    return 'reverted without a reason';
  }
  if (revertData.startsWith(ERROR_STRING_SELECTOR)) {
    try {
      // abi.encode(string): offset word, length word, then UTF-8 bytes.
      const body = toBytes('0x' + revertData.slice(ERROR_STRING_SELECTOR.length));
      const length = Number(BigInt(toHex(body.slice(32, 64))));
      const text = new TextDecoder().decode(body.slice(64, 64 + length));
      return `reverted: ${text}`;
    } catch {
      return `reverted (undecodable Error(string) payload)`;
    }
  }
  if (revertData.startsWith(PANIC_SELECTOR)) {
    const code = Number(BigInt('0x' + revertData.slice(PANIC_SELECTOR.length)));
    return `panic: ${PANIC_CODES[code] ?? `code 0x${code.toString(16)}`}`;
  }
  return `reverted with custom error data ${revertData.slice(0, 10)}…`;
}

/**
 * Runs eth_call for the prospective transaction. JSON-RPC error shapes for
 * reverts vary by node vendor; the revert payload is looked for in the
 * error's `data` field (string, or object with a `data` member), which
 * covers geth- and erigon-style responses passed through our httpTransport
 * (it surfaces RPC errors as thrown Errors with the message; transports
 * that expose structured errors can pass the payload via the thrown
 * error's `data` property).
 */
export async function simulateCall(
  transport: JsonRpcTransport,
  request: SimulationRequest,
): Promise<SimulationResult> {
  const params: Record<string, string> = { from: request.from, to: request.to };
  if (request.value !== undefined) params.value = bigintToHex(request.value);
  if (request.data !== undefined && request.data.length > 0) {
    params.data = toHex(request.data);
  }
  try {
    const returnData = (await transport('eth_call', [params, 'latest'])) as string;
    return { ok: true, returnData };
  } catch (error) {
    const raw = extractRevertData(error);
    if (raw) return { ok: false, reason: decodeRevertReason(raw), raw };
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'call failed',
    };
  }
}

function extractRevertData(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const data = (error as { data?: unknown }).data;
  if (typeof data === 'string' && data.startsWith('0x')) return data;
  if (typeof data === 'object' && data !== null) {
    const inner = (data as { data?: unknown }).data;
    if (typeof inner === 'string' && inner.startsWith('0x')) return inner;
  }
  return undefined;
}
