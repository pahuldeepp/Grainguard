import React from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import { MIN_TARGET, useTheme } from './theme';
import { Txt } from './Txt';

export interface Segment<T extends string> {
  key: T;
  label: string;
  count?: number | string;
}

// Filter tabs: label and count inline, selected tab underlined and bold. Each
// reads as "Open, 3, selected" to a screen reader.
export function Segmented<T extends string>(props: {
  segments: Segment<T>[];
  value: T;
  onChange: (key: T) => void;
  testIDPrefix?: string;
}) {
  const { c } = useTheme();
  const stacked = useWindowDimensions().fontScale > 1.25;
  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: 'row',
        borderBottomWidth: 1,
        borderColor: c.line,
      }}
    >
      {props.segments.map(s => {
        const selected = s.key === props.value;
        return (
          <Pressable
            key={s.key}
            testID={`${props.testIDPrefix ?? 'filter'}-${s.key}`}
            accessibilityRole="tab"
            accessibilityLabel={
              s.count === undefined ? s.label : `${s.label}, ${s.count}`
            }
            accessibilityState={{ selected }}
            onPress={() => props.onChange(s.key)}
            style={({ pressed }) => ({
              flexGrow: s.label.length > 6 ? 1.6 : 1,
              flexBasis: 0,
              minHeight: MIN_TARGET,
              flexDirection: stacked ? 'column' : 'row',
              flexWrap: 'nowrap',
              alignItems: 'center',
              justifyContent: 'center',
              columnGap: 6,
              paddingHorizontal: 4,
              borderBottomWidth: 3,
              marginBottom: -1,
              borderColor: selected ? c.text : 'transparent',
              backgroundColor: pressed ? c.line : 'transparent',
            })}
          >
            <Txt
              variant="body"
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.7}
              color={selected ? c.text : c.textMuted}
              style={{ fontWeight: selected ? '700' : '400' }}
            >
              {s.label}
            </Txt>
            {s.count === undefined ? null : (
              <Txt
                variant="body"
                color={selected ? c.text : c.textMuted}
                style={{ fontVariant: ['tabular-nums'], fontWeight: '600' }}
              >
                {String(s.count)}
              </Txt>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}
