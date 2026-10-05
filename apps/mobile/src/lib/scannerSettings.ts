import { useCallback, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Scanner screen settings, persisted on-device (AsyncStorage, same store confirmDrafts.ts and
 * offlineQueue.ts use) so a choice survives the app closing. Added 2026-10-04 with automatic
 * barcode capture (see ScannerScreen.tsx): `manualBarcodeCaptureOnly` turns that off again and
 * restores the previous behaviour, where a barcode only joins a scan after "Capture Barcode" is
 * tapped - per the user's own request, so they can choose not to spend UPC lookup credits on
 * every cover scan that happens to show a barcode.
 */
export interface ScannerSettings {
  manualBarcodeCaptureOnly: boolean;
}

const STORAGE_KEY = "scannerSettings";
const DEFAULTS: ScannerSettings = { manualBarcodeCaptureOnly: false };

export async function loadScannerSettings(): Promise<ScannerSettings> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<ScannerSettings>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

/** Current settings plus an updater that saves the change immediately. `loaded` stays false
 * until the stored value has been read, so callers can avoid acting on the defaults first. */
export function useScannerSettings() {
  const [settings, setSettings] = useState<ScannerSettings>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadScannerSettings().then((s) => {
      if (cancelled) return;
      setSettings(s);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback((patch: Partial<ScannerSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch((err) => {
        console.warn("Failed to save scanner settings (non-fatal):", err);
      });
      return next;
    });
  }, []);

  return { settings, loaded, update };
}
