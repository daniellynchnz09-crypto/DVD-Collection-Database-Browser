import { useRef, type ReactNode } from "react";
import { Dimensions, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { FONTS, GLOSS } from "../theme";

export type Slide = { key: string; label: string; node: ReactNode };

type Props = {
  slides: Slide[];
  activeKey: string;
  onChange: (key: string) => void;
  /** When set (a slide opened from a Review row), Back/Next collapse into one button that returns here. */
  returnKey?: string | null;
};

const EDGE_SWIPE_ZONE = 36;
const SWIPE_DISTANCE = 70;

/** One slide at a time with progress dots and big Back/Next buttons. Every slide's content stays in
 * the parent's own state, so nothing here owns data. A swipe only counts when it starts at the left
 * or right screen edge, so it never fights the horizontal poster list or a scrolling form. */
export default function SlideFlow({ slides, activeKey, onChange, returnKey }: Props) {
  const index = Math.max(0, slides.findIndex((s) => s.key === activeKey));
  const slide = slides[index];
  const touch = useRef<{ x: number; y: number; edge: boolean } | null>(null);

  const go = (i: number) => {
    const target = slides[i];
    if (target) onChange(target.key);
  };

  return (
    <View
      onTouchStart={(e) => {
        const { pageX, pageY } = e.nativeEvent;
        const screenWidth = Dimensions.get("window").width;
        touch.current = { x: pageX, y: pageY, edge: pageX < EDGE_SWIPE_ZONE || pageX > screenWidth - EDGE_SWIPE_ZONE };
      }}
      onTouchEnd={(e) => {
        const start = touch.current;
        touch.current = null;
        if (!start || !start.edge) return;
        const dx = e.nativeEvent.pageX - start.x;
        const dy = e.nativeEvent.pageY - start.y;
        if (Math.abs(dx) > SWIPE_DISTANCE && Math.abs(dy) < 60) go(index + (dx < 0 ? 1 : -1));
      }}
      style={styles.wrap}
    >
      <View style={styles.dots}>
        {slides.map((s, i) => (
          <TouchableOpacity key={s.key} onPress={() => onChange(s.key)} style={styles.dotHit} hitSlop={6}>
            <View style={[styles.dot, i === index && styles.dotActive]} />
          </TouchableOpacity>
        ))}
      </View>
      <Text style={styles.slideLabel}>
        {index + 1} of {slides.length}: {slide?.label}
      </Text>

      <View style={styles.body}>{slide?.node}</View>

      <View style={styles.nav}>
        {returnKey && returnKey !== activeKey ? (
          <TouchableOpacity style={[styles.navButton, styles.navNext]} onPress={() => onChange(returnKey)}>
            <Text style={styles.navText}>Back to review</Text>
          </TouchableOpacity>
        ) : (
          <>
            <TouchableOpacity
              style={[styles.navButton, styles.navBack, index === 0 && styles.navDisabled]}
              onPress={() => go(index - 1)}
              disabled={index === 0}
            >
              <Text style={styles.navText}>Back</Text>
            </TouchableOpacity>
            {index < slides.length - 1 && (
              <TouchableOpacity style={[styles.navButton, styles.navNext]} onPress={() => go(index + 1)}>
                <Text style={styles.navText}>Next</Text>
              </TouchableOpacity>
            )}
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 12 },
  dots: { flexDirection: "row", justifyContent: "center", flexWrap: "wrap" },
  dotHit: { padding: 6 },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: "#24395a" },
  dotActive: { backgroundColor: "#5cc8ff", width: 22 },
  slideLabel: { fontFamily: FONTS.body, color: "#a9b8cc", textAlign: "center", fontSize: 13 },
  body: { gap: 12 },
  nav: { flexDirection: "row", gap: 12, marginTop: 8 },
  navButton: { flex: 1, minHeight: 56, borderRadius: 0, alignItems: "center", justifyContent: "center" },
  navBack: { ...GLOSS, backgroundColor: "#16294a" },
  navNext: { backgroundColor: "#1d6c9a" },
  navDisabled: { opacity: 0.35 },
  navText: { color: "#e9f1f9", fontSize: 18, fontFamily: FONTS.displayBold },
});
