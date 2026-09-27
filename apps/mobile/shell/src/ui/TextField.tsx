import React, { useState } from 'react';
import { TextInput, View } from 'react-native';
import type { TextInputProps } from 'react-native';
import { radius as radii, useTheme } from './theme';
import { Txt } from './Txt';

// Label above (never placeholder-only), 48 high, 2px focus ring, error below
// with an explicit marker so it is not colour alone.
export function TextField(
  props: Omit<TextInputProps, 'style'> & {
    label: string;
    error?: string | null;
    testID?: string;
  },
) {
  const { c } = useTheme();
  const [focused, setFocused] = useState(false);
  const { label, error, ...input } = props;
  return (
    <View style={{ gap: 4 }}>
      <Txt variant="meta" muted>
        {label}
      </Txt>
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={error ?? undefined}
        placeholderTextColor={c.textMuted}
        allowFontScaling
        maxFontSizeMultiplier={1.8}
        {...input}
        onFocus={e => {
          setFocused(true);
          input.onFocus?.(e);
        }}
        onBlur={e => {
          setFocused(false);
          input.onBlur?.(e);
        }}
        style={{
          minHeight: 48,
          paddingHorizontal: 12,
          fontSize: 16,
          color: c.text,
          backgroundColor: c.surface,
          borderRadius: radii.input,
          borderWidth: focused ? 2 : 1,
          borderColor: error ? c.critical : focused ? c.focus : c.line,
        }}
      />
      {error ? (
        <Txt variant="meta" color={c.critical} accessibilityLiveRegion="polite">
          {`Error: ${error}`}
        </Txt>
      ) : null}
    </View>
  );
}
