// Prints and asserts the accessibility label of every interactive or grouped
// element on each screen (what VoiceOver would announce). Run with
// `npx jest a11y-labels --verbose` to see the list.
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import type { SecureStore } from '@greenguard/mobile-core';
import { AppRoot } from '../src/AppRoot';
import { createDemoServices } from '../src/demo/demoServices';

const store = (): SecureStore => {
  const m = new Map<string, string>();
  return {
    getItem: async k => m.get(k) ?? null,
    setItem: async (k, v) => void m.set(k, v),
    removeItem: async k => void m.delete(k),
  };
};
const settle = async () => {
  for (let i = 0; i < 8; i++)
    await act(async () => {
      await new Promise(r => setTimeout(() => r(undefined), 0));
    });
};
const labels = (tree: ReactTestRenderer.ReactTestRenderer) =>
  Array.from(
    new Set(
      tree.root
        .findAll(
          n =>
            typeof n.type === 'string' &&
            (n.props.accessibilityLabel || n.props.accessibilityRole) &&
            n.props.accessibilityElementsHidden !== true,
        )
        .map(
          n =>
            `${n.props.accessibilityRole ?? 'element'}: ${
              n.props.accessibilityLabel ?? '(text content)'
            }`,
        ),
    ),
  );

test('every screen exposes labelled controls; list rows are one phrase', async () => {
  const services = createDemoServices({ queueStorage: store() });
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(<AppRoot services={services} />);
  });
  await settle();
  const press = async (id: string) => {
    await act(async () =>
      tree.root
        .findAll(n => n.props.testID === id && n.props.onPress)[0]
        .props.onPress(),
    );
    await settle();
  };
  const dump: Record<string, string[]> = {};
  dump.list = labels(tree);
  await press('alert-row-a-1001');
  dump.detail = labels(tree);
  await press('ack-button');
  dump.confirmation = labels(tree);
  await press('back-to-alerts');
  await press('queue-button');
  dump.queue = labels(tree);
  console.log(JSON.stringify(dump, null, 2));
  expect(dump.list).toContain('tab: Open, 3');
  expect(
    dump.list.some(l =>
      l.startsWith(
        'button: High, Bin 7 (wheat), North Elevator, Moisture 16.8%, limit 14, open',
      ),
    ),
  ).toBe(true);
  expect(dump.detail).toContain('button: Acknowledge');
  expect(dump.detail).toContain('button: Back to alerts');
  expect(dump.confirmation).toContain('button: Back to alerts');
  expect(dump.queue.some(l => l.startsWith('button: Sync now'))).toBe(true);
});
