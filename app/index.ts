// The polyfill import MUST stay first: it installs crypto.getRandomValues
// before @shiba-wallet/core (imported transitively by ./App) evaluates.
// See src/polyfills.ts for the full explanation.
import './src/polyfills';

import { registerRootComponent } from 'expo';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
