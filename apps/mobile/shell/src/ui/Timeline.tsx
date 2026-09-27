import React from 'react';
import { View } from 'react-native';
import { longTimeAgo } from './format';
import type { TimelineEntry } from './alerts';
import { SectionHeader } from './Feedback';
import { useTheme } from './theme';
import { Txt } from './Txt';

export function Timeline(props: {
  entries: TimelineEntry[];
  now: number;
  demo?: boolean;
}) {
  const { c } = useTheme();
  return (
    <View testID="timeline">
      <SectionHeader title={props.demo ? 'History (demo)' : 'History'} />
      <View
        style={{
          backgroundColor: c.surface,
          borderTopWidth: 1,
          borderBottomWidth: 1,
          borderColor: c.line,
        }}
      >
        {props.entries.map((e, i) => {
          const last = i === props.entries.length - 1;
          const when = e.when ? longTimeAgo(e.when, props.now) : e.note;
          return (
            <View
              key={`${e.label}-${i}`}
              accessible
              accessibilityLabel={[e.label, e.detail, when]
                .filter(Boolean)
                .join(', ')}
              style={{ flexDirection: 'row', paddingHorizontal: 16, gap: 12 }}
            >
              <View style={{ alignItems: 'center', width: 12, paddingTop: 18 }}>
                <View
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 5,
                    backgroundColor: e.when ? c.brand : c.line,
                  }}
                />
                {last ? null : (
                  <View
                    style={{ flex: 1, width: 2, backgroundColor: c.line }}
                  />
                )}
              </View>
              <View style={{ flex: 1, paddingVertical: 12 }}>
                <Txt variant="rowTitle">
                  {e.detail ? `${e.label} ${e.detail}` : e.label}
                </Txt>
                <Txt variant="meta" muted>
                  {when ?? ''}
                </Txt>
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}
