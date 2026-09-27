import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';
import type { AlertView, QueuedAck } from '@greenguard/mobile-core';
import { AlertListScreen } from '../src/screens/AlertListScreen';
import { AlertDetailScreen } from '../src/screens/AlertDetailScreen';
import { QueueScreen } from '../src/screens/QueueScreen';
import {
  Button,
  buildTimeline,
  nextOpenAlert,
  SeverityMarker,
  StatusBanner,
  TextField,
  binTitle,
  ruleLabel,
  severityKey,
  severityRank,
} from '../src/ui';
import { palette } from '../src/ui/theme/tokens';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const mk = (over: Partial<AlertView>): AlertView => ({
  alertId: 'a',
  ruleId: 'grain-temp-hotspot',
  binId: 'bin',
  state: 'open',
  severity: 'low',
  score: 0.5,
  version: '1',
  openedAt: new Date(NOW - 5 * 60_000).toISOString(),
  acknowledgedAt: null,
  escalationLevel: 0,
  ...over,
});

function render(el: React.ReactElement) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(el);
  });
  const text = () =>
    tree.root
      .findAllByType(Text)
      .map(n => [n.props.children].flat(3).join(''))
      .join(' | ');
  return { tree, text };
}

describe('severity mapping', () => {
  test('maps backend levels to design words and orders by urgency', () => {
    expect(severityKey('critical')).toBe('critical');
    expect(severityKey('medium')).toBe('warning');
    expect(severityKey('low')).toBe('notice');
    expect(severityKey('whatever')).toBe('notice');
    expect(severityRank('critical')).toBeLessThan(severityRank('high'));
    expect(severityRank('high')).toBeLessThan(severityRank('medium'));
  });
  test('every marker shows its word and is labelled with it', () => {
    for (const [kind, word] of [
      ['critical', 'Critical'],
      ['high', 'High'],
      ['warning', 'Warning'],
      ['notice', 'Notice'],
      ['acknowledged', 'Acknowledged'],
      ['unsent', 'Unsent'],
    ] as const) {
      const app = render(<SeverityMarker kind={kind} />);
      expect(app.text()).toContain(word);
      expect(
        app.tree.root.findAll(n => n.props.accessibilityLabel === word).length,
      ).toBeGreaterThan(0);
    }
  });
});

describe('readable titles', () => {
  test('raw UUID titles fall back to a short id, other names are untouched', () => {
    const id = '3f9a2c1d-1111-4222-8333-444455556666';
    expect(binTitle(id, id)).toBe('Bin 3f9a');
    expect(binTitle('Bin 14 (corn)', 'x')).toBe('Bin 14 (corn)');
    expect(ruleLabel('co2-elevated')).toBe('CO2 elevated');
  });
});

describe('Button', () => {
  test('busy keeps a spoken label, is not pressable and reports state', () => {
    const onPress = jest.fn();
    const app = render(
      <Button
        label="Acknowledge"
        busyLabel="Acknowledging"
        busy
        onPress={onPress}
      />,
    );
    const node = app.tree.root.findAll(
      n => n.props.accessibilityRole === 'button' && n.props.accessibilityLabel,
    )[0];
    expect(node.props.accessibilityLabel).toBe('Acknowledging');
    expect(node.props.accessibilityState).toEqual({
      disabled: false,
      busy: true,
    });
    expect(node.props.disabled).toBe(true);
  });
  test('disabled reports state and idle button is at least 44 high', () => {
    const app = render(<Button label="Sync now" disabled onPress={() => {}} />);
    const node = app.tree.root.findAll(
      n => n.props.accessibilityRole === 'button',
    )[0];
    expect(node.props.accessibilityState.disabled).toBe(true);
    const style = node.props.style({ pressed: false });
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
  });
});

test('TextField exposes label and shows an error with a word, not colour alone', () => {
  const app = render(<TextField label="Email" error="Enter a valid address" />);
  expect(app.text()).toContain('Email');
  expect(app.text()).toContain('Error: Enter a valid address');
});

test('StatusBanner is an alert with the text as its label', () => {
  const app = render(
    <StatusBanner
      kind="offline"
      text="Offline. 2 acknowledgements will send when you reconnect."
    />,
  );
  const alert = app.tree.root.findAll(
    n => n.props.accessibilityRole === 'alert',
  )[0];
  expect(alert.props.accessibilityLabel).toContain('Offline.');
});

describe('AlertListScreen', () => {
  const base = {
    pending: [] as QueuedAck[],
    loading: false,
    loaded: true,
    error: null,
    now: NOW,
    filter: 'all' as const,
    onFilter: () => {},
    describeBin: (id: string) => ({ bin: id }),
    onOpen: () => {},
    onRefresh: () => {},
  };
  test('needs attention comes first, most severe first, acknowledged last', () => {
    const alerts = [
      mk({
        alertId: 'old',
        binId: 'B-ack',
        state: 'acknowledged',
        severity: 'critical',
      }),
      mk({ alertId: 'n', binId: 'B-notice', severity: 'low' }),
      mk({ alertId: 'c', binId: 'B-crit', severity: 'critical' }),
    ];
    const t = render(<AlertListScreen {...base} alerts={alerts} />).text();
    expect(t.indexOf('Needs attention')).toBeLessThan(t.indexOf('B-crit'));
    expect(t.indexOf('B-crit')).toBeLessThan(t.indexOf('B-notice'));
    expect(t.indexOf('B-notice')).toBeLessThan(t.indexOf('B-ack'));
  });
  test('row is one phrase for screen readers', () => {
    const app = render(
      <AlertListScreen
        {...base}
        alerts={[mk({ alertId: 'c', severity: 'critical', binId: 'bin-1' })]}
        describeBin={() => ({ bin: 'Bin 14 corn', site: 'North Elevator' })}
      />,
    );
    const row = app.tree.root.findAll(
      n => n.props.testID === 'alert-row-c' && n.props.accessibilityLabel,
    )[0];
    expect(row.props.accessibilityLabel).toBe(
      'Critical, Bin 14 corn, North Elevator, open, 5 minutes ago',
    );
  });
  test('loading shows skeleton, empty says what is normal, error offers retry', () => {
    expect(
      render(
        <AlertListScreen {...base} loaded={false} alerts={[]} />,
      ).tree.root.findAll(n => n.props.testID === 'list-skeleton').length,
    ).toBeGreaterThan(0);
    expect(render(<AlertListScreen {...base} alerts={[]} />).text()).toContain(
      'Bins are within limits',
    );
    const onRefresh = jest.fn();
    const err = render(
      <AlertListScreen
        {...base}
        alerts={[]}
        error="Network unavailable"
        onRefresh={onRefresh}
      />,
    );
    expect(err.text()).toContain('Could not load alerts');
    act(() =>
      err.tree.root
        .findAll(n => n.props.testID === 'error-retry' && n.props.onPress)[0]
        .props.onPress(),
    );
    expect(onRefresh).toHaveBeenCalled();
  });
});

test('AlertDetailScreen: acknowledge is the one action, busy disables it, offline is explained', () => {
  const onAck = jest.fn();
  const app = render(
    <AlertDetailScreen
      alert={mk({ severity: 'critical' })}
      pending={undefined}
      now={NOW}
      online={false}
      where={{ bin: 'Bin 14' }}
      busy
      onAcknowledge={onAck}
      onBack={() => {}}
    />,
  );
  expect(app.text()).toContain(
    'You are offline. This will send when you reconnect.',
  );
  const btn = app.tree.root
    .findAll(n => n.props.testID === 'ack-button' && n.props.onPress)
    .pop()!;
  expect(btn.props.disabled).toBe(true);
  expect(btn.props.accessibilityLabel).toBe('Acknowledging');
});

test('QueueScreen shows per-item state, reason and dismiss for rejected items', () => {
  const entries: QueuedAck[] = [
    {
      idempotencyKey: 'k1',
      alertId: 'a-1',
      version: '1',
      enqueuedAt: NOW - 60_000,
      attempts: 0,
      nextAttemptAt: 0,
    },
    {
      idempotencyKey: 'k2',
      alertId: 'a-2',
      version: '1',
      enqueuedAt: NOW - 60_000,
      attempts: 3,
      nextAttemptAt: 0,
      rejectedReason: 'forbidden',
    },
  ];
  const onDismiss = jest.fn();
  const app = render(
    <QueueScreen
      entries={entries}
      now={NOW}
      online={false}
      describe={id => `Bin ${id}`}
      onRetry={() => {}}
      onDismiss={onDismiss}
      onBack={() => {}}
    />,
  );
  const t = app.text();
  expect(t).toContain('Waiting for connection');
  expect(t).toContain('Rejected');
  expect(t).toContain('forbidden');
  expect(t).toContain('1 unsent, 1 rejected');
  const sync = app.tree.root.findAll(
    n => n.props.testID === 'queue-retry' && n.props.onPress,
  )[0];
  expect(sync.props.disabled).toBe(true);
  act(() =>
    app.tree.root
      .findAll(
        n =>
          n.props.accessibilityLabel?.startsWith('Dismiss rejected') &&
          n.props.onPress,
      )[0]
      .props.onPress(),
  );
  expect(onDismiss).toHaveBeenCalledWith(entries[1]);
});

test('design tokens match docs/DESIGN_SYSTEM.md for a sample of values', () => {
  expect(palette.light.brand).toBe('#0B5D36');
  expect(palette.dark.critical).toBe('#FF8A80');
  expect(palette.light.offline).toBe('#5B4B8A');
});

describe('timeline uses only fields the alert queries return', () => {
  test('opened, escalated (no invented time), acknowledged with actor', () => {
    const t = buildTimeline(
      mk({
        escalationLevel: 2,
        state: 'acknowledged',
        acknowledgedAt: new Date(NOW).toISOString(),
        acknowledgedBy: 'sam',
      }),
    );
    expect(t.map(e => e.label)).toEqual([
      'Opened',
      'Escalated to level 2',
      'Acknowledged',
    ]);
    expect(t[1].when).toBeUndefined();
    expect(t[1].note).toBe('Time not available yet');
    expect(t[2].detail).toBe('by another operator');
  });
  test('resolved has no invented time', () => {
    const t = buildTimeline(mk({ state: 'resolved' }));
    expect(t[t.length - 1]).toEqual({
      label: 'Resolved',
      note: 'Time not available yet',
    });
  });
});

test('nextOpenAlert skips the current alert and unsent ones, most urgent first', () => {
  const alerts = [
    mk({ alertId: 'cur', severity: 'critical' }),
    mk({ alertId: 'unsent', severity: 'high' }),
    mk({ alertId: 'low', severity: 'low' }),
    mk({ alertId: 'med', severity: 'medium' }),
    mk({ alertId: 'done', state: 'acknowledged', severity: 'critical' }),
  ];
  expect(nextOpenAlert(alerts, new Set(['unsent']), 'cur')?.alertId).toBe(
    'med',
  );
  expect(nextOpenAlert([alerts[0]], new Set(), 'cur')).toBeUndefined();
});

describe('filters', () => {
  const props = {
    pending: [] as QueuedAck[],
    loading: false,
    loaded: true,
    error: null,
    now: NOW,
    describeBin: (id: string) => ({ bin: id }),
    onOpen: () => {},
    onRefresh: () => {},
    onFilter: () => {},
  };
  const alerts = [
    mk({ alertId: 'o', binId: 'B-open' }),
    mk({ alertId: 'd', binId: 'B-done', state: 'acknowledged' }),
  ];
  test('Open shows only open alerts, with counts on every segment', () => {
    const app = render(
      <AlertListScreen {...props} alerts={alerts} filter="open" />,
    );
    expect(app.text()).toContain('B-open');
    expect(app.text()).not.toContain('B-done');
    const seg = app.tree.root.findAll(
      n => n.props.accessibilityRole === 'tab' && typeof n.type === 'string',
    );
    expect(seg.map(n => n.props.accessibilityLabel)).toEqual([
      'Open, 1',
      'Acknowledged, 1',
      'All, 2',
    ]);
    expect(seg[0].props.accessibilityState.selected).toBe(true);
  });
  test('Acknowledged shows only acknowledged alerts', () => {
    const t = render(
      <AlertListScreen {...props} alerts={alerts} filter="acknowledged" />,
    ).text();
    expect(t).toContain('B-done');
    expect(t).not.toContain('B-open');
  });
  test('each filter has its own empty state', () => {
    const only = [mk({ alertId: 'o' })];
    expect(
      render(
        <AlertListScreen {...props} alerts={only} filter="acknowledged" />,
      ).text(),
    ).toContain('No acknowledged alerts');
    expect(
      render(
        <AlertListScreen
          {...props}
          alerts={[mk({ state: 'acknowledged' })]}
          filter="open"
        />,
      ).text(),
    ).toContain('No open alerts');
  });
  test('selecting a segment reports the filter', () => {
    const onFilter = jest.fn();
    const app = render(
      <AlertListScreen
        {...props}
        alerts={alerts}
        filter="open"
        onFilter={onFilter}
      />,
    );
    act(() =>
      app.tree.root
        .findAll(n => n.props.testID === 'filter-all' && n.props.onPress)[0]
        .props.onPress(),
    );
    expect(onFilter).toHaveBeenCalledWith('all');
  });
});
