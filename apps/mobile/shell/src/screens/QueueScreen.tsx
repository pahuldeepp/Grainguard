import React from 'react';
import { ScrollView, View } from 'react-native';
import type { QueuedAck } from '@greenguard/mobile-core';
import {
  Button,
  EmptyState,
  Glyph,
  BackButton,
  EdgeSwipeBack,
  LinkButton,
  SectionHeader,
  Txt,
  markerColor,
  timeAgo,
  useTheme,
} from '../ui';

export function QueueScreen(props: {
  entries: QueuedAck[];
  now: number;
  online: boolean;
  describe: (alertId: string) => string;
  onRetry: () => void;
  onDismiss: (entry: QueuedAck) => void;
  onBack: () => void;
}) {
  const { c } = useTheme();
  const waiting = props.entries.filter(e => !e.rejectedReason);
  const rejected = props.entries.filter(e => e.rejectedReason);
  const cell = (entry: QueuedAck, rejectedRow: boolean) => {
    const name = props.describe(entry.alertId);
    const state = rejectedRow
      ? 'Rejected'
      : entry.attempts > 0
      ? `Retrying, attempt ${entry.attempts + 1}`
      : props.online
      ? 'Sending'
      : 'Waiting for connection';
    const when = `queued ${timeAgo(
      new Date(entry.enqueuedAt).toISOString(),
      props.now,
    )}`;
    return (
      <View
        key={entry.idempotencyKey}
        accessible={!rejectedRow}
        accessibilityLabel={`Acknowledge ${name}, ${state}, ${when}`}
        style={{
          paddingHorizontal: 16,
          paddingVertical: 12,
          gap: 4,
          backgroundColor: c.surface,
          borderBottomWidth: 1,
          borderColor: c.line,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Glyph kind={rejectedRow ? 'critical' : 'unsent'} size={18} />
          <Txt
            variant="meta"
            style={{ fontWeight: '700' }}
            color={markerColor(c, rejectedRow ? 'critical' : 'unsent')}
          >
            {state}
          </Txt>
        </View>
        <Txt variant="rowTitle">{`Acknowledge ${name}`}</Txt>
        <Txt variant="meta" muted>
          {rejectedRow ? entry.rejectedReason ?? '' : when}
        </Txt>
        {rejectedRow ? (
          <View style={{ alignSelf: 'flex-start' }}>
            <LinkButton
              label="Dismiss"
              tone="critical"
              accessibilityLabel={`Dismiss rejected acknowledgement for ${name}`}
              onPress={() => props.onDismiss(entry)}
            />
          </View>
        ) : null}
      </View>
    );
  };
  return (
    <View style={{ flex: 1 }}>
      <EdgeSwipeBack onBack={props.onBack} />
      <View style={{ paddingHorizontal: 16 }}>
        <BackButton onPress={props.onBack} />
      </View>
      <ScrollView>
        <View style={{ paddingHorizontal: 16, gap: 4 }}>
          <Txt variant="title" accessibilityRole="header">
            Sync queue
          </Txt>
          <Txt testID="queue-summary" muted>
            {`${waiting.length} unsent, ${rejected.length} rejected`}
          </Txt>
        </View>
        {props.entries.length === 0 ? (
          <EmptyState
            title="Nothing to send"
            body="Acknowledgements made offline wait here until you reconnect."
          />
        ) : null}
        {waiting.length > 0 ? (
          <SectionHeader title="Unsent" count={waiting.length} />
        ) : null}
        {waiting.map(e => cell(e, false))}
        {rejected.length > 0 ? (
          <SectionHeader title="Rejected" count={rejected.length} />
        ) : null}
        {rejected.map(e => cell(e, true))}
      </ScrollView>
      <View
        style={{
          padding: 16,
          gap: 8,
          backgroundColor: c.surface,
          borderTopWidth: 1,
          borderColor: c.line,
        }}
      >
        {!props.online && waiting.length > 0 ? (
          <Txt variant="meta" muted>
            Offline. Sync is available when you reconnect.
          </Txt>
        ) : null}
        <Button
          testID="queue-retry"
          label="Sync now"
          disabled={!props.online || waiting.length === 0}
          onPress={props.onRetry}
        />
      </View>
    </View>
  );
}
