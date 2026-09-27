import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing } from 'react-native';

export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let live = true;
    Promise.resolve(AccessibilityInfo.isReduceMotionEnabled?.())
      .then(v => live && setReduce(!!v))
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', v =>
      setReduce(!!v),
    );
    return () => {
      live = false;
      sub?.remove?.();
    };
  }, []);
  return reduce;
}

export const RESPONSE_MS = 180;

// Response-only fade for content that appears because of a user action or a
// state change (banners, confirmations). Instant under Reduce Motion.
export function FadeIn(props: { children: React.ReactNode }) {
  const reduce = useReduceMotion();
  const opacity = useRef(new Animated.Value(reduce ? 1 : 0)).current;
  useEffect(() => {
    if (reduce) {
      opacity.setValue(1);
      return;
    }
    Animated.timing(opacity, {
      toValue: 1,
      duration: RESPONSE_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [reduce, opacity]);
  return <Animated.View style={{ opacity }}>{props.children}</Animated.View>;
}

export function announce(message: string) {
  try {
    AccessibilityInfo.announceForAccessibility?.(message);
  } catch {
    // Announcements are best effort.
  }
}
