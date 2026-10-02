import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import type { OwnedNft } from '@shiba-wallet/chains-evm';
import { useTheme } from '../theme';
import { imageCandidates, loadNftImage, type ImageLoad } from '../wallet/nfts';

/**
 * One NFT image, raster only. Every byte is fetched by wallet/nfts.ts
 * loadNftImage (size-capped, magic-byte sniffed, SVG refused) and handed to
 * React Native's Image as a base64 data: URI — the image view itself never
 * receives a remote URL, so nothing bypasses those rules. When no
 * candidate yields a raster image, or the platform cannot decode the
 * format (React Native's docs note GIF/WebP need optional modules on
 * Android, so onError is handled), an honest placeholder is shown.
 *
 * A small in-memory cache keeps decoded thumbnails while the app runs so
 * scrolling the grid does not refetch them; detail-size images are not
 * cached (they can be up to the 4 MiB cap).
 */
const thumbCache = new Map<string, ImageLoad>();

/** Size/shape only, so the same style fits the Image and the placeholder View. */
type NftImageStyle = Pick<ViewStyle, 'width' | 'height' | 'aspectRatio' | 'borderRadius'>;
const THUMB_CACHE_LIMIT = 80;

function cacheKey(chainId: string, nft: OwnedNft): string {
  return `${chainId}/${nft.contract.toLowerCase()}/${nft.tokenId.toString()}`;
}

export function NftImage({
  chainId,
  nft,
  variant,
  style,
  extraCandidates = [],
}: {
  /** CAIP-2 chain of the NFT (part of the cache key: same address, other chain). */
  chainId: string;
  nft: OwnedNft;
  variant: 'thumb' | 'full';
  style: NftImageStyle;
  /** Additional URIs to try last (e.g. the image from fetched metadata). */
  extraCandidates?: string[];
}) {
  const theme = useTheme();
  const key = cacheKey(chainId, nft);
  const cached = variant === 'thumb' ? thumbCache.get(key) : undefined;
  const [state, setState] = useState<ImageLoad | null>(cached ?? null);
  const [decodeFailed, setDecodeFailed] = useState(false);
  const extraKey = extraCandidates.join('\n');

  // When the image inputs change, the shown state is reset while rendering
  // (React's "adjust state when a prop changes" pattern): a cached thumbnail
  // is shown at once, anything else goes back to the loading state with the
  // decode-failure flag cleared. The effect below only loads.
  const [shownInputs, setShownInputs] = useState({ key, variant, extraKey });
  if (shownInputs.key !== key || shownInputs.variant !== variant || shownInputs.extraKey !== extraKey) {
    setShownInputs({ key, variant, extraKey });
    if (variant === 'thumb' && thumbCache.has(key)) {
      setState(thumbCache.get(key)!);
    } else {
      setState(null);
      setDecodeFailed(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    if (variant === 'thumb' && thumbCache.has(key)) {
      // Normally the render above already showed this cached thumbnail and
      // this update is a no-op (same object). It still matters when another
      // image finished loading the same thumbnail after that render.
      const cachedNow = thumbCache.get(key)!;
      void Promise.resolve(cachedNow).then((result) => {
        if (!cancelled) setState(result);
      });
      return () => {
        cancelled = true;
      };
    }
    const candidates = [...imageCandidates(nft, variant)];
    for (const extra of extraCandidates) if (!candidates.includes(extra)) candidates.push(extra);
    loadNftImage(candidates).then(
      (result) => {
        if (cancelled) return;
        if (variant === 'thumb') {
          if (thumbCache.size >= THUMB_CACHE_LIMIT) {
            const oldest = thumbCache.keys().next().value;
            if (oldest !== undefined) thumbCache.delete(oldest);
          }
          thumbCache.set(key, result);
        }
        setState(result);
      },
      () => {
        if (!cancelled) setState({ ok: false, reason: 'unavailable', detail: 'Image unavailable.' });
      },
    );
    return () => {
      cancelled = true;
    };
    // nft identity is captured by key; extraKey covers extraCandidates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, variant, extraKey]);

  if (state === null) {
    return (
      <View style={[styles.box, { backgroundColor: theme.card, borderColor: theme.border }, style]}>
        <ActivityIndicator color={theme.textMuted} />
      </View>
    );
  }
  if (state.ok && !decodeFailed) {
    return (
      <Image
        source={{ uri: state.dataUri }}
        style={[styles.image, { backgroundColor: theme.card }, style]}
        resizeMode={variant === 'thumb' ? 'cover' : 'contain'}
        onError={() => setDecodeFailed(true)}
        accessibilityIgnoresInvertColors
      />
    );
  }
  const label = decodeFailed
    ? 'Image format not supported on this device'
    : !state.ok && state.reason === 'svg'
      ? 'SVG image not shown'
      : !state.ok && state.reason === 'none'
        ? 'No image'
        : 'Image unavailable';
  return (
    <View
      style={[styles.box, { backgroundColor: theme.card, borderColor: theme.border }, style]}
      accessibilityLabel={label}
    >
      <Text style={[styles.placeholderGlyph, { color: theme.textMuted }]}>◇</Text>
      <Text style={[styles.placeholderText, { color: theme.textMuted }]} numberOfLines={3}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 6,
    gap: 4,
  },
  image: {
    overflow: 'hidden',
  },
  placeholderGlyph: {
    fontSize: 22,
  },
  placeholderText: {
    fontSize: 11,
    textAlign: 'center',
  },
});
