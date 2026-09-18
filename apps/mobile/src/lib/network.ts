import { useEffect, useState } from "react";
import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";

/**
 * "Offline" here specifically means no real INTERNET access, not just "no network interface
 * up" - the phone and this app's own backend server (apps/web, run over the LAN on a home
 * WiFi network) can both be perfectly reachable to each other even when the wider internet is
 * down (e.g. the home router's own WAN connection drops but the LAN itself stays up), which is
 * exactly the scenario this feature exists for: barcode queueing (a LAN-only call) should keep
 * working, while anything needing the real internet (OMDB/TMDb/UPCitemdb/Gemini/Estimated
 * Value) won't. `isInternetReachable` is NetInfo's own active reachability probe (distinct
 * from `isConnected`, which only reflects whether a network interface is up at all) - exactly
 * the distinction this feature needs. Treated as online whenever it isn't explicitly `false`
 * (i.e. `null`/undecided reads as online) - a brief "don't know yet" moment right after the
 * app starts shouldn't itself trigger the offline banner/queueing path.
 */
function resolveIsOnline(state: NetInfoState): boolean {
  return state.isInternetReachable !== false;
}

/** Live-updating online/offline status, for the global banner and any screen that wants to
 * gate a button/action on it reactively. */
export function useIsOnline(): boolean {
  const [isOnline, setIsOnline] = useState(true);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => setIsOnline(resolveIsOnline(state)));
    NetInfo.fetch().then((state) => setIsOnline(resolveIsOnline(state)));
    return unsubscribe;
  }, []);

  return isOnline;
}

/** One-off imperative check - for a submit handler that needs the current status right at the
 * moment of a button press, not a subscription. */
export async function getIsOnline(): Promise<boolean> {
  const state = await NetInfo.fetch();
  return resolveIsOnline(state);
}

/** Fires `onReconnect` exactly when the connection transitions from offline to online (never
 * on the initial fetch, and never on an online->online or offline->offline "change" that
 * NetInfo can still emit for other reasons, e.g. switching from WiFi to cellular while
 * already online) - the trigger for automatically flushing the offline submission queue. */
export function subscribeToReconnect(onReconnect: () => void): () => void {
  let lastKnownOnline: boolean | null = null;
  return NetInfo.addEventListener((state) => {
    const isOnline = resolveIsOnline(state);
    if (lastKnownOnline === false && isOnline === true) onReconnect();
    lastKnownOnline = isOnline;
  });
}
