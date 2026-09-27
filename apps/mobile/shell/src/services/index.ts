import type { AppServices } from './types';

export type Mode = 'demo' | 'live';

// __DEV__ is a compile-time constant in Metro, so in a release bundle the demo
// branch below is dead code and the demo modules are not included.
export const DEMO_AVAILABLE = __DEV__;
export const DEFAULT_MODE: Mode = __DEV__ ? 'demo' : 'live';

export function createServices(mode: Mode): AppServices {
  if (__DEV__ && mode === 'demo') {
    const { createDemoServices } = require('../demo/demoServices');
    const { queueStorage, netInfoConnectivity } = require('./adapters');
    return createDemoServices({
      queueStorage,
      deviceConnectivity: netInfoConnectivity(),
    });
  }
  const { createLiveServices } = require('./live');
  return createLiveServices();
}
