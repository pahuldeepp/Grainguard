import React, { useEffect } from 'react';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import type { AlertView, QueuedAck } from '@greenguard/mobile-core';
import type { AlertReadings, TimelineEntry } from '../ui';
import {
  BackButton,
  BinProfile,
  Button,
  EdgeSwipeBack,
  Glyph,
  ReadingTiles,
  SectionHeader,
  SeverityMarker,
  StatusLine,
  Timeline,
  Txt,
  TrendBars,
  announce,
  binTitle,
  buildTimeline,
  formatScore,
  timeAgo,
  ruleLabel,
  severityKey,
  titleCase,
  useTheme,
} from '../ui';

export function AlertDetailScreen(props: {
  alert: AlertView;
  pending: QueuedAck | undefined;
  now: number;
  online: boolean;
  where: { bin: string; site?: string };
  busy?: boolean;
  // Result of the last acknowledge tap, announced to screen readers.
  feedback?: string | null;
  // Present only when another alert still needs an acknowledgement.
  onNext?: () => void;
  // Demo fixtures. Live mode has neither yet (see MOBILE_DATA_AVAILABILITY.md).
  readings?: AlertReadings;
  timeline?: TimelineEntry[];
  demo?: boolean;
  // Session subject, to tell "by you" from another operator.
  you?: string;
  onAcknowledge: () => void;
  onBack: () => void;
}) {
  const { c } = useTheme();
  const stacked = useWindowDimensions().fontScale > 1.25;
  const { alert } = props;
  const acknowledged =
    alert.state === 'acknowledged' || alert.state === 'resolved';
  const open = !acknowledged && !props.pending;
  useEffect(() => {
    if (props.feedback) announce(props.feedback);
  }, [props.feedback]);

  const fact = (
    label: string,
    value: string,
    first?: boolean,
    big?: boolean,
  ) => (
    <View
      accessible
      accessibilityLabel={`${label}, ${value}`}
      style={{
        flexGrow: 1,
        flexBasis: stacked ? '100%' : 84,
        paddingVertical: 10,
        paddingHorizontal: 16,
        borderLeftWidth: first || stacked ? 0 : 1,
        borderTopWidth: !first && stacked ? 1 : 0,
        borderColor: c.line,
      }}
    >
      <Txt variant="meta" muted>
        {label}
      </Txt>
      <Txt
        variant={big ? 'data' : 'rowTitle'}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.85}
      >
        {value}
      </Txt>
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 12 }}>
        <BackButton onPress={props.onBack} />
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        <View style={{ paddingHorizontal: 16, paddingBottom: 12, gap: 6 }}>
          <SeverityMarker
            kind={acknowledged ? 'acknowledged' : severityKey(alert.severity)}
            variant="body"
          />
          <Txt variant="title" accessibilityRole="header">
            {binTitle(props.where.bin, alert.binId)}
          </Txt>
          <Txt muted>{props.where.site ?? ruleLabel(alert.ruleId)}</Txt>
        </View>
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            backgroundColor: c.surface,
            borderTopWidth: 1,
            borderBottomWidth: 1,
            borderColor: c.line,
          }}
        >
          {fact('Risk score', formatScore(alert.score), true, true)}
          {fact('Opened', timeAgo(alert.openedAt, props.now))}
          {fact('State', props.pending ? 'Unsent' : titleCase(alert.state))}
          {alert.escalationLevel > 0
            ? fact('Escalation', `Level ${alert.escalationLevel}`)
            : null}
        </View>

        {props.readings ? (
          <View>
            <SectionHeader title="Readings (demo)" />
            <ReadingTiles readings={props.readings} />
            <View style={{ height: 16 }} />
            <TrendBars readings={props.readings} />
            {props.readings.bin ? (
              <BinProfile bin={props.readings.bin} />
            ) : null}
          </View>
        ) : (
          <View
            testID="readings-unavailable"
            accessible
            style={{ paddingHorizontal: 16, paddingTop: 20, gap: 4 }}
          >
            <Txt variant="rowTitle">Readings</Txt>
            <Txt muted>
              Readings, limits and sensor positions are not available in this
              view yet.
            </Txt>
          </View>
        )}

        <Timeline
          entries={props.timeline ?? buildTimeline(alert, props.you)}
          now={props.now}
          demo={!!props.timeline}
        />
        {props.pending ? (
          <View style={{ marginTop: 16 }}>
            <StatusLine
              testID="detail-pending"
              kind={props.pending.rejectedReason ? 'stale' : 'offline'}
              text={
                props.pending.rejectedReason
                  ? `Acknowledgement rejected: ${props.pending.rejectedReason}`
                  : 'Acknowledgement queued. It will send when you are online.'
              }
            />
          </View>
        ) : null}
      </ScrollView>
      {!open ? (
        <View
          testID="detail-actions"
          style={{
            padding: 16,
            gap: 8,
            backgroundColor: c.surface,
            borderTopWidth: 1,
            borderColor: c.line,
          }}
        >
          {props.feedback && !props.pending ? (
            <View
              testID="detail-feedback"
              accessibilityLiveRegion="polite"
              style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
            >
              <Glyph kind="acknowledged" size={26} />
              <Txt variant="section" color={c.ok}>
                {props.feedback}
              </Txt>
            </View>
          ) : null}
          {props.onNext ? (
            <Button
              testID="next-alert"
              label="Next open alert"
              hint="Opens the most urgent alert that still needs acknowledging"
              onPress={props.onNext}
            />
          ) : null}
          <Button
            testID="back-to-alerts"
            label="Back to alerts"
            variant={props.onNext ? 'secondary' : 'primary'}
            onPress={props.onBack}
          />
        </View>
      ) : (
        <View
          style={{
            padding: 16,
            gap: 8,
            backgroundColor: c.surface,
            borderTopWidth: 1,
            borderColor: c.line,
          }}
        >
          {!props.online ? (
            <Txt variant="meta" muted>
              You are offline. This will send when you reconnect.
            </Txt>
          ) : null}
          <Button
            testID="ack-button"
            label="Acknowledge"
            busyLabel="Acknowledging"
            busy={props.busy}
            hint={
              props.online
                ? 'Sends the acknowledgement now'
                : 'Saves the acknowledgement to send later'
            }
            onPress={props.onAcknowledge}
          />
        </View>
      )}
      <EdgeSwipeBack onBack={props.onBack} />
    </View>
  );
}
