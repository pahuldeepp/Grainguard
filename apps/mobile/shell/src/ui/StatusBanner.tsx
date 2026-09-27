import React from 'react';
import { View } from 'react-native';
import { Glyph } from './SeverityMarker';
import { FadeIn } from './motion';
import { markerColor, useTheme } from './theme';
import type { MarkerKind } from './theme';
import { Txt } from './Txt';
import { LinkButton } from './Button';

export type BannerKind = 'offline' | 'stale' | 'error' | 'info' | 'success';

const KIND_MARKER: Record<BannerKind, MarkerKind> = {
  offline: 'unsent',
  stale: 'warning',
  error: 'critical',
  info: 'notice',
  success: 'acknowledged',
};

export function StatusBanner(props: {
  kind: BannerKind;
  text: string;
  testID?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const { c } = useTheme();
  const tone = markerColor(c, KIND_MARKER[props.kind]);
  return (
    <FadeIn>
      <View
        testID={props.testID}
        accessible={!props.onAction}
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        accessibilityLabel={props.onAction ? undefined : props.text}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingHorizontal: 16,
          paddingVertical: 12,
          backgroundColor: c.surface,
          borderBottomWidth: 1,
          borderTopWidth: 1,
          borderColor: c.line,
          borderLeftWidth: 4,
          borderLeftColor: tone,
        }}
      >
        <Glyph kind={KIND_MARKER[props.kind]} />
        <View style={{ flex: 1 }}>
          <Txt variant="meta">{props.text}</Txt>
        </View>
        {props.actionLabel && props.onAction ? (
          <LinkButton label={props.actionLabel} onPress={props.onAction} />
        ) : null}
      </View>
    </FadeIn>
  );
}
