import React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { Glyph } from './SeverityMarker';
import {
  METRIC_LABEL,
  formatMetric,
  metricParts,
  groupThousands,
  isOver,
  metricLimit,
  metricValue,
} from './readings';
import type { AlertReadings, Metric } from './readings';
import { markerColor, useTheme } from './theme';
import { Txt } from './Txt';

const METRICS: Metric[] = ['temperature', 'moisture', 'co2'];

// The readings behind the alert: value large, limit beside it. A metric over
// its limit says so in words and glyph, not colour alone.
export function ReadingTiles(props: { readings: AlertReadings }) {
  const { c } = useTheme();
  // Large text: one metric per row so nothing clips.
  const stacked = useWindowDimensions().fontScale > 1.25;
  return (
    <View
      testID="reading-tiles"
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        backgroundColor: c.surface,
        borderTopWidth: 1,
        borderBottomWidth: 1,
        borderColor: c.line,
      }}
    >
      {METRICS.map((m, i) => {
        const over = isOver(props.readings, m);
        const limit = metricLimit(props.readings, m);
        const limitText = m === 'co2' ? groupThousands(limit) : String(limit);
        const value = formatMetric(m, metricValue(props.readings, m));
        return (
          <View
            key={m}
            accessible
            accessibilityLabel={`${
              METRIC_LABEL[m]
            }, ${value}, limit ${limitText}, ${
              over ? 'over limit' : 'within limit'
            }`}
            style={{
              flexGrow: 1,
              flexBasis: stacked ? '100%' : 120,
              padding: 12,
              gap: 2,
              borderLeftWidth: i === 0 || stacked ? 0 : 1,
              borderTopWidth: i > 0 && stacked ? 1 : 0,
              borderColor: c.line,
            }}
          >
            <Txt variant="meta" muted>
              {METRIC_LABEL[m]}
            </Txt>
            <View
              style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4 }}
            >
              <Txt variant="display" color={over ? c.critical : c.text}>
                {metricParts(m, metricValue(props.readings, m)).num}
              </Txt>
              <Txt variant="meta" color={over ? c.critical : c.textMuted}>
                {metricParts(m, metricValue(props.readings, m)).unit}
              </Txt>
            </View>
            <View
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
            >
              {over ? <Glyph kind="critical" size={14} /> : null}
              <Txt
                variant="meta"
                color={over ? markerColor(c, 'critical') : c.textMuted}
                style={{ fontVariant: ['tabular-nums'] }}
              >
                {over ? `Over limit ${limitText}` : `Limit ${limitText}`}
              </Txt>
            </View>
          </View>
        );
      })}
    </View>
  );
}

// 24 hourly bars for the triggering metric, limit as a dashed line. Bars over
// the limit are critical; the summary line carries the same information.
export function TrendBars(props: { readings: AlertReadings }) {
  const { c } = useTheme();
  const { readings } = props;
  const m = readings.trigger;
  const values = readings.trend24h;
  const limit = metricLimit(readings, m);
  if (values.length === 0) return null;
  const lo = Math.min(...values, limit) * 0.9;
  const hi = Math.max(...values, limit);
  const H = 72;
  const y = (v: number) => ((v - lo) / (hi - lo || 1)) * H;
  const first = values[0];
  const last = values[values.length - 1];
  const hoursOver = values.filter(v => v > limit).length;
  const summary = `${METRIC_LABEL[m]}, last 24 hours: from ${formatMetric(
    m,
    first,
  )} to ${formatMetric(m, last)}, over the limit for ${hoursOver} hour${
    hoursOver === 1 ? '' : 's'
  }`;
  return (
    <View testID="trend" style={{ paddingHorizontal: 16, gap: 8 }}>
      <View accessible accessibilityLabel={summary} style={{ gap: 8 }}>
        <Txt variant="rowTitle">{`${METRIC_LABEL[m]}, last 24 hours`}</Txt>
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{
            height: H,
            flexDirection: 'row',
            alignItems: 'flex-end',
            gap: 2,
          }}
        >
          {values.map((v, i) => (
            <View
              key={i}
              style={{
                flex: 1,
                height: Math.max(3, y(v)),
                borderTopLeftRadius: 2,
                borderTopRightRadius: 2,
                backgroundColor: v > limit ? c.critical : c.textMuted,
              }}
            />
          ))}
          <View
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: y(limit),
              borderTopWidth: 2,
              borderStyle: 'dashed',
              borderColor: c.text,
            }}
          />
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Txt variant="meta" muted>
            24 h ago
          </Txt>
          <Txt variant="meta" muted>
            Dashed line is the limit
          </Txt>
          <Txt variant="meta" muted>
            Now
          </Txt>
        </View>
      </View>
    </View>
  );
}
