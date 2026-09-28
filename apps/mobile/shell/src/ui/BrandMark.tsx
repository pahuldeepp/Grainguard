import React from 'react';
import { View } from 'react-native';
import { useTheme } from './theme';

// Shield with a wheat ear, drawn with Views. Decorative: hidden from
// VoiceOver (the site name next to it carries the meaning).
export function BrandMark(props: { size?: number }) {
  const { c } = useTheme();
  const s = props.size ?? 30;
  const ink = c.onBrand;
  const leaf = (top: number, side: -1 | 1) => (
    <View
      key={`${top}${side}`}
      style={{
        position: 'absolute',
        top: s * top,
        left: s * (side < 0 ? 0.22 : 0.51),
        width: s * 0.1,
        height: s * 0.2,
        borderRadius: s * 0.1,
        backgroundColor: ink,
        transform: [{ rotate: side < 0 ? '-35deg' : '35deg' }],
      }}
    />
  );
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: s * 0.86,
        height: s,
        backgroundColor: c.brand,
        borderTopLeftRadius: s * 0.12,
        borderTopRightRadius: s * 0.12,
        borderBottomLeftRadius: s * 0.43,
        borderBottomRightRadius: s * 0.43,
      }}
    >
      <View
        style={{
          position: 'absolute',
          left: s * 0.43 - 1,
          top: s * 0.2,
          width: 2,
          height: s * 0.6,
          backgroundColor: ink,
        }}
      />
      {[0.2, 0.38, 0.56].map(t => leaf(t, -1))}
      {[0.2, 0.38, 0.56].map(t => leaf(t, 1))}
    </View>
  );
}
