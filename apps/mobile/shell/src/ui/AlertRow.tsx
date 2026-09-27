import React from 'react';
import { Pressable, View } from 'react-native';
import type { AlertView } from '@greenguard/mobile-core';
import { Glyph, SeverityMarker } from './SeverityMarker';
import {
  MARKER_WORD,
  MIN_TARGET,
  markerColor,
  severityKey,
  useTheme,
} from './theme';
import { Txt } from './Txt';
import { binTitle, longTimeAgo, ruleLabel, timeAgo, titleCase } from './format';

export type RowState = 'open' | 'unsent' | 'acknowledged';

export function rowState(alert: AlertView, pending: boolean): RowState {
  if (pending) return 'unsent';
  return alert.state === 'acknowledged' || alert.state === 'resolved'
    ? 'acknowledged'
    : 'open';
}

export function AlertRow(props: {
  alert: AlertView;
  where: { bin: string; site?: string };
  pending: boolean;
  // The reading that triggered the alert (demo fixtures only today).
  reading?: string;
  now: number;
  onPress: () => void;
  last?: boolean;
}) {
  const { c } = useTheme();
  const { alert } = props;
  const state = rowState(alert, props.pending);
  const stateWord =
    state === 'unsent'
      ? 'Unsent'
      : state === 'acknowledged'
      ? 'Acknowledged'
      : titleCase(alert.state);
  const title = binTitle(props.where.bin, alert.binId);
  const sev = severityKey(alert.severity);
  const marker = state === 'acknowledged' ? 'acknowledged' : sev;
  const place = props.where.site ? `${title}, ${props.where.site}` : title;
  const label = [
    MARKER_WORD[sev],
    place,
    props.reading,
    stateWord.toLowerCase(),
    longTimeAgo(alert.openedAt, props.now),
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <Pressable
      testID={`alert-row-${alert.alertId}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Opens alert details"
      onPress={props.onPress}
      style={({ pressed }) => ({
        minHeight: MIN_TARGET,
        paddingHorizontal: 16,
        paddingVertical: 10,
        backgroundColor: pressed ? c.surfaceRaised : c.surface,
        borderBottomWidth: props.last ? 0 : 1,
        borderColor: c.line,
        gap: 4,
      })}
    >
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'center',
          columnGap: 12,
        }}
      >
        <SeverityMarker kind={sev} />
        <Txt variant="meta" muted style={{ fontVariant: ['tabular-nums'] }}>
          {timeAgo(alert.openedAt, props.now)}
        </Txt>
      </View>
      <Txt variant="rowTitle">{title}</Txt>
      {props.where.site ? (
        <Txt variant="meta" muted>
          {props.where.site}
        </Txt>
      ) : null}
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'center',
          columnGap: 12,
        }}
      >
        <Txt
          variant="body"
          color={props.reading ? c.text : c.textMuted}
          style={{
            flexShrink: 1,
            fontWeight: props.reading ? '600' : '400',
            fontVariant: ['tabular-nums'],
          }}
        >
          {props.reading ?? ruleLabel(alert.ruleId)}
        </Txt>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {state !== 'open' ? (
            <Glyph kind={state === 'unsent' ? 'unsent' : marker} size={16} />
          ) : null}
          <Txt
            testID={`alert-state-${alert.alertId}`}
            variant="meta"
            style={{ fontWeight: '600' }}
            color={
              state === 'open'
                ? c.text
                : markerColor(c, state === 'unsent' ? 'unsent' : 'acknowledged')
            }
          >
            {stateWord}
          </Txt>
        </View>
      </View>
    </Pressable>
  );
}
