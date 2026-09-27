import { StyleSheet, View, useWindowDimensions } from "react-native";
import { COVER_GUIDE } from "../lib/coverGuide";

/**
 * The advisory alignment rectangle for cover-photo scanning - purely visual, never analyzed
 * against the live camera feed (no real corner/edge detection; see coverGuide.ts's own
 * comment for why). Computed in real screen pixels via `useWindowDimensions` rather than plain
 * CSS percentages, since a percentage width and a percentage height are relative to two
 * different axes of the container and would distort the rectangle's aspect ratio - this needs
 * one consistent aspect ratio in actual pixels so it matches `computeCoverCropRegion`'s own math.
 */
export default function CoverCaptureGuide() {
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const boxWidth = screenWidth * COVER_GUIDE.widthRatio;
  const boxHeight = boxWidth / COVER_GUIDE.aspectRatio;
  const left = (screenWidth - boxWidth) / 2;
  const top = screenHeight * COVER_GUIDE.topRatio;

  return (
    <View
      pointerEvents="none"
      style={[styles.box, { left, top, width: boxWidth, height: boxHeight }]}
    />
  );
}

const styles = StyleSheet.create({
  box: {
    position: "absolute",
    borderWidth: 3,
    borderColor: "#fbbf24",
    borderStyle: "dashed",
    borderRadius: 12,
  },
});
