/**
 * The fee read every EVM quote makes (NodeClient.suggestFees in
 * packages/chains-evm/src/rpc.ts: eth_getBlockByNumber("latest", false) for
 * the base fee, then eth_maxPriorityFeePerGas), with ONE retry on the same
 * endpoint when the endpoint answered one of those two reads with HTTP 400.
 *
 * Why a retry here and nowhere else (finding 3 of the phase 14 emulator
 * pass, where a Review once failed with "RPC HTTP error 400 for
 * eth_getBlockByNumber"): the app-wide failover rule
 * (../config/endpoint-probe.ts isEndpointFailure) deliberately does NOT
 * count HTTP 400 as an endpoint failure, because reverts and malformed
 * requests come back that way and asking another endpoint would only repeat
 * the same answer. That reasoning does not apply to these two reads: their
 * parameters are fixed by the wallet (no user input, nothing that can
 * revert), and they are read-only, so repeating one has no side effect. An
 * HTTP 400 for them is a passing refusal by the provider, not an answer
 * about the user's transaction. The rule is therefore left unchanged: the
 * retry stays on the SAME endpoint, happens at most once, and covers only
 * HTTP 400 for these two methods; every other error (and a second failure)
 * is thrown unchanged for the caller's usual handling.
 *
 * Free of React Native imports so the check scripts can run it directly.
 */

/** The minimal shape this module needs (NodeClient satisfies it). */
export interface FeeSuggester {
  suggestFees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
}

/** The two reads NodeClient.suggestFees makes. */
const FEE_READ_METHODS = ['eth_getBlockByNumber', 'eth_maxPriorityFeePerGas'] as const;

/**
 * True for the engine transports' wording of an HTTP 400 answer to one of
 * the fee reads ("RPC HTTP error 400 for eth_getBlockByNumber").
 */
export function isRetryableFeeReadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const match = /\bRPC HTTP error 400 for ([A-Za-z0-9_]+)\b/.exec(message);
  return match !== null && (FEE_READ_METHODS as readonly string[]).includes(match[1]!);
}

/** suggestFees with the single same-endpoint retry described above. */
export async function suggestFeesRetryingOnce(
  client: FeeSuggester,
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  try {
    return await client.suggestFees();
  } catch (error) {
    if (!isRetryableFeeReadError(error)) throw error;
    return client.suggestFees();
  }
}
