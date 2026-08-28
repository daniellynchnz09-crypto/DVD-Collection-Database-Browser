/**
 * Sheet -> DB half of the bidirectional sync (Claude/TECH STACK AND ARCHITECTURE.md's
 * "GOOGLE SHEET SYNC" section). This file lives in the repo for reference/version
 * history only - Apps Script itself runs inside the Google Sheet, so you need to paste
 * this into the Sheet's own script editor. It is NOT run by anything in this codebase.
 *
 * SETUP (one-time):
 *   1. Open the Sheet -> Extensions -> Apps Script.
 *   2. Delete the default empty Code.gs content and paste this whole file in.
 *   3. Fill in WEBHOOK_URL and SCAN_API_SECRET below (same value as apps/web/.env.local's
 *      SCAN_API_SECRET - never commit the real secret into this file if you ever share it,
 *      since Apps Script projects aren't covered by this repo's .gitignore).
 *   4. In the left sidebar, click the clock icon ("Triggers") -> "+ Add Trigger".
 *      - Function to run: handleSheetEdit
 *      - Event source: From spreadsheet
 *      - Event type: On edit
 *      Save it (you'll be asked to authorize the script - this is expected, it's your
 *      own script calling your own backend).
 *
 * IMPORTANT: this function is deliberately NOT named `onEdit`. Apps Script auto-runs any
 * function literally named `onEdit` as a "simple trigger", and simple triggers are not
 * allowed to make external HTTP calls (UrlFetchApp) - which is the entire point of this
 * script. Using an *installable* trigger (step 4 above) on a differently-named function
 * is what makes the webhook call actually work.
 */

var WEBHOOK_URL = "https://YOUR-DEPLOYED-APP.vercel.app/api/sheet-webhook"; // or http://localhost:3000/api/sheet-webhook while testing locally on the same network
var SCAN_API_SECRET = "PASTE_YOUR_SCAN_API_SECRET_HERE";
var SHEET_NAME = "Sheet1";

function handleSheetEdit(e) {
  if (!e || !e.range) return;
  var sheet = e.range.getSheet();
  if (sheet.getName() !== SHEET_NAME) return;

  var editedRow = e.range.getRow();
  if (editedRow === 1) return; // header-row edits don't need syncing

  var lastCol = sheet.getLastColumn();
  var header = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var rowValues = sheet.getRange(editedRow, 1, 1, lastCol).getValues()[0];

  var response;
  try {
    response = UrlFetchApp.fetch(WEBHOOK_URL, {
      method: "post",
      contentType: "application/json",
      headers: { "x-scan-secret": SCAN_API_SECRET },
      payload: JSON.stringify({ header: header, row: rowValues }),
      muteHttpExceptions: true,
    });
  } catch (err) {
    console.error("sheet-webhook call failed: " + err);
    return;
  }

  if (response.getResponseCode() !== 200) {
    console.error("sheet-webhook returned " + response.getResponseCode() + ": " + response.getContentText());
    return;
  }

  var result = JSON.parse(response.getContentText());
  if (result.isNew && result.uniqueId) {
    var uniqueIdColIndex = -1;
    for (var i = 0; i < header.length; i++) {
      if (String(header[i]).trim().toLowerCase() === "unique identifier") {
        uniqueIdColIndex = i;
        break;
      }
    }
    if (uniqueIdColIndex !== -1) {
      sheet.getRange(editedRow, uniqueIdColIndex + 1).setValue(result.uniqueId);
    }
  }
}
