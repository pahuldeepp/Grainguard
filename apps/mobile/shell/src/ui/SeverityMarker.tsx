import React from 'react';
import { Text, View, useWindowDimensions } from 'react-native';
import { MARKER_WORD, markerColor, useTheme } from './theme';
import type { MarkerKind } from './theme';
import { Txt } from './Txt';

// Glyphs are drawn with plain Views (no icon dependency). Shapes are fixed per
// level so meaning never depends on colour: octagon, filled triangle, outlined
// triangle, circle with i, circle with check, cloud with slash.
export function Glyph(props: { kind: MarkerKind; size?: number }) {
  const theme = useTheme();
  const { fontScale } = useWindowDimensions();
  const s = Math.round(
    (props.size ?? 22) * Math.min(Math.max(fontScale, 1), 1.5),
  );
  const color = markerColor(theme.c, props.kind);
  const ink = theme.c.surface;
  const mark = (ch: string, c: string, dy = 0) => (
    <Text
      allowFontScaling={false}
      style={{
        position: 'absolute',
        color: c,
        fontSize: s * 0.6,
        lineHeight: s * 0.7,
        fontWeight: '800',
        top: s * 0.2 + dy,
        textAlign: 'center',
        width: s,
      }}
    >
      {ch}
    </Text>
  );
  let shape: React.ReactNode;
  switch (props.kind) {
    case 'critical':
      shape = (
        <View style={{ width: s, height: s }}>
          <View style={{ width: s, height: s, overflow: 'hidden' }}>
            <View
              style={{
                width: s,
                height: s,
                backgroundColor: color,
                transform: [{ rotate: '45deg' }],
              }}
            />
          </View>
          {mark('!', ink)}
        </View>
      );
      break;
    case 'high':
    case 'warning': {
      const filled = props.kind === 'high';
      const w = s / 2;
      const tri = (half: number, h: number, c: string) => ({
        width: 0,
        height: 0,
        borderLeftWidth: half,
        borderRightWidth: half,
        borderBottomWidth: h,
        borderLeftColor: 'transparent',
        borderRightColor: 'transparent',
        borderBottomColor: c,
      });
      shape = (
        <View style={{ width: s, height: s, alignItems: 'center' }}>
          <View style={tri(w, s * 0.9, color)} />
          {!filled ? (
            <View
              style={[
                { position: 'absolute', top: s * 0.27 },
                tri(w * 0.55, s * 0.5, ink),
              ]}
            />
          ) : null}
          {mark('!', filled ? ink : color, s * 0.1)}
        </View>
      );
      break;
    }
    case 'notice':
      shape = (
        <View
          style={{
            width: s,
            height: s,
            borderRadius: s / 2,
            borderWidth: 2,
            borderColor: color,
          }}
        >
          {mark('i', color, -2)}
        </View>
      );
      break;
    case 'acknowledged':
      shape = (
        <View
          style={{
            width: s,
            height: s,
            borderRadius: s / 2,
            backgroundColor: color,
          }}
        >
          {mark('✓', ink, -1)}
        </View>
      );
      break;
    case 'unsent':
      shape = (
        <View style={{ width: s, height: s }}>
          <View
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: s * 0.18,
              height: s * 0.42,
              borderRadius: s * 0.21,
              backgroundColor: color,
            }}
          />
          <View
            style={{
              position: 'absolute',
              left: s * 0.18,
              bottom: s * 0.4,
              width: s * 0.36,
              height: s * 0.36,
              borderRadius: s * 0.18,
              backgroundColor: color,
            }}
          />
          <View
            style={{
              position: 'absolute',
              left: s * 0.42,
              bottom: s * 0.4,
              width: s * 0.46,
              height: s * 0.46,
              borderRadius: s * 0.23,
              backgroundColor: color,
            }}
          />
          <View
            style={{
              position: 'absolute',
              left: -s * 0.1,
              top: s * 0.46,
              width: s * 1.2,
              height: 3,
              backgroundColor: color,
              borderTopWidth: 2,
              borderBottomWidth: 2,
              borderColor: ink,
              transform: [{ rotate: '-45deg' }],
            }}
          />
        </View>
      );
      break;
  }
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: s, height: s }}
    >
      {shape}
    </View>
  );
}

export function SeverityMarker(props: {
  kind: MarkerKind;
  testID?: string;
  variant?: 'rowTitle' | 'meta' | 'body';
}) {
  const theme = useTheme();
  const word = MARKER_WORD[props.kind];
  return (
    <View
      testID={props.testID}
      accessible
      accessibilityLabel={word}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
    >
      <Glyph kind={props.kind} />
      <Txt
        variant={props.variant ?? 'meta'}
        style={{ fontWeight: '700' }}
        color={markerColor(theme.c, props.kind)}
      >
        {word}
      </Txt>
    </View>
  );
}
