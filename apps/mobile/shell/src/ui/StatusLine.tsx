import React from 'react';
import { Pressable, View } from 'react-native';
import { Glyph } from './SeverityMarker';
import { FadeIn } from './motion';
import { markerColor, useTheme } from './theme';
import type { MarkerKind } from './theme';
import { Txt } from './Txt';

export type StatusKind = 'offline' | 'stale' | 'demo' | 'error';

const MARKER: Record<StatusKind, MarkerKind> = {
  offline: 'unsent',
  stale: 'warning',
  demo: 'notice',
  error: 'critical',
};

// ONE thin line for connectivity and data-source state: icon plus short text,
// tappable when there is something to do (open the sync queue, retry).
export function StatusLine(props: {
  kind: StatusKind;
  text: string;
  testID?: string;
  actionHint?: string;
  onPress?: () => void;
}) {
  const { c } = useTheme();
  const tone = markerColor(c, MARKER[props.kind]);
  const body = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minHeight: 36,
        paddingHorizontal: 16,
        paddingVertical: 6,
        backgroundColor: c.surface,
        borderTopWidth: 1,
        borderBottomWidth: 1,
        borderColor: c.line,
      }}
    >
      <Glyph kind={MARKER[props.kind]} size={16} />
      <Txt
        variant="meta"
        color={props.kind === 'demo' ? c.text : tone}
        style={{ flex: 1, fontWeight: '600' }}
      >
        {props.text}
      </Txt>
      {props.onPress ? (
        <Txt variant="meta" muted>
          {'›'}
        </Txt>
      ) : null}
    </View>
  );
  return (
    <FadeIn>
      {props.onPress ? (
        <Pressable
          testID={props.testID}
          accessibilityRole="button"
          accessibilityLabel={props.text}
          accessibilityHint={props.actionHint}
          onPress={props.onPress}
          style={{ minHeight: 44, justifyContent: 'center' }}
        >
          {body}
        </Pressable>
      ) : (
        <View
          testID={props.testID}
          accessible
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          accessibilityLabel={props.text}
        >
          {body}
        </View>
      )}
    </FadeIn>
  );
}
