import React, { useMemo } from 'react';
import { FlatList, View } from 'react-native';
import type { AlertView, QueuedAck } from '@greenguard/mobile-core';
import {
  AlertRow,
  EmptyState,
  ErrorState,
  ListSkeleton,
  Segmented,
  SectionHeader,
  acknowledgedAlerts,
  needsAttention,
  rowState,
  useTheme,
} from '../ui';
import type { AlertFilter } from '../ui';

type Item =
  | { kind: 'header'; key: string; title: string; count: number }
  | { kind: 'row'; key: string; alert: AlertView; last: boolean };

const EMPTY: Record<AlertFilter, { title: string; body: string }> = {
  open: {
    title: 'No open alerts',
    body: 'Bins are within limits. New alerts appear here.',
  },
  acknowledged: {
    title: 'No acknowledged alerts',
    body: 'Alerts you acknowledge appear here.',
  },
  all: {
    title: 'No alerts',
    body: 'Bins are within limits. New alerts appear here.',
  },
};

export function AlertListScreen(props: {
  alerts: AlertView[];
  pending: QueuedAck[];
  loading: boolean;
  // False until the first load for this tenant has finished.
  loaded: boolean;
  error: string | null;
  now: number;
  filter: AlertFilter;
  onFilter: (filter: AlertFilter) => void;
  initialOffset?: number;
  onScrollOffset?: (y: number) => void;
  describeBin: (binId: string) => { bin: string; site?: string };
  // More alerts exist than were loaded: counts are shown as "n+".
  hasMore?: boolean;
  readingFor?: (alertId: string) => string | undefined;
  onOpen: (alert: AlertView) => void;
  onRefresh: () => void;
  footer?: React.ReactNode;
}) {
  const { c } = useTheme();
  const pendingIds = useMemo(
    () =>
      new Set(props.pending.filter(p => !p.rejectedReason).map(p => p.alertId)),
    [props.pending],
  );
  const { needs, done } = useMemo(
    () => ({
      needs: needsAttention(props.alerts, pendingIds),
      done: acknowledgedAlerts(props.alerts, pendingIds),
    }),
    [props.alerts, pendingIds],
  );

  const items = useMemo(() => {
    const list: Item[] = [];
    const add = (title: string | null, group: AlertView[]) => {
      if (title && group.length > 0)
        list.push({
          kind: 'header',
          key: `h-${title}`,
          title,
          count: group.length,
        });
      group.forEach((alert, i) =>
        list.push({
          kind: 'row',
          key: alert.alertId,
          alert,
          last: i === group.length - 1,
        }),
      );
    };
    if (props.filter === 'open') add(null, needs);
    else if (props.filter === 'acknowledged') add(null, done);
    else {
      add('Needs attention', needs);
      add('Acknowledged', done);
    }
    return list;
  }, [props.filter, needs, done]);

  const showSkeleton =
    !props.loaded && props.alerts.length === 0 && !props.error;
  const showError = props.alerts.length === 0 && !!props.error;
  const empty = EMPTY[props.filter];
  const plus = props.hasMore ? '+' : '';

  return (
    <FlatList
      testID="alert-list"
      data={props.loaded || props.alerts.length > 0 ? items : []}
      keyExtractor={item => item.key}
      refreshing={props.loading && props.loaded}
      onRefresh={props.onRefresh}
      contentOffset={{ x: 0, y: props.initialOffset ?? 0 }}
      onScroll={e => props.onScrollOffset?.(e.nativeEvent.contentOffset.y)}
      scrollEventThrottle={64}
      ListHeaderComponent={
        props.alerts.length > 0 ? (
          <View
            style={{
              padding: 16,
              backgroundColor: c.bg,
              borderBottomWidth: 1,
              borderColor: c.line,
            }}
          >
            <Segmented
              value={props.filter}
              onChange={props.onFilter}
              segments={[
                { key: 'open', label: 'Open', count: `${needs.length}${plus}` },
                {
                  key: 'acknowledged',
                  label: 'Acknowledged',
                  count: done.length,
                },
                {
                  key: 'all',
                  label: 'All',
                  count: `${props.alerts.length}${plus}`,
                },
              ]}
            />
          </View>
        ) : undefined
      }
      ListEmptyComponent={
        showSkeleton ? (
          <ListSkeleton />
        ) : showError ? (
          <ErrorState
            testID="alert-list-empty"
            title="Could not load alerts"
            body={props.error ?? ''}
            onRetry={props.onRefresh}
          />
        ) : props.loaded ? (
          <EmptyState
            testID="alert-list-empty"
            title={empty.title}
            body={empty.body}
          />
        ) : undefined
      }
      ListFooterComponent={<View>{props.footer}</View>}
      renderItem={({ item }) =>
        item.kind === 'header' ? (
          <SectionHeader title={item.title} count={item.count} />
        ) : (
          <AlertRow
            alert={item.alert}
            where={props.describeBin(item.alert.binId)}
            pending={
              rowState(item.alert, pendingIds.has(item.alert.alertId)) ===
              'unsent'
            }
            reading={props.readingFor?.(item.alert.alertId)}
            now={props.now}
            last={item.last}
            onPress={() => props.onOpen(item.alert)}
          />
        )
      }
    />
  );
}
