import React from 'react';
import { View } from 'react-native';
import { Button } from './Button';
import { space, useTheme } from './theme';
import { Txt } from './Txt';

export function SectionHeader(props: { title: string; count?: number }) {
  const { c } = useTheme();
  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel={
        props.count === undefined
          ? props.title
          : `${props.title}, ${props.count}`
      }
      style={{
        flexDirection: 'row',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingTop: space.xl,
        paddingBottom: space.sm,
        backgroundColor: c.bg,
      }}
    >
      <Txt variant="section">{props.title}</Txt>
      {props.count === undefined ? null : (
        <Txt variant="data" muted>
          {String(props.count)}
        </Txt>
      )}
    </View>
  );
}

export function ListSkeleton(props: { rows?: number }) {
  const { c } = useTheme();
  const bar = (w: string, h = 12) => (
    <View
      style={{
        width: w as `${number}%`,
        height: h,
        borderRadius: 4,
        backgroundColor: c.line,
      }}
    />
  );
  return (
    <View
      testID="list-skeleton"
      accessible
      accessibilityLabel="Loading alerts"
      accessibilityState={{ busy: true }}
      style={{ backgroundColor: c.surface }}
    >
      {Array.from({ length: props.rows ?? 4 }, (_, i) => (
        <View
          key={i}
          style={{
            padding: 16,
            gap: 10,
            borderBottomWidth: 1,
            borderColor: c.line,
          }}
        >
          {bar('30%')}
          {bar('60%', 16)}
          {bar('45%')}
        </View>
      ))}
    </View>
  );
}

export function EmptyState(props: {
  title: string;
  body: string;
  testID?: string;
}) {
  return (
    <View
      testID={props.testID}
      accessible
      accessibilityLabel={`${props.title}. ${props.body}`}
      style={{ padding: space.xl, gap: space.sm }}
    >
      <Txt variant="section">{props.title}</Txt>
      <Txt muted>{props.body}</Txt>
    </View>
  );
}

export function ErrorState(props: {
  title: string;
  body: string;
  onRetry: () => void;
  testID?: string;
}) {
  return (
    <View testID={props.testID} style={{ padding: space.xl, gap: space.md }}>
      <View
        accessible
        accessibilityLabel={`${props.title}. ${props.body}`}
        style={{ gap: space.sm }}
      >
        <Txt variant="section">{props.title}</Txt>
        <Txt muted>{props.body}</Txt>
      </View>
      <Button
        testID="error-retry"
        label="Retry"
        onPress={props.onRetry}
        variant="secondary"
      />
    </View>
  );
}
