import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Platform, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { PriceQuote } from '@shiba-wallet/prices';
import type { RootStackParamList } from '../navigation';
import { Button, WarningBox, screenStyle, useFieldLabels } from '../components';
import { useTheme } from '../theme';
import { usePrefs } from '../wallet/PrefsContext';
import { usePrices } from '../wallet/usePrices';
import { useOnAppActive } from '../components/RecurringDueBanner';
import { staleNoteFor } from '../wallet/prices';
import { appNotifications, describeNotificationsStatus, type NotificationsStatus } from '../wallet/notifications';
import {
  EMPTY_BOOK,
  PRICE_ALERTS_CHECK_NOTE,
  PRICE_ALERTS_DAMAGED_MESSAGE,
  PRICE_ALERTS_EXPO_GO_NOTE,
  PRICE_ALERTS_FIAT_OFF_NOTE,
  PRICE_ALERTS_HYSTERESIS_NOTE,
  PRICE_ALERTS_INTRO,
  PRICE_ALERTS_NOTIFY_OFF_NOTE,
  PRICE_ALERTS_NOTIFY_ON_NOTE,
  PRICE_ALERTS_STORAGE_NOTE,
  WATCHABLE_ASSETS,
  addAlert,
  addToWatchlist,
  alertRuleText,
  alertStateText,
  confirmRemoveAlert,
  latestMonitorQuotes,
  loadPriceAlerts,
  newestQuote,
  parseThreshold,
  priceText,
  removeAlert,
  removeFromWatchlist,
  resetPriceAlerts,
  subscribeMonitorQuotes,
  subscribePriceAlerts,
  updatePriceAlerts,
  watchAssetFor,
  type AlertDirection,
  type PriceAlertBook,
  type WatchAsset,
} from '../wallet/price-alerts';

type Props = NativeStackScreenProps<RootStackParamList, 'PriceAlerts'>;

/**
 * Watchlist and price alerts (feature 98). Market prices and alert prices
 * are not the user's holdings, so they are shown under Hide amounts too
 * (nothing here reveals a balance). Works for every kind of account: alerts
 * are about prices, not about an account, and nothing here signs.
 */
export function PriceAlertsScreen(_props: Props) {
  const theme = useTheme();
  const { showFiat, notifications } = usePrefs();
  const [book, setBook] = useState<PriceAlertBook>(EMPTY_BOOK);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const reload = useCallback(() => {
    loadPriceAlerts().then(
      (b) => {
        setBook(b);
        setLoaded(true);
      },
      (e: unknown) => {
        setError(e instanceof Error ? e.message : 'The watchlist could not be read.');
        setLoaded(true);
      },
    );
  }, []);
  useEffect(() => {
    reload();
    return subscribePriceAlerts(reload);
  }, [reload]);

  const { quotes, refresh } = usePrices(book.watchlist);
  useFocusEffect(
    useCallback(() => {
      setNow(Date.now());
      void refresh();
    }, [refresh]),
  );
  // A return to the foreground reads the prices again (focus does not fire then).
  useOnAppActive(() => {
    setNow(Date.now());
    void refresh();
  });
  // The monitor's checks may hold a newer price than this screen's own read
  // (pass p20b finding 5a): each card shows the newer of the two.
  const [monitorQuotes, setMonitorQuotes] = useState(() => latestMonitorQuotes());
  useEffect(
    () =>
      subscribeMonitorQuotes(() => {
        setMonitorQuotes(latestMonitorQuotes());
        setNow(Date.now());
      }),
    [],
  );
  const quoteFor = (id: string): PriceQuote | null => (showFiat ? newestQuote(quotes.get(id), monitorQuotes.get(id)) : null);

  const [status, setStatus] = useState<NotificationsStatus | null>(() => appNotifications().status());
  useEffect(() => appNotifications().subscribe(() => setStatus(appNotifications().status())), []);
  const badStatus = status && (status.state === 'blocked' || status.state === 'unavailable' || status.state === 'failed') ? status : null;

  const apply = async <T,>(change: (b: PriceAlertBook) => { book: PriceAlertBook; result: T }): Promise<T | null> => {
    setError(null);
    try {
      return await updatePriceAlerts(change);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The change could not be saved.');
      return null;
    }
  };

  const confirmReset = () =>
    Alert.alert('Reset the watchlist?', 'This deletes the stored watchlist and every price alert on this phone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reset',
        style: 'destructive',
        onPress: () => void resetPriceAlerts().then(reload, () => setError('The watchlist could not be reset.')),
      },
    ]);

  const unwatched = WATCHABLE_ASSETS.filter((a) => !book.watchlist.includes(a.id));

  return (
    <ScrollView
      style={screenStyle(theme)}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={false}
          onRefresh={() => {
            setNow(Date.now());
            void refresh();
          }}
          tintColor={theme.textMuted}
          colors={[theme.accent]}
        />
      }
    >
      <Text style={[styles.body, { color: theme.text }]}>{PRICE_ALERTS_INTRO}</Text>
      {!showFiat ? <WarningBox>{PRICE_ALERTS_FIAT_OFF_NOTE}</WarningBox> : null}
      {book.damaged ? (
        <View style={styles.section}>
          <WarningBox>{PRICE_ALERTS_DAMAGED_MESSAGE}</WarningBox>
          <Button title="Reset the watchlist" variant="destructive" onPress={confirmReset} />
        </View>
      ) : null}
      {error ? (
        <Text accessibilityLiveRegion="polite" style={[styles.hint, { color: theme.danger }]}>
          {error}
        </Text>
      ) : null}
      {notice ? (
        <Text accessibilityLiveRegion="polite" style={[styles.hint, { color: theme.text }]}>
          {notice}
        </Text>
      ) : null}

      <View style={styles.section}>
        <Text accessibilityRole="header" style={[styles.sectionTitle, { color: theme.text }]}>
          Watchlist
        </Text>
        {loaded && book.watchlist.length === 0 && !book.damaged ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>Nothing is followed yet. Choose a coin below.</Text>
        ) : null}
        {book.watchlist.map((id) => {
          const asset = watchAssetFor(id);
          if (!asset) return null;
          return (
            <WatchRow
              key={id}
              asset={asset}
              book={book}
              quote={quoteFor(id)}
              now={now}
              disabled={book.damaged}
              onAdd={async (direction, threshold) => {
                const created = await apply((b) =>
                  addAlert(b, { assetId: id, direction, threshold, quote: quoteFor(id), nowMs: Date.now() }),
                );
                if (created) setNotice(created.note ?? `Alert set: ${alertRuleText(created.alert, asset.symbol)}.`);
                return created !== null;
              }}
              onRemoveAlert={(alertId, rule) =>
                confirmRemoveAlert(Alert.alert, rule, () => {
                  // A notice about an alert must not outlive it (pass p20b finding 5b).
                  setNotice(null);
                  void apply((b) => ({ book: removeAlert(b, alertId), result: null }));
                })
              }
              onUnwatch={() => {
                const count = book.alerts.filter((a) => a.assetId === id).length;
                const go = () => {
                  setNotice(null);
                  void apply((b) => ({ book: removeFromWatchlist(b, id), result: null }));
                };
                if (count === 0) go();
                else
                  Alert.alert(`Stop following ${asset.symbol}?`, `This also removes its ${count === 1 ? 'alert' : `${count} alerts`}.`, [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Remove', style: 'destructive', onPress: go },
                  ]);
              }}
            />
          );
        })}
      </View>

      {unwatched.length > 0 && !book.damaged ? (
        <View style={styles.section}>
          <Text accessibilityRole="header" style={[styles.sectionTitle, { color: theme.text }]}>
            Follow a coin
          </Text>
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Only main-network coins with a CoinGecko price can be followed: test-network coins have no price.
          </Text>
          <View style={styles.chips}>
            {unwatched.map((a) => (
              <Button
                key={a.id}
                title={`+ ${a.symbol}`}
                variant="secondary"
                accessibilityLabel={`Follow ${a.name} (${a.symbol})`}
                onPress={() => void apply((b) => ({ book: addToWatchlist(b, a.id), result: null }))}
                style={styles.chip}
              />
            ))}
          </View>
        </View>
      ) : null}

      <View style={styles.section}>
        <Text accessibilityRole="header" style={[styles.sectionTitle, { color: theme.text }]}>
          How alerts work
        </Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>{PRICE_ALERTS_CHECK_NOTE}</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>{PRICE_ALERTS_HYSTERESIS_NOTE}</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>{notifications ? PRICE_ALERTS_NOTIFY_ON_NOTE : PRICE_ALERTS_NOTIFY_OFF_NOTE}</Text>
        {Platform.OS === 'android' ? <Text style={[styles.hint, { color: theme.textMuted }]}>{PRICE_ALERTS_EXPO_GO_NOTE}</Text> : null}
        {badStatus ? <Text style={[styles.hint, { color: theme.danger }]}>{describeNotificationsStatus(badStatus)}</Text> : null}
        <Text style={[styles.hint, { color: theme.textMuted }]}>{PRICE_ALERTS_STORAGE_NOTE}</Text>
      </View>
    </ScrollView>
  );
}

function WatchRow({
  asset,
  book,
  quote,
  now,
  disabled,
  onAdd,
  onRemoveAlert,
  onUnwatch,
}: {
  asset: WatchAsset;
  book: PriceAlertBook;
  quote: PriceQuote | null;
  now: number;
  disabled: boolean;
  onAdd: (direction: AlertDirection, threshold: string) => Promise<boolean>;
  onRemoveAlert: (id: string, rule: string) => void;
  onUnwatch: () => void;
}) {
  const theme = useTheme();
  const fieldLabel = useFieldLabels();
  const priceField = fieldLabel('price', `Alert price for ${asset.symbol} (US dollars)`);
  const [direction, setDirection] = useState<AlertDirection>('above');
  const [text, setText] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const alerts = book.alerts.filter((a) => a.assetId === asset.id);
  const stale = quote ? staleNoteFor(quote, now) : null;
  const price = quote ? priceText(quote.price) : null;
  return (
    <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <View
        accessible
        accessibilityLabel={`${asset.name} (${asset.symbol}): ${price ? `price ${price}${stale ? `, ${stale}` : ''}, from CoinGecko` : 'no price right now'}`}
      >
        <Text style={[styles.symbol, { color: theme.text }]}>
          {asset.symbol} · {asset.name}
        </Text>
        <Text style={[styles.price, { color: theme.text }]}>{price ?? 'No price right now'}</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          {price ? `CoinGecko, US dollars${stale ? ` · ${stale}` : ''}` : 'CoinGecko did not answer with a price; pull down to try again.'}
        </Text>
      </View>
      {alerts.map((a) => (
        <View key={a.id} style={styles.alertRow}>
          <View style={styles.alertText} accessible accessibilityLabel={`Alert: ${alertRuleText(a, asset.symbol)}. ${alertStateText(a, asset.symbol, now)}`}>
            <Text style={[styles.alertRule, { color: theme.text }]}>{alertRuleText(a, asset.symbol)}</Text>
            <Text style={[styles.hint, { color: theme.textMuted }]}>{alertStateText(a, asset.symbol, now)}</Text>
          </View>
          <Button
            title="Remove"
            variant="secondary"
            disabled={disabled}
            accessibilityLabel={`Remove the alert ${alertRuleText(a, asset.symbol)}`}
            onPress={() => onRemoveAlert(a.id, alertRuleText(a, asset.symbol))}
            style={styles.smallButton}
          />
        </View>
      ))}
      <View style={styles.chips}>
        {(['above', 'below'] as const).map((d) => (
          <Button
            key={d}
            title={`${direction === d ? '✓ ' : ''}${d === 'above' ? 'Above' : 'Below'}`}
            variant="secondary"
            selected={direction === d}
            disabled={disabled}
            onPress={() => setDirection(d)}
            style={styles.chip}
          />
        ))}
      </View>
      {/* A visible label for the price field (pass p20d finding 1): TalkBack
          ignores a field's own accessibilityLabel while it shows a
          placeholder, so the field is "labelled by" this caption. */}
      <Text {...priceField.label} style={[styles.hint, { color: theme.textMuted }]}>{priceField.text}</Text>
      <TextInput
        {...priceField.input}
        value={text}
        onChangeText={(v) => {
          setText(v);
          setFormError(null);
        }}
        editable={!disabled}
        placeholder="For example 3000"
        placeholderTextColor={theme.textMuted}
        keyboardType="decimal-pad"
        style={[styles.input, { color: theme.text, borderColor: theme.controlBorder, backgroundColor: theme.background }]}
      />
      {formError ? <Text style={[styles.hint, { color: theme.danger }]}>{formError}</Text> : null}
      <Button
        title={`Set alert: ${asset.symbol} ${direction} this price`}
        disabled={disabled}
        onPress={() => {
          const parsed = parseThreshold(text);
          if (!parsed.ok) {
            setFormError(parsed.error);
            return;
          }
          void onAdd(direction, parsed.value).then((ok) => {
            if (ok) setText('');
          });
        }}
      />
      <Button title={`Stop following ${asset.symbol}`} variant="secondary" disabled={disabled} onPress={onUnwatch} />
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 24, gap: 24 },
  section: { gap: 12 },
  sectionTitle: { fontSize: 18, fontWeight: '700' },
  body: { fontSize: 15, lineHeight: 22 },
  hint: { fontSize: 13, lineHeight: 19 },
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 10 },
  symbol: { fontSize: 16, fontWeight: '700' },
  price: { fontSize: 20, fontWeight: '700', fontVariant: ['tabular-nums'] },
  alertRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  alertText: { flex: 1, gap: 2 },
  alertRule: { fontSize: 15, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  chip: { flexGrow: 1, flexBasis: '40%', minWidth: 120, paddingVertical: 10 },
  smallButton: { paddingVertical: 8, paddingHorizontal: 12 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
});
