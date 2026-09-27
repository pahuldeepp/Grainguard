import * as Keychain from 'react-native-keychain';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import type { SecureStore } from '@greenguard/mobile-core';
import type { Connectivity } from './types';

// Keychain-backed SecureStore: one Keychain generic-password item per key,
// stored with the "when unlocked, this device only" accessibility class so
// tokens never sync to iCloud or leave the device.
export const keychainStore: SecureStore = {
  async getItem(key) {
    const found = await Keychain.getGenericPassword({ service: key });
    return found ? found.password : null;
  },
  async setItem(key, value) {
    await Keychain.setGenericPassword('greenguard', value, {
      service: key,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },
  async removeItem(key) {
    await Keychain.resetGenericPassword({ service: key });
  },
};

// Queue storage. Acknowledgement commands hold alert ids and idempotency keys,
// not tokens, so plain AsyncStorage is acceptable; tokens never go here.
export const queueStorage: SecureStore = {
  getItem: key => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: key => AsyncStorage.removeItem(key),
};

function reachable(state: {
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
}): boolean {
  return state.isConnected !== false && state.isInternetReachable !== false;
}

export function netInfoConnectivity(): Connectivity {
  let online = true;
  const listeners = new Set<(online: boolean) => void>();
  NetInfo.addEventListener(state => {
    const next = reachable(state);
    if (next === online) return;
    online = next;
    listeners.forEach(listener => listener(online));
  });
  return {
    isOnline: () => online,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
