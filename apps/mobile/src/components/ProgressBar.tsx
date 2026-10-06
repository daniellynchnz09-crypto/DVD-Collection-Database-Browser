import { useEffect, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { WELL } from "../theme";

/**
 * A real determinate loading bar - fills from start to finish once and stays there, instead
 * of `IndeterminateBar`'s segment sweeping back and forth forever with no sense of progress
 * or completion. Added 2026-09-27, per the user's own request: "an actually loading bar that
 * moves from start to finish rather than one that just goes through the same line over and
 * over again like a spinning wheel."
 *
 * `progress` is 0-1. There's still no way to observe genuine per-entry backend progress from
 * a single atomic Collection-submit request (see `IndeterminateBar`'s own comment on why that
 * request is deliberately one request, not one per entry - splitting it would risk a
 * partially-written collection if a later entry failed validation after earlier ones were
 * already saved). The caller instead animates `progress` up over an estimated duration scaled
 * by how many entries are being submitted, then snaps it to 1 the instant the real response
 * comes back - so this is an honest estimate of elapsed time, not a claim of exact backend
 * state, but it moves steadily toward completion rather than cycling, and it never claims
 * "done" until the real request actually finishes.
 */
export default function ProgressBar({ progress }: { progress: number }) {
  const widthPct = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(widthPct, {
      toValue: Math.max(0, Math.min(1, progress)) * 100,
      duration: 300,
      useNativeDriver: false, // Animating a percentage `width`, which the native driver can't do.
    }).start();
  }, [progress, widthPct]);

  return (
    <View style={styles.track}>
      <Animated.View style={[styles.fill, { width: widthPct.interpolate({ inputRange: [0, 100], outputRange: ["0%", "100%"] }) }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: { ...WELL, height: 4, backgroundColor: "#16294a", borderRadius: 2, overflow: "hidden", marginTop: 8 },
  fill: { height: 4, backgroundColor: "#5cc8ff", borderRadius: 2 },
});
