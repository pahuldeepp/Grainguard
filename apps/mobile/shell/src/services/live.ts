// LIVE MODE. Real core classes over Keychain, AsyncStorage and NetInfo.
// Sign-in is Authorization Code + PKCE in the system browser (Linking); the
// redirect returns through the greenguard:// URL scheme (Info.plist and
// SceneDelegate). Tokens go only to the Keychain-backed SecureStore.
import { Linking } from 'react-native';
import { AckQueue, AlertsClient, MobileSession } from '@greenguard/mobile-core';
import { keychainStore, netInfoConnectivity, queueStorage } from './adapters';
import { waitForCallback } from './callback';
import { LIVE_CONFIG, liveConfigured } from './config';
import { shellCrypto } from './polyfills';
import type { AppServices } from './types';

export function createLiveServices(): AppServices {
  const crypto = shellCrypto();
  const deps = { fetch, now: Date.now, crypto };
  const session = new MobileSession(LIVE_CONFIG, keychainStore, deps);
  const alerts = new AlertsClient(LIVE_CONFIG.bffEndpoint, session, deps);
  const connectivity = netInfoConnectivity();
  session.onCleared(() => alerts.clearCache());
  const queue = new AckQueue(alerts, {
    storage: queueStorage,
    now: Date.now,
    newId: () => crypto.randomUUID(),
    random: Math.random,
    isOnline: connectivity.isOnline,
  });

  let pendingWait: ReturnType<typeof waitForCallback> | null = null;
  const openBrowser = async (url: string) => {
    // Listen before opening so a fast redirect cannot be missed.
    pendingWait?.cancel();
    const wait = waitForCallback(Linking, LIVE_CONFIG.redirectUri);
    pendingWait = wait;
    wait.promise.catch(() => undefined);
    try {
      await Linking.openURL(url);
      await session.completeSignIn(await wait.promise);
    } finally {
      wait.cancel();
      if (pendingWait === wait) pendingWait = null;
    }
  };

  return {
    mode: 'live',
    signInAvailable: liveConfigured(),
    alerts,
    queue,
    connectivity,
    session: {
      identity: () => session.identity(),
      async signIn() {
        if (!liveConfigured())
          throw new Error(
            'Live sign-in is not configured: this is a release build or src/services/config.ts is empty.',
          );
        await openBrowser(await session.beginSignIn());
      },
      cancelSignIn: () => pendingWait?.cancel(),
      signOut: () => session.signOut(),
      async switchTenant() {
        if (!liveConfigured())
          throw new Error('Live sign-in is not configured.');
        await openBrowser(await session.switchTenant());
      },
    },
    describeBin: binId => ({ bin: binId }),
  };
}
