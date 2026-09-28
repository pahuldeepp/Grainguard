import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { bandOf, hottest, sensorLabel } from './readings';
import type { Band, BinCables } from './readings';
import { Glyph } from './SeverityMarker';
import { SectionHeader } from './Feedback';
import { useTheme } from './theme';
import { Txt } from './Txt';

const BODY_H = 200;
const ROOF_H = 34;
const GUTTER = 48;
const DOT = 18;

// Side-on section of a grain bin. Temperature cables hang from the roof; each
// sensor is a square whose look encodes its band (hollow, filled, filled with
// a ring) as well as colour. Tap a sensor to read it; the hot spot is
// selected by default and named in the caption.
export function BinProfile(props: { bin: BinCables }) {
  const { c } = useTheme();
  const { bin } = props;
  const spot = hottest(bin);
  const spotBand = spot ? bandOf(bin, spot.point.tempC) : 'normal';
  const [sel, setSel] = useState(spot);
  const [width, setWidth] = useState(300);
  const bodyW = Math.max(180, Math.min(width, 380) - GUTTER - 16);
  const grainTop = BODY_H * (1 - bin.grainDepthM / bin.heightM);
  const yOf = (d: number) =>
    grainTop + (d / bin.grainDepthM) * (BODY_H - grainTop - 6);
  const n = bin.cables.length;
  const total = bin.cables.reduce((a, cb) => a + cb.points.length, 0);
  const isSpot = (id: number, depth: number) =>
    spotBand !== 'normal' &&
    spot?.cableId === id &&
    spot.point.depthM === depth;
  const bandColor = (b: Band) =>
    b === 'hot' ? c.critical : b === 'warm' ? c.warning : c.textMuted;
  const selBand = sel ? bandOf(bin, sel.point.tempC) : 'normal';

  return (
    <View
      testID="bin-profile"
      onLayout={e => setWidth(e.nativeEvent.layout.width)}
    >
      <SectionHeader title="Inside the bin" />
      <View
        accessible
        accessibilityLabel={`Bin cross-section with ${total} sensors on ${n} cables.${
          spot ? ` Warmest: ${sensorLabel(spot.cableId, spot.point)}.` : ''
        } Sensors below are buttons.`}
        style={{ paddingHorizontal: 16 }}
      >
        <View style={{ height: ROOF_H + BODY_H, flexDirection: 'row' }}>
          <View style={{ width: GUTTER, height: ROOF_H + BODY_H }}>
            <Txt
              variant="meta"
              muted
              style={{ position: 'absolute', top: ROOF_H + grainTop - 10 }}
            >
              0 m
            </Txt>
            <Txt
              variant="meta"
              muted
              style={{ position: 'absolute', bottom: 2 }}
            >
              {`${bin.grainDepthM} m`}
            </Txt>
          </View>
          <View style={{ width: bodyW }}>
            <View
              style={{
                height: ROOF_H,
                borderTopLeftRadius: ROOF_H,
                borderTopRightRadius: ROOF_H,
                borderWidth: 2,
                borderBottomWidth: 0,
                borderColor: c.textMuted,
                backgroundColor: c.surface,
              }}
            />
            <View
              style={{
                height: BODY_H,
                borderWidth: 2,
                borderTopWidth: 0,
                borderColor: c.textMuted,
                backgroundColor: c.surface,
                overflow: 'hidden',
                marginTop: -1,
              }}
            >
              <View
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  top: grainTop,
                  bottom: 0,
                  backgroundColor: c.bg,
                  borderTopWidth: 2,
                  borderColor: c.line,
                }}
              />
            </View>
            {bin.cables.map((cb, i) => {
              const x = ((i + 1) / (n + 1)) * (bodyW - 4);
              return (
                <View
                  key={cb.id}
                  pointerEvents="box-none"
                  style={{
                    position: 'absolute',
                    left: x,
                    top: ROOF_H * 0.5,
                    width: 2,
                    bottom: 2,
                    backgroundColor: c.line,
                  }}
                />
              );
            })}
            {bin.cables.flatMap((cb, i) => {
              const x = ((i + 1) / (n + 1)) * (bodyW - 4) + 1;
              return cb.points.map(p => {
                const band = bandOf(bin, p.tempC);
                const ring = isSpot(cb.id, p.depthM);
                const color = bandColor(band);
                const selected =
                  sel?.cableId === cb.id && sel.point.depthM === p.depthM;
                return (
                  <Pressable
                    key={`${cb.id}-${p.depthM}`}
                    testID={`sensor-${cb.id}-${p.depthM}`}
                    accessibilityRole="button"
                    accessibilityLabel={`${sensorLabel(cb.id, p)}, ${band}${
                      ring ? ', hot spot' : ''
                    }`}
                    accessibilityState={{ selected }}
                    hitSlop={14}
                    onPress={() => setSel({ cableId: cb.id, point: p })}
                    style={{
                      position: 'absolute',
                      left: x - (ring ? DOT + 8 : DOT) / 2,
                      top: ROOF_H + yOf(p.depthM) - (ring ? DOT + 8 : DOT) / 2,
                      width: ring ? DOT + 8 : DOT,
                      height: ring ? DOT + 8 : DOT,
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderWidth: ring ? 3 : 0,
                      borderColor: c.critical,
                      borderRadius: 4,
                    }}
                  >
                    <View
                      style={{
                        width: DOT,
                        height: DOT,
                        borderRadius: 3,
                        backgroundColor: band === 'normal' ? c.surface : color,
                        borderWidth: 2,
                        borderColor: selected ? c.text : color,
                      }}
                    />
                  </Pressable>
                );
              });
            })}
          </View>
        </View>
        <View
          style={{
            flexDirection: 'row',
            marginLeft: GUTTER,
            width: bodyW,
            height: 24,
          }}
        >
          {bin.cables.map((cb, i) => (
            <Txt
              key={cb.id}
              variant="meta"
              muted={spot?.cableId !== cb.id}
              color={
                spotBand !== 'normal' && spot?.cableId === cb.id
                  ? c.critical
                  : undefined
              }
              style={{
                position: 'absolute',
                left: ((i + 1) / (n + 1)) * (bodyW - 4) - 6,
                fontWeight: spot?.cableId === cb.id ? '700' : '400',
              }}
            >
              {String(cb.id)}
            </Txt>
          ))}
        </View>
        <Txt variant="meta" muted style={{ marginLeft: GUTTER }}>
          Cable number
        </Txt>
        {sel ? (
          <View
            testID="sensor-caption"
            accessibilityLiveRegion="polite"
            style={{
              marginTop: 12,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              paddingLeft: 12,
              borderLeftWidth: 4,
              borderColor: bandColor(selBand),
            }}
          >
            {selBand === 'hot' ? <Glyph kind="critical" size={18} /> : null}
            <Txt variant="rowTitle" style={{ flexShrink: 1 }}>
              {`${sensorLabel(sel.cableId, sel.point)}${
                selBand === 'hot'
                  ? ', hot spot'
                  : selBand === 'warm'
                  ? ', warm'
                  : ''
              }`}
            </Txt>
          </View>
        ) : null}
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 16,
            marginTop: 12,
          }}
        >
          {(
            [
              ['normal', `Below ${bin.warmFromC}`],
              ['warm', `Warm from ${bin.warmFromC}`],
              ['hot', `Hot from ${bin.hotFromC}`],
            ] as [Band, string][]
          ).map(([b, text]) => (
            <View
              key={b}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
            >
              <View
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 3,
                  borderWidth: 2,
                  borderColor: bandColor(b),
                  backgroundColor: b === 'normal' ? c.surface : bandColor(b),
                }}
              />
              <Txt variant="meta" muted>
                {`${text} °C`}
              </Txt>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}
