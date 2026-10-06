/**
 * The scanner app's look, matched to the website (2026-10-07, the user: "make the design of the
 * scanner app match the design aesthetic of the website"). Same tokens as
 * apps/web/src/app/globals.css: deep navy gradients, light-blue accents, square (never rounded)
 * corners, Chakra Petch for headings/buttons/labels and Barlow for body text, and the light
 * skeuomorphism added there the same day - glossy raised buttons, bevelled panels, recessed
 * fields and tracks. Screens use these constants rather than one-off colours.
 *
 * Gradients and inner shadows use React Native's `experimental_backgroundImage` and
 * `boxShadow` style props (New Architecture, which Expo Go runs), so no wrapper components are
 * needed. Unlike the website, corners are square rather than cut: React Native can't clip a
 * view to a polygon.
 */

export const COLORS = {
  void: "#03060b",
  abyss: "#070d17",
  deep: "#0b1524",
  panel: "#0f1c2f",
  panelHi: "#16294a",
  steel: "#24395a",
  rule: "rgba(120,190,255,0.18)",
  ruleStrong: "rgba(120,190,255,0.4)",
  chrome: "#d7e2ee",
  chromeHi: "#f2f7fc",
  mist: "#8193ab",
  mistDim: "#56667d",
  accent: "#5cc8ff",
  accentHi: "#b3e8ff",
  accentDim: "#1d6c9a",
  accentDeep: "#0c3554",
  signal: "#ffb347",
} as const;

/** Font family per weight. Android can't synthesize weights for a custom font, so each weight
 * is its own family; fontWeight is left off any style that sets one of these. */
export const FONTS = {
  body: "Barlow_400Regular",
  bodyMedium: "Barlow_500Medium",
  bodySemiBold: "Barlow_600SemiBold",
  display: "ChakraPetch_500Medium",
  displaySemiBold: "ChakraPetch_600SemiBold",
  displayBold: "ChakraPetch_700Bold",
} as const;

/** The whole screen: the website's body gradient. */
export const SCREEN = {
  backgroundColor: COLORS.abyss,
  experimental_backgroundImage: `linear-gradient(180deg, ${COLORS.deep} 0%, ${COLORS.abyss} 45%, ${COLORS.void} 100%)`,
} as const;

/** Brushed-metal title strip (the website's chrome-bar). */
export const CHROME_BAR = {
  backgroundColor: "#1a2d4a",
  experimental_backgroundImage: "linear-gradient(180deg, #2c466c 0%, #1a2d4a 48%, #12223a 52%, #172a46 100%)",
  borderBottomWidth: 1,
  borderBottomColor: COLORS.ruleStrong,
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.18), 0 2px 6px rgba(0,0,0,0.5)",
} as const;

/** Raised, glossy face for buttons: bright upper half, darker lower half, lit top edge, drop
 * shadow. Sits on the button's own backgroundColor, so each keeps its hue. */
export const GLOSS = {
  experimental_backgroundImage:
    "linear-gradient(180deg, rgba(255,255,255,0.32) 0%, rgba(255,255,255,0.08) 49%, rgba(0,0,0,0.1) 50%, rgba(0,0,0,0.24) 100%)",
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.45), inset 0 -1px 0 rgba(0,0,0,0.35), 0 3px 6px rgba(0,0,0,0.55)",
} as const;

/** A bevelled panel: hairline frame, a sheen across the top half, lit top edge. */
export const PANEL = {
  borderWidth: 1,
  borderColor: COLORS.rule,
  experimental_backgroundImage: "linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.015) 45%, rgba(0,0,0,0) 46%)",
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.09), inset 0 -1px 0 rgba(0,0,0,0.55)",
} as const;

/** Recessed input field or track, cut into the surface. */
export const WELL = {
  backgroundColor: "rgba(3,6,11,0.7)",
  borderWidth: 1,
  borderColor: COLORS.rule,
  boxShadow: "inset 0 2px 4px rgba(0,0,0,0.7), inset 0 -1px 0 rgba(255,255,255,0.07)",
} as const;

/** Small uppercase technical label (the website's label-tech). */
export const LABEL_TECH = {
  fontFamily: FONTS.display,
  fontSize: 11,
  letterSpacing: 2,
  textTransform: "uppercase",
  color: COLORS.mist,
} as const;
