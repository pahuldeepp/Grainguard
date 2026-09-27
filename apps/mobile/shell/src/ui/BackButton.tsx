import React, { useRef } from 'react';
import { PanResponder, Pressable, View } from 'react-native';
import { MIN_TARGET, useTheme } from './theme';
import { Txt } from './Txt';

export function BackButton(props: { label?: string; onPress: () => void }) {
  const { c } = useTheme();
  return (
    <Pressable
      testID="back-button"
      accessibilityRole="button"
      accessibilityLabel="Back to alerts"
      onPress={props.onPress}
      style={({ pressed }) => ({
        minHeight: MIN_TARGET,
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingRight: 12,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <View
        style={{
          width: 12,
          height: 12,
          marginLeft: 4,
          borderLeftWidth: 3,
          borderBottomWidth: 3,
          borderColor: c.brand,
          transform: [{ rotate: '45deg' }],
        }}
      />
      <Txt variant="button" color={c.brand}>
        {props.label ?? 'Alerts'}
      </Txt>
    </Pressable>
  );
}

// iOS-style swipe back: a rightward drag that starts at the left edge.
export function EdgeSwipeBack(props: { onBack: () => void }) {
  const cb = useRef(props.onBack);
  cb.current = props.onBack;
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderRelease: (_e, g) => {
        if (g.dx > 60 && Math.abs(g.dy) < 60) cb.current();
      },
    }),
  ).current;
  return (
    <View
      testID="edge-swipe-back"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      {...pan.panHandlers}
      style={{ position: 'absolute', left: 0, top: 80, bottom: 80, width: 20 }}
    />
  );
}
