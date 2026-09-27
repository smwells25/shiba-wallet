import React, { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { Button, screenStyle } from '../components';
import { useTheme } from '../theme';
import { useWallet } from '../wallet/WalletContext';

interface Question {
  /** Zero-based position of the word being asked about. */
  index: number;
  correct: string;
  choices: string[];
}

/**
 * Builds a two-question quiz over the mnemonic: for two random positions the
 * user must pick the right word from three choices. Decoys come from the
 * BIP-39 English wordlist. Math.random is fine here — the quiz is a UX
 * check of the user's written backup, not a cryptographic operation.
 */
function makeQuiz(words: string[]): Question[] {
  const positions: number[] = [];
  while (positions.length < 2) {
    const i = Math.floor(Math.random() * words.length);
    if (!positions.includes(i)) positions.push(i);
  }
  positions.sort((a, b) => a - b);
  return positions.map((index) => {
    const correct = words[index];
    const choices = new Set<string>([correct]);
    while (choices.size < 3) {
      choices.add(wordlist[Math.floor(Math.random() * wordlist.length)]);
    }
    return {
      index,
      correct,
      choices: [...choices].sort(() => Math.random() - 0.5),
    };
  });
}

export function ConfirmBackupScreen() {
  const theme = useTheme();
  const { pendingMnemonic, confirmCreate } = useWallet();
  const words = useMemo(
    () => (pendingMnemonic ? pendingMnemonic.split(' ') : []),
    [pendingMnemonic],
  );

  const [quiz, setQuiz] = useState<Question[]>(() => (words.length ? makeQuiz(words) : []));
  const [selected, setSelected] = useState<(string | null)[]>([null, null]);
  const [saving, setSaving] = useState(false);

  const verify = useCallback(async () => {
    const allCorrect = quiz.every((q, i) => selected[i] === q.correct);
    if (!allCorrect) {
      Alert.alert(
        'Not quite',
        'One of the words is wrong. Check your written backup against the previous screen and try again.',
      );
      setQuiz(makeQuiz(words));
      setSelected([null, null]);
      return;
    }
    setSaving(true);
    try {
      // Persists the mnemonic to secure storage; the app switches to the
      // main screens automatically when the wallet status becomes ready.
      await confirmCreate();
    } catch (e) {
      setSaving(false);
      Alert.alert('Could not save', e instanceof Error ? e.message : String(e));
    }
  }, [quiz, selected, words, confirmCreate]);

  return (
    <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
      <Text style={[styles.heading, { color: theme.text }]}>Confirm your backup</Text>
      <Text style={[styles.subtitle, { color: theme.textMuted }]}>
        Pick the correct word for each position to prove the backup was
        written down.
      </Text>
      {quiz.map((q, qi) => (
        <View key={q.index} style={styles.question}>
          <Text style={[styles.questionLabel, { color: theme.text }]}>
            Word #{q.index + 1}
          </Text>
          <View style={styles.choices}>
            {q.choices.map((choice) => {
              const active = selected[qi] === choice;
              return (
                <Pressable
                  key={choice}
                  accessibilityRole="button"
                  onPress={() => {
                    const next = [...selected];
                    next[qi] = choice;
                    setSelected(next);
                  }}
                  style={[
                    styles.choice,
                    {
                      backgroundColor: active ? theme.accent : theme.card,
                      borderColor: active ? theme.accent : theme.border,
                    },
                  ]}
                >
                  <Text style={{ color: active ? '#ffffff' : theme.text, fontWeight: '500' }}>
                    {choice}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}
      <Button
        title={saving ? 'Saving…' : 'Confirm'}
        disabled={saving || selected.some((s) => s === null)}
        onPress={verify}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 24,
    gap: 20,
  },
  heading: {
    fontSize: 24,
    fontWeight: '700',
  },
  subtitle: {
    fontSize: 15,
    lineHeight: 21,
  },
  question: {
    gap: 10,
  },
  questionLabel: {
    fontSize: 16,
    fontWeight: '600',
  },
  choices: {
    flexDirection: 'row',
    gap: 10,
  },
  choice: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 12,
    alignItems: 'center',
  },
});
