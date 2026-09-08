import type { RefObject } from "react";
import { Dimensions, type ScrollView, UIManager } from "react-native";

/**
 * Manual scroll-to-focused-field, built directly on RN's own public `UIManager.measureInWindow`
 * rather than a third-party keyboard-aware scroll view - `react-native-keyboard-aware-scroll-
 * view` was tried on this exact screen earlier and proved inconsistent in real testing
 * (sometimes still let the keyboard cover a field, sometimes pushed the Confirm button out of
 * the safe area - see Claude/TECH STACK AND ARCHITECTURE.md's keyboard-avoidance history), so
 * this avoids depending on another library's own internal assumptions.
 *
 * `getKeyboardHeight`/`getScrollY` are getters (not plain values) so this can be created once
 * and always read the current values via refs, without needing to be recreated on every
 * keyboard-height or scroll-position change.
 */
export function createScrollIntoViewHandler(
  scrollRef: RefObject<ScrollView | null>,
  getKeyboardHeight: () => number,
  getScrollY: () => number
) {
  return function scrollNodeIntoView(nodeHandle: number | null, delayMs = 0) {
    if (!nodeHandle) return;
    const measureAndScroll = () => {
      UIManager.measureInWindow(nodeHandle, (x, y, width, height) => {
        const keyboardHeight = getKeyboardHeight();
        if (keyboardHeight === 0) return; // keyboard isn't up (yet) - nothing to avoid
        const screenHeight = Dimensions.get("window").height;
        const visibleBottom = screenHeight - keyboardHeight;
        const margin = 24;
        const overflow = y + height - (visibleBottom - margin);
        if (overflow > 0) {
          scrollRef.current?.scrollTo({ y: Math.max(0, getScrollY() + overflow), animated: true });
        }
      });
    };
    if (delayMs > 0) setTimeout(measureAndScroll, delayMs);
    else requestAnimationFrame(measureAndScroll);
  };
}
