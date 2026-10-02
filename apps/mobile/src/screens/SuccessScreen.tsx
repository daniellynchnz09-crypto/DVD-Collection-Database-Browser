import { useEffect, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import IndeterminateBar from "../components/IndeterminateBar";
import { supabase } from "../lib/supabase";
import {
  acknowledgeSubmission,
  getHiddenPendingScanIds,
  getSubmission,
  useSubmissionsVersion,
} from "../lib/backgroundSubmissions";

/**
 * Shown the moment Confirm is tapped (2026-10-03) - the save itself now runs in the
 * background (backgroundSubmissions.ts), so this reads "Scanning..." until it settles, then
 * flips to succeeded (with the shelf-location suggestion, Claude/AIM.md Aim Five) or failed.
 * The button is never disabled: leaving early is the whole point, and the outcome then
 * arrives as App.tsx's banner instead.
 *
 * The button goes to Pending Scans rather than the Scanner whenever other scans are still
 * waiting there (2026-10-03, per the user's own request), so working through a backlog is
 * one tap per scan. Counted the same way PendingScansScreen lists them, minus any scan whose
 * save is still in flight (including this one) - a scan whose save failed counts, since it's
 * genuinely back in the list.
 */
export default function SuccessScreen({
  submissionId,
  onGoToScanner,
  onGoToPending,
}: {
  submissionId: string;
  onGoToScanner: () => void;
  onGoToPending: () => void;
}) {
  const insets = useSafeAreaInsets();
  useSubmissionsVersion();
  const submission = getSubmission(submissionId);
  const status = submission?.status ?? "saving";
  const shelfLocation = submission?.shelfLocation ?? null;

  // Seen here, so the banner shouldn't announce it again once the user leaves.
  useEffect(() => {
    if (status !== "saving") acknowledgeSubmission(submissionId);
  }, [status, submissionId]);

  const [remainingPending, setRemainingPending] = useState(0);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("pending_scans").select("id").in("status", ["resolved", "needs_manual"]);
      if (cancelled) return;
      const saving = getHiddenPendingScanIds();
      setRemainingPending((data ?? []).filter((row) => !saving.has(row.id as string)).length);
    })();
    return () => {
      cancelled = true;
    };
  }, [status]);

  const heading = status === "saving" ? "Scanning..." : status === "succeeded" ? "Scan succeeded" : "Scan failed";
  const headingStyle = status === "saving" ? styles.titleSaving : status === "succeeded" ? styles.title : styles.titleFailed;
  const goToPending = remainingPending > 0;

  return (
    <View style={[styles.container, { paddingTop: 24 + insets.top, paddingBottom: 24 + insets.bottom }]}>
      <Text style={headingStyle}>{heading}</Text>
      {submission?.title ? <Text style={styles.entryTitle}>{submission.title}</Text> : null}
      {status === "saving" ? (
        <>
          <IndeterminateBar />
          <Text style={styles.body}>
            Adding this to the database in the background - you can move on to your next scan now.
          </Text>
        </>
      ) : status === "failed" ? (
        <Text style={styles.body}>
          {submission?.error ? `${submission.error}\n\n` : ""}
          It&apos;s still in Pending Scans with everything you entered, so you can try again from there.
        </Text>
      ) : shelfLocation && (shelfLocation.before || shelfLocation.after) ? (
        <Text style={styles.body}>
          Goes on the shelf{" "}
          {shelfLocation.before ? `after "${shelfLocation.before}"` : ""}
          {shelfLocation.before && shelfLocation.after ? " and " : ""}
          {shelfLocation.after ? `before "${shelfLocation.after}"` : ""}.
        </Text>
      ) : (
        <Text style={styles.body}>No shelf-location suggestion yet - set a Genre Location to get one next time.</Text>
      )}
      <TouchableOpacity style={styles.button} onPress={goToPending ? onGoToPending : onGoToScanner}>
        <Text style={styles.buttonText}>
          {goToPending ? `Next Pending Scan (${remainingPending} left)` : "Back to Scanner"}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#09090b", justifyContent: "center", padding: 24, gap: 16 },
  title: { color: "#4ade80", fontSize: 24, fontWeight: "700", textAlign: "center" },
  titleSaving: { color: "#e4e4e7", fontSize: 24, fontWeight: "700", textAlign: "center" },
  titleFailed: { color: "#f87171", fontSize: 24, fontWeight: "700", textAlign: "center" },
  entryTitle: { color: "#a1a1aa", fontSize: 16, textAlign: "center" },
  body: { color: "#e4e4e7", textAlign: "center" },
  button: {
    backgroundColor: "#0284c7",
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
  },
  buttonText: { color: "#fff", fontWeight: "600" },
});
