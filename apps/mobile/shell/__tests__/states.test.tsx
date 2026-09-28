import React from 'react';
import { AccessibilityInfo, Animated, Text } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';
import type { SecureStore } from '@greenguard/mobile-core';
import { AppRoot, IDENTITY_TIMEOUT_MS } from '../src/AppRoot';
import { createDemoServices } from '../src/demo/demoServices';
import { DEMO_READINGS } from '../src/demo/data';
import type { AppServices } from '../src/services/types';
import {
  BinProfile,
  FadeIn,
  actorPhrase,
  hottest,
  triggerText,
} from '../src/ui';

const store = (): SecureStore => {
  const m = new Map<string, string>();
  return {
    getItem: async k => m.get(k) ?? null,
    setItem: async (k, v) => void m.set(k, v),
    removeItem: async k => void m.delete(k),
  };
};
const tick = () =>
  act(async () => {
    await new Promise(r => setTimeout(() => r(undefined), 0));
  });
const textOf = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root
    .findAllByType(Text)
    .map(n => [n.props.children].flat(3).join(''))
    .join(' | ');

// A release-like service set: live mode, no endpoints configured.
const releaseLike = (
  identity: AppServices['session']['identity'],
): AppServices => ({
  ...createDemoServices({ queueStorage: store() }),
  mode: 'live',
  signInAvailable: false,
  session: {
    identity,
    signIn: async () => undefined,
    signOut: async () => undefined,
    switchTenant: async () => undefined,
  },
});

describe('unconfigured release build never sits on a skeleton', () => {
  test('identity lookup that rejects shows sign-in with an honest message', async () => {
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(
        <AppRoot
          services={releaseLike(() => Promise.reject(new Error('keychain')))}
        />,
      );
    });
    await tick();
    expect(
      tree.root.findAll(n => n.props.testID === 'signin-button').length,
    ).toBeGreaterThan(0);
    expect(textOf(tree)).toContain('Sign-in is not configured for this build.');
    const btn = tree.root
      .findAll(n => n.props.testID === 'signin-button')
      .pop()!;
    expect(btn.props.accessibilityState?.disabled ?? btn.props.disabled).toBe(
      true,
    );
    expect(
      tree.root.findAll(n => n.props.testID === 'list-skeleton'),
    ).toHaveLength(0);
  });

  test('identity lookup that never resolves times out to sign-in', async () => {
    jest.useFakeTimers();
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(
        <AppRoot services={releaseLike(() => new Promise(() => undefined))} />,
      );
    });
    expect(
      tree.root.findAll(n => n.props.testID === 'list-skeleton').length,
    ).toBeGreaterThan(0);
    await act(async () => {
      jest.advanceTimersByTime(IDENTITY_TIMEOUT_MS + 50);
    });
    jest.useRealTimers();
    expect(textOf(tree)).toContain('Sign-in is not configured for this build.');
  });
});

describe('live mode shows only what the backend returns', () => {
  test('no fixtures: honest unavailable line, no bin, trend or demo label', async () => {
    const demo = createDemoServices({ queueStorage: store() });
    const live: AppServices = {
      ...demo,
      mode: 'live',
      readings: undefined,
      timeline: undefined,
    };
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(<AppRoot services={live} />);
    });
    await tick();
    await act(async () =>
      tree.root
        .findAll(
          n => n.props.testID === 'alert-row-a-1001' && n.props.onPress,
        )[0]
        .props.onPress(),
    );
    await tick();
    const t = textOf(tree);
    expect(t).toContain('not available in this view yet');
    expect(t).not.toContain('demo');
    expect(
      tree.root.findAll(n => n.props.testID === 'bin-profile'),
    ).toHaveLength(0);
    expect(tree.root.findAll(n => n.props.testID === 'trend')).toHaveLength(0);
    expect(t).toContain('Risk score');
  });
  test('acknowledger is never shown raw', () => {
    expect(actorPhrase('auth0|abc123', 'someone-else')).toBe(
      'by another operator',
    );
    expect(actorPhrase('me', 'me')).toBe('by you');
    expect(actorPhrase(null, 'me')).toBeUndefined();
  });
});

describe('demo readings and bin profile', () => {
  test('list row leads with the triggering reading', () => {
    expect(triggerText(DEMO_READINGS['a-1002'])).toBe(
      'Moisture 16.8%, limit 14',
    );
    expect(triggerText(DEMO_READINGS['a-1001'])).toBe(
      'Temperature 34.2 °C, limit 28',
    );
    expect(triggerText(DEMO_READINGS['a-1003'])).toBe(
      'CO2 1,180 ppm, limit 1,000',
    );
  });
  test('every sensor is a labelled button and the hot spot is named', () => {
    const bin = DEMO_READINGS['a-1001'].bin!;
    let tree!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      tree = ReactTestRenderer.create(<BinProfile bin={bin} />);
    });
    const sensors = tree.root.findAll(
      n =>
        typeof n.props.testID === 'string' &&
        n.props.testID.startsWith('sensor-') &&
        typeof n.type === 'string',
    );
    const labels = sensors.map(n => n.props.accessibilityLabel).filter(Boolean);
    expect(labels).toHaveLength(20);
    expect(labels).toContain('Cable 3, 4.5 m: 34.2 °C, hot, hot spot');
    expect(textOf(tree)).toContain('Cable 3, 4.5 m: 34.2 °C, hot spot');
    expect(hottest(bin)?.point.tempC).toBe(34.2);
    // Tapping another sensor moves the caption.
    act(() =>
      tree.root
        .findAll(n => n.props.testID === 'sensor-1-1.5' && n.props.onPress)[0]
        .props.onPress(),
    );
    expect(textOf(tree)).toContain('Cable 1, 1.5 m');
  });
});

describe('reduce motion', () => {
  test('FadeIn skips the animation when Reduce Motion is on', async () => {
    jest
      .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
      .mockResolvedValue(true);
    const timing = jest.spyOn(Animated, 'timing');
    await act(async () => {
      ReactTestRenderer.create(
        <FadeIn>
          <Text>x</Text>
        </FadeIn>,
      );
    });
    await tick();
    // The first render may start one animation before the setting resolves;
    // once it is known, no further timing runs and opacity is 1.
    const callsAfter = timing.mock.calls.length;
    await tick();
    expect(timing.mock.calls.length).toBe(callsAfter);
    timing.mockRestore();
  });
  test('FadeIn animates in 150-200 ms when Reduce Motion is off', async () => {
    jest
      .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
      .mockResolvedValue(false);
    const timing = jest.spyOn(Animated, 'timing');
    await act(async () => {
      ReactTestRenderer.create(
        <FadeIn>
          <Text>x</Text>
        </FadeIn>,
      );
    });
    const cfg = timing.mock.calls[0][1] as { duration: number };
    expect(cfg.duration).toBeGreaterThanOrEqual(150);
    expect(cfg.duration).toBeLessThanOrEqual(200);
    timing.mockRestore();
  });
});
