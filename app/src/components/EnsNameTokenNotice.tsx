import React, { useEffect, useState } from 'react';
import { httpTransport as evmHttpTransport } from '@shiba-wallet/chains-evm';
import { WarningBox } from '../components';
import { getEndpoint } from '../config/networks';
import { isEnsNameRegistry } from '../wallet/nfts';
import { ensNameTokenWarning, readEnsNameTokenState, type EnsNameTokenRead } from '../wallet/send-nft';

/**
 * The warning for a token of ENS's pinned ENSv2 .eth registry (phase 25,
 * pass p25-emu1): the token IS a .eth name, so sending it hands the name
 * over. Shown on the NFT detail screen, the Send NFT form and the NFT send
 * confirm; renders nothing for any other token. The name's expiry is read
 * from the registry (getState) through `url`, or through the network's own
 * endpoint when no url is given; until it answers the box says it is
 * reading, and a failed read says so rather than guessing a date.
 */
export function EnsNameTokenNotice({
  chainCaip2,
  contract,
  tokenId,
  indexerName,
  url,
}: {
  chainCaip2: string;
  contract: string;
  tokenId: bigint;
  indexerName: string | null | undefined;
  /** The endpoint to read through; undefined → resolve the network's endpoint. */
  url?: string | null;
}) {
  const pinned = isEnsNameRegistry(chainCaip2, contract);
  const [read, setRead] = useState<{ key: string; value: EnsNameTokenRead } | null>(null);
  const key = `${chainCaip2}|${contract}|${tokenId.toString()}|${url ?? ''}`;

  useEffect(() => {
    if (!pinned) return;
    let cancelled = false;
    const settle = (value: EnsNameTokenRead) => {
      if (!cancelled) setRead({ key, value });
    };
    (async () => {
      const endpoint = url ?? (await getEndpoint(chainCaip2))?.url ?? null;
      if (!endpoint) return settle({ kind: 'unread' });
      settle({ kind: 'read', state: await readEnsNameTokenState(evmHttpTransport(endpoint), tokenId) });
    })().catch(() => settle({ kind: 'unread' }));
    return () => {
      cancelled = true;
    };
  }, [pinned, key, url, chainCaip2, tokenId]);

  const text = ensNameTokenWarning({
    chainCaip2,
    contract,
    tokenId,
    indexerName,
    read: read !== null && read.key === key ? read.value : { kind: 'reading' },
  });
  return text === null ? null : <WarningBox>{text}</WarningBox>;
}
