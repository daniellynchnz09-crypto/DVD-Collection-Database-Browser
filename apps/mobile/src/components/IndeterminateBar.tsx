import { useEffect, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { WELL } from "../theme";

/**
 * Slim indeterminate loading bar (added 2026-09-20, per the user's request - a Collection
 * submit writes a header plus every member row to Supabase AND the Sheet, which takes a
 * noticeable few seconds). There's no real progress figure to show (it's one request), so a
 * segment sweeps back and forth across the track instead of filling to a percentage.
 */
export default function IndeterminateBar() {
  const [trackWidth, setTrackWidth] = useState(0);
  const position = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(position, { toValue: 1, duration: 1100, easing: Easing.inOut(Easing.ease), useNativeDriver: true })
    );
    loop.start();
    return () => loop.stop();
  }, [position]);

  const segmentWidth = trackWidth * 0.35;
  const translateX = position.interpolate({ inputRange: [0, 1], outputRange: [-segmentWidth, trackWidth] });

  return (
    <View style={styles.track} onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}>
      {trackWidth > 0 && <Animated.View style={[styles.segment, { width: segmentWidth, transform: [{ translateX }] }]} />}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { ...WELL, height: 4, backgroundColor: "#16294a", borderRadius: 2, overflow: "hidden", marginTop: 8 },
  segment: { height: 4, backgroundColor: "#5cc8ff", borderRadius: 2 },
});
