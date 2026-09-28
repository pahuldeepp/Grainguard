import React from 'react';
import { Text } from 'react-native';
import type { TextProps } from 'react-native';
import { type } from './theme';
import type { TypeRole } from './theme';
import { useTheme } from './theme';

export function Txt(
  props: TextProps & { variant?: TypeRole; muted?: boolean; color?: string },
) {
  const { variant = 'body', muted, color, style, ...rest } = props;
  const theme = useTheme();
  const t = type[variant];
  return (
    <Text
      allowFontScaling
      maxFontSizeMultiplier={t.cap}
      {...rest}
      style={[
        {
          color: color ?? (muted ? theme.c.textMuted : theme.c.text),
          fontSize: t.size,
          lineHeight: t.line,
          fontWeight: t.weight,
        },
        t.tabular ? { fontVariant: ['tabular-nums'] } : null,
        style,
      ]}
    />
  );
}
