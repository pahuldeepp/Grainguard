import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';
import type { SecureStore } from '@greenguard/mobile-core';
import { AppRoot } from '../src/AppRoot';
import { createDemoServices } from '../src/demo/demoServices';
import type { AppServices } from '../src/services/types';

function memoryStore(): SecureStore {
  const map = new Map<string, string>();
  return {
    getItem: async key => map.get(key) ?? null,
    setItem: async (key, value) => void map.set(key, value),
    removeItem: async key => void map.delete(key),
  };
}

const settle = async () => {
  for (let i = 0; i < 8; i++)
    await act(async () => {
      await new Promise(resolve => setTimeout(() => resolve(undefined), 0));
    });
};

async function mount(services: AppServices) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(<AppRoot services={services} />);
  });
  await settle();
  const root = tree.root;
  const text = () =>
    root
      .findAllByType(Text)
      .map(node => [node.props.children].flat(3).join(''))
      .join(' | ')
      .replace(/\u2011/g, '-');
  const press = async (testID: string) => {
    const node = root.findAll(
      n => n.props.testID === testID && n.props.onPress,
    )[0];
    await act(async () => {
      node.props.onPress();
    });
    await settle();
  };
  const has = (testID: string) =>
    root.findAll(n => n.props.testID === testID).length > 0;
  return { tree, text, press, has };
}

function demo() {
  return createDemoServices({ queueStorage: memoryStore() });
}

test('a failed cold-start OAuth callback is visible and sign-in can be retried', async () => {
  const services = demo();
  const identity = services.session.identity.bind(services.session);
  services.session.identity = jest.fn()
    .mockRejectedValueOnce(new Error('Sign-in callback expired. Try again.'))
    .mockImplementation(identity);
  const app = await mount(services);
  expect(app.text()).toContain('Sign-in callback expired. Try again.');
  await app.press('signin-button');
  expect(await services.session.identity()).not.toBeNull();
});

test('alert list renders severity, bin, site and state, labelled as demo data', async () => {
  const app = await mount(demo());
  const text = app.text();
  expect(text).toContain('Prairie Grain Co-op');
  expect(text).toContain('Critical');
  expect(text).toContain('Bin 14 (corn)');
  expect(text).toContain('North Elevator');
  expect(text).toContain('Open');
  expect(text).toContain('Acknowledged');
  expect(text).toContain('Demo data');
  expect(app.has('demo-banner')).toBe(true);
});

test('acknowledging while offline queues the command and shows pending', async () => {
  const services = demo();
  const app = await mount(services);
  await act(async () => services.simulateOffline?.(true));
  await settle();
  expect(app.has('offline-banner')).toBe(true);

  await app.press('alert-row-a-1001');
  await app.press('ack-button');

  const id = (await services.session.identity())!;
  const queued = await services.queue.pending(id);
  expect(queued).toHaveLength(1);
  expect(queued[0].alertId).toBe('a-1001');
  expect(app.text()).toContain('Acknowledgement queued');
  expect(app.text()).toContain('1 acknowledgement will send');
  expect(app.text()).toContain('Unsent');
  // Not acknowledged on the (demo) server yet.
  expect(await services.alerts.detail('a-1001').catch(() => null)).toBeNull();
});

test('going back online drains the queue and the alert becomes acknowledged', async () => {
  const services = demo();
  const app = await mount(services);
  await act(async () => services.simulateOffline?.(true));
  await app.press('alert-row-a-1001');
  await app.press('ack-button');
  await act(async () => services.simulateOffline?.(false));
  await settle();

  const id = (await services.session.identity())!;
  expect(await services.queue.pending(id)).toHaveLength(0);
  const detail = await services.alerts.detail('a-1001');
  expect(detail?.state).toBe('acknowledged');
  expect(app.has('offline-banner')).toBe(false);
  expect(app.text()).not.toContain('Unsent');
});

test('switching tenant clears the previous tenant list', async () => {
  const app = await mount(demo());
  expect(app.has('alert-row-a-1001')).toBe(true);
  await app.press('switch-tenant');
  expect(app.has('alert-row-a-1001')).toBe(false);
  expect(app.has('alert-row-b-2001')).toBe(true);
  expect(app.text()).toContain('Riverbend Storage');
  expect(app.text()).not.toContain('Prairie Grain Co-op');
});

test('sign-out shows sign-in and signing in returns to the list', async () => {
  const app = await mount(demo());
  await app.press('sign-out');
  expect(app.has('signin-button')).toBe(true);
  expect(app.has('alert-list')).toBe(false);
  await app.press('signin-button');
  expect(app.has('alert-list')).toBe(true);
});

describe('live/demo choice on the sign-in screen', () => {
  const liveLike = (overrides: Partial<AppServices['session']> = {}) => {
    const base = demo();
    const services: AppServices = {
      ...base,
      mode: 'live',
      session: {
        identity: async () => null,
        signIn: async () => undefined,
        signOut: async () => undefined,
        switchTenant: async () => undefined,
        ...overrides,
      },
    };
    return services;
  };

  async function mountWithToggle(services: AppServices) {
    const toggles: string[] = [];
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(
        <AppRoot services={services} onToggleMode={() => toggles.push('t')} />,
      );
    });
    await settle();
    const find = (id: string) =>
      tree.root.findAll(n => n.props.testID === id && n.props.onPress)[0];
    const text = () =>
      tree.root
        .findAllByType(Text)
        .map(node => [node.props.children].flat(3).join(''))
        .join(' | ');
    return { toggles, find, text, tree };
  }

  test('live mode is labelled and offers Demo data as the other choice', async () => {
    const app = await mountWithToggle(liveLike());
    expect(app.text()).toContain('Sign in with browser');
    expect(app.text()).not.toContain('Demo data: fictional');
    await act(async () => app.find('mode-live').props.onPress());
    expect(app.toggles).toHaveLength(0); // already live
    await act(async () => app.find('mode-demo').props.onPress());
    expect(app.toggles).toHaveLength(1);
  });

  test('release builds (no toggle) show no demo choice', async () => {
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(<AppRoot services={liveLike()} />);
    });
    await settle();
    expect(tree.root.findAll(n => n.props.testID === 'mode-demo')).toHaveLength(
      0,
    );
  });

  test('a failed live sign-in shows the error and re-enables the button', async () => {
    const app = await mountWithToggle(
      liveLike({
        signIn: async () => {
          throw new Error('Authorization state mismatch');
        },
      }),
    );
    await act(async () => {
      app.find('signin-button').props.onPress();
    });
    await settle();
    expect(app.text()).toContain('Authorization state mismatch');
    expect(app.find('signin-button').props.disabled).toBeFalsy();
  });

  test('while waiting for the browser the button is busy and Cancel abandons it', async () => {
    let rejectSignIn!: (e: Error) => void;
    const cancelled: string[] = [];
    const app = await mountWithToggle(
      liveLike({
        signIn: () =>
          new Promise<void>((_, reject) => {
            rejectSignIn = reject;
          }),
        cancelSignIn: () => {
          cancelled.push('c');
          rejectSignIn(new Error('Sign-in cancelled'));
        },
      }),
    );
    await act(async () => {
      app.tree.root
        .findAll(n => n.props.testID === 'signin-button')[0]
        .props.onPress();
    });
    expect(app.text()).toContain('Waiting for browser sign-in');
    await act(async () => app.find('signin-cancel').props.onPress());
    await settle();
    expect(cancelled).toEqual(['c']);
    expect(app.text()).toContain('Sign-in cancelled');
  });
});

describe('acknowledge, back and next flow', () => {
  test('list defaults to Open; Acknowledged is one tap away; filter survives a detail visit', async () => {
    const app = await mount(demo());
    expect(app.has('alert-row-a-1001')).toBe(true);
    expect(app.has('alert-row-a-1004')).toBe(false);
    await app.press('filter-acknowledged');
    expect(app.has('alert-row-a-1004')).toBe(true);
    expect(app.has('alert-row-a-1001')).toBe(false);
    await app.press('alert-row-a-1004');
    await app.press('back-button');
    expect(app.has('alert-row-a-1004')).toBe(true); // still on Acknowledged
  });

  test('after Acknowledge: confirmation, Next open alert and Back to alerts', async () => {
    const app = await mount(demo());
    await app.press('alert-row-a-1001');
    await app.press('ack-button');
    expect(app.text()).toContain('Acknowledged.');
    expect(app.has('ack-button')).toBe(false);
    expect(app.has('next-alert')).toBe(true);
    expect(app.has('back-to-alerts')).toBe(true);
    await app.press('next-alert');
    expect(app.text()).toContain('Bin 7 (wheat)'); // next most urgent open alert
    expect(app.has('ack-button')).toBe(true); // it still needs acknowledging
    expect(app.has('detail-feedback')).toBe(false); // no stale confirmation
    expect(app.has('next-alert')).toBe(false);
    await app.press('back-button'); // a-1002 is still open: plain Back
    expect(app.has('alert-list')).toBe(true);
    expect(app.has('alert-row-a-1001')).toBe(false); // acknowledged leaves Open
  });

  test('the last open alert offers only Back to alerts', async () => {
    const app = await mount(demo());
    for (const id of ['a-1001', 'a-1002', 'a-1003']) {
      await app.press(`alert-row-${id}`);
      await app.press('ack-button');
      if (id !== 'a-1003') await app.press('back-to-alerts');
    }
    expect(app.has('next-alert')).toBe(false);
    expect(app.has('back-to-alerts')).toBe(true);
    await app.press('back-to-alerts');
    expect(app.text()).toContain('No open alerts');
  });

  test('demo history is labelled demo; live detail derives it from alert fields', async () => {
    const app = await mount(demo());
    await app.press('alert-row-a-1001');
    expect(app.text()).toContain('History (demo)');
    expect(app.text()).toContain('Escalated to level 1');
    await app.press('back-button');
    await app.press('alert-row-a-1003');
    expect(app.text()).toContain('History');
    expect(app.text()).not.toContain('History (demo)');
  });
});
