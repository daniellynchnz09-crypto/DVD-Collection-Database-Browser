import { isCustomBurnFormat, stripCustomBurnFormat, toCustomBurnFormat } from "@danflix/shared";

/** Wiring for the Format section's "Custom burn" checkbox (2026-10-22). The checkbox is
 * derived from the format text itself, so what it shows always matches what gets saved:
 * ticking it turns the picked format into its custom-burn equivalent ("Blu-Ray" ->
 * "Blu-Ray (Custom Burn)", reusing an existing value's spelling or creating a new one),
 * unticking turns it back, and a quick-pick button keeps the box's state. Picking a plain
 * format from the "Something else" list is an explicit choice, so it unticks the box. */
export function customBurnFormatControls(format: string, setFormat: (format: string) => void, knownFormats: string[]) {
  const customBurn = isCustomBurnFormat(format);
  return {
    customBurn,
    /** For BigChoice, so "DVD" stays highlighted while the format is "DVD (Custom Burn)". */
    baseFormat: stripCustomBurnFormat(format),
    toggleCustomBurn() {
      // DVD is the scanner's own default format, so ticking with nothing picked yet means a burned DVD.
      setFormat(customBurn ? stripCustomBurnFormat(format) : toCustomBurnFormat(format.trim() || "DVD", knownFormats));
    },
    chooseFormat(value: string) {
      setFormat(customBurn ? toCustomBurnFormat(value, knownFormats) : value);
    },
  };
}
