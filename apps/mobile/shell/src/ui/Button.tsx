import React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { MIN_TARGET, useTheme } from './theme';
import { Txt } from './Txt';

export type ButtonVariant = 'primary' | 'secondary' | 'destructive';

function darken(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift: number) => Math.round(((n >> shift) & 255) * (1 - amount));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

export function Button(props: {
  label: string;
  onPress: () => void;
  testID?: string;
  variant?: ButtonVariant;
  disabled?: boolean;
  busy?: boolean;
  // Spoken while busy, e.g. "Acknowledging"; the label is not shown then.
  busyLabel?: string;
  hint?: string;
  compact?: boolean;
}) {
  const theme = useTheme();
  const { c } = theme;
  const variant = props.variant ?? 'primary';
  const inactive = !!props.disabled || !!props.busy;
  const ink =
    variant === 'primary'
      ? c.onBrand
      : variant === 'destructive'
      ? c.critical
      : c.text;
  return (
    <Pressable
      testID={props.testID}
      accessibilityRole="button"
      accessibilityLabel={
        props.busy ? props.busyLabel ?? props.label : props.label
      }
      accessibilityHint={props.hint}
      accessibilityState={{ disabled: !!props.disabled, busy: !!props.busy }}
      disabled={inactive}
      onPress={props.onPress}
      hitSlop={props.compact ? { top: 4, bottom: 4 } : undefined}
      style={({ pressed }) => ({
        minHeight: props.compact ? MIN_TARGET : 48,
        minWidth: MIN_TARGET,
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: theme.radius.control,
        borderWidth: variant === 'primary' ? 0 : 1,
        borderColor: variant === 'destructive' ? c.critical : c.line,
        backgroundColor:
          variant === 'primary'
            ? pressed
              ? darken(c.brand, 0.12)
              : c.brand
            : pressed
            ? c.line
            : 'transparent',
        opacity: props.disabled && !props.busy ? 0.5 : 1,
        alignItems: 'center',
        justifyContent: 'center',
      })}
    >
      {props.busy ? (
        <View style={{ height: 22, justifyContent: 'center' }}>
          <ActivityIndicator color={ink} />
        </View>
      ) : (
        <Txt variant="button" color={ink} style={{ textAlign: 'center' }}>
          {props.label}
        </Txt>
      )}
    </Pressable>
  );
}

// Text-only action for toolbars and lists; still a 44pt target.
export function LinkButton(props: {
  label: string;
  onPress: () => void;
  testID?: string;
  tone?: 'brand' | 'critical' | 'plain';
  disabled?: boolean;
  hint?: string;
  accessibilityLabel?: string;
  children?: React.ReactNode;
}) {
  const { c } = useTheme();
  return (
    <Pressable
      testID={props.testID}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityHint={props.hint}
      accessibilityState={{ disabled: !!props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => ({
        minHeight: MIN_TARGET,
        minWidth: MIN_TARGET,
        justifyContent: 'center',
        opacity: props.disabled ? 0.5 : pressed ? 0.6 : 1,
      })}
    >
      <Txt
        variant="button"
        color={
          props.tone === 'critical'
            ? c.critical
            : props.tone === 'plain'
            ? c.text
            : c.brand
        }
      >
        {props.label}
      </Txt>
      {props.children}
    </Pressable>
  );
}
