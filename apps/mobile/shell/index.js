/**
 * @format
 */

// Must be first: installs crypto.getRandomValues (native) for PKCE.
import 'react-native-get-random-values';
import { AppRegistry } from 'react-native';
import { installPolyfills } from './src/services/polyfills';
import App from './App';
import { name as appName } from './app.json';

installPolyfills();

AppRegistry.registerComponent(appName, () => App);
