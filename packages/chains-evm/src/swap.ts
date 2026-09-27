/**
 * Swap quote abstraction (phase 4, item 7 — engine groundwork only).
 * Swaps are the wallet's primary revenue feature per the Feature
 * Universe, so the interface lands ahead of any UI: vendor-neutral, one
 * aggregator adapter, exercised through fakes until an API key exists.
 *
 * The 0x adapter targets the documented Swap API v2 allowance-holder
 * quote (docs.0x.org api-reference: GET
 * https://api.0x.org/swap/allowance-holder/quote with headers 0x-api-key
 * and 0x-version: v2; params chainId, sellToken, buyToken,
 * sellAmount/buyAmount, taker, slippageBps; response buyAmount,
 * minBuyAmount, sellAmount as strings, liquidityAvailable boolean, and a
 * transaction object with to/data/value/gas/gasPrice). The API key is
 * injected at construction and never defaulted or stored by this module.
 */

export interface SwapQuoteRequest {
  chainId: bigint;
  /** ERC-20 contract address of the token being sold. */
  sellToken: string;
  /** ERC-20 contract address of the token being bought. */
  buyToken: string;
  /** Exact input amount in the sell token's base units. */
  sellAmount: bigint;
  /** The address that holds the sell token and will send the swap tx. */
  taker: string;
  /** Maximum acceptable slippage in basis points (100 = 1%). */
  slippageBps?: number;
}

export interface SwapQuote {
  sellAmount: bigint;
  buyAmount: bigint;
  /** Worst acceptable output after slippage; what the user is promised. */
  minBuyAmount: bigint;
  /** The transaction that executes the swap, ready for the send flow. */
  transaction: {
    to: string;
    data: string;
    value: bigint;
    gas?: bigint;
  };
}

export type SwapQuoteResult =
  | { ok: true; quote: SwapQuote }
  | { ok: false; reason: 'no-liquidity' | 'error'; detail?: string };

export interface SwapQuoteProvider {
  getQuote(request: SwapQuoteRequest): Promise<SwapQuoteResult>;
}

export interface ZeroExConfig {
  apiKey: string;
  /** Override for tests or proxies; the documented production base. */
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export function zeroExSwapProvider(config: ZeroExConfig): SwapQuoteProvider {
  const base = (config.baseUrl ?? 'https://api.0x.org').replace(/\/$/, '');
  const fetchFn = config.fetchFn ?? fetch;

  return {
    async getQuote(request: SwapQuoteRequest): Promise<SwapQuoteResult> {
      const params = new URLSearchParams({
        chainId: request.chainId.toString(),
        sellToken: request.sellToken,
        buyToken: request.buyToken,
        sellAmount: request.sellAmount.toString(),
        taker: request.taker,
      });
      if (request.slippageBps !== undefined) {
        params.set('slippageBps', String(request.slippageBps));
      }
      const response = await fetchFn(
        `${base}/swap/allowance-holder/quote?${params.toString()}`,
        { headers: { '0x-api-key': config.apiKey, '0x-version': 'v2' } },
      );
      if (!response.ok) {
        return {
          ok: false,
          reason: 'error',
          detail: `HTTP ${response.status} from the swap service`,
        };
      }
      const body = (await response.json()) as {
        liquidityAvailable?: boolean;
        sellAmount?: string;
        buyAmount?: string;
        minBuyAmount?: string;
        transaction?: {
          to?: string;
          data?: string;
          value?: string;
          gas?: string;
        };
      };
      if (body.liquidityAvailable === false) {
        return { ok: false, reason: 'no-liquidity' };
      }
      const tx = body.transaction;
      if (!body.buyAmount || !body.minBuyAmount || !body.sellAmount || !tx?.to || !tx.data) {
        return {
          ok: false,
          reason: 'error',
          detail: 'Swap service returned an incomplete quote',
        };
      }
      return {
        ok: true,
        quote: {
          sellAmount: BigInt(body.sellAmount),
          buyAmount: BigInt(body.buyAmount),
          minBuyAmount: BigInt(body.minBuyAmount),
          transaction: {
            to: tx.to,
            data: tx.data,
            value: BigInt(tx.value ?? '0'),
            ...(tx.gas !== undefined ? { gas: BigInt(tx.gas) } : {}),
          },
        },
      };
    },
  };
}
