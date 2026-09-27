import React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import {
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  Theme as NavTheme,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { RootStackParamList } from './src/navigation';
import { useTheme } from './src/theme';
import { WalletProvider, useWallet } from './src/wallet/WalletContext';
import { WelcomeScreen } from './src/screens/WelcomeScreen';
import { BackupScreen } from './src/screens/BackupScreen';
import { ConfirmBackupScreen } from './src/screens/ConfirmBackupScreen';
import { ImportScreen } from './src/screens/ImportScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { ReceiveScreen } from './src/screens/ReceiveScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * Renders the onboarding stack while no wallet exists and the main stack
 * once one does. Because the two sets are mutually exclusive, completing
 * onboarding (or wiping the wallet) switches stacks automatically — no
 * manual "reset navigation" calls needed.
 */
function Root() {
  const theme = useTheme();
  const { status } = useWallet();

  if (status === 'loading') {
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.background,
        }}
      >
        <ActivityIndicator size="large" color={theme.accent} />
      </View>
    );
  }

  const navTheme: NavTheme = {
    ...(theme.dark ? DarkTheme : DefaultTheme),
    colors: {
      ...(theme.dark ? DarkTheme : DefaultTheme).colors,
      background: theme.background,
      card: theme.card,
      text: theme.text,
      border: theme.border,
      primary: theme.accent,
    },
  };

  return (
    <NavigationContainer theme={navTheme}>
      <Stack.Navigator>
        {status === 'no-wallet' ? (
          <>
            <Stack.Screen
              name="Welcome"
              component={WelcomeScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="Backup"
              component={BackupScreen}
              options={{ title: 'Back up' }}
            />
            <Stack.Screen
              name="ConfirmBackup"
              component={ConfirmBackupScreen}
              options={{ title: 'Confirm' }}
            />
            <Stack.Screen
              name="Import"
              component={ImportScreen}
              options={{ title: 'Import' }}
            />
          </>
        ) : (
          <>
            <Stack.Screen
              name="Home"
              component={HomeScreen}
              options={({ navigation }) => ({
                title: 'Shiba Wallet',
                headerRight: () => (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Settings"
                    onPress={() => navigation.navigate('Settings')}
                    hitSlop={8}
                  >
                    <Text style={{ fontSize: 20, color: theme.accent }}>⚙︎</Text>
                  </Pressable>
                ),
              })}
            />
            <Stack.Screen name="Receive" component={ReceiveScreen} />
            <Stack.Screen name="Settings" component={SettingsScreen} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <WalletProvider>
      <StatusBar style="auto" />
      <Root />
    </WalletProvider>
  );
}
