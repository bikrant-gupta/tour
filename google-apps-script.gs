/**
 * ============================================
 * TOUR EXPLORER — Google Apps Script Logger
 * ============================================
 *
 * SETUP INSTRUCTIONS:
 *
 * 1. Open Google Sheets → create a new blank spreadsheet.
 * 2. Go to  Extensions → Apps Script.
 * 3. Delete any existing code and paste THIS entire file.
 * 4. Click  Deploy → New deployment.
 *      • Type:           Web app
 *      • Execute as:     Me  (your account)
 *      • Who has access:  Anyone
 * 5. Click "Deploy" and authorize when prompted.
 * 6. Copy the Web app URL.
 * 7. Open  tracker.js  in your project and paste the URL
 *    into the  WEBHOOK_URL  constant.
 *
 * That's it — login attempts and photo views will now
 * appear in two sheets: "Access Log" and "Activity Log".
 */

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var ss   = SpreadsheetApp.getActiveSpreadsheet();

    if (data.type === 'login') {
      var sheet = _getOrCreateSheet(ss, 'Access Log',
        ['Timestamp', 'User Name', 'Success', 'User Agent']);

      sheet.appendRow([
        data.timestamp || new Date().toISOString(),
        data.userName  || 'Unknown',
        data.success   ? 'Yes' : 'No',
        (data.userAgent || '').substring(0, 200)
      ]);
    }
    else if (data.type === 'activity') {
      var sheet = _getOrCreateSheet(ss, 'Activity Log',
        ['Timestamp', 'User Name', 'Action', 'Details']);

      sheet.appendRow([
        data.timestamp || new Date().toISOString(),
        data.userName  || 'Unknown',
        data.action    || '',
        (data.details  || '').substring(0, 500)
      ]);
    }

    return ContentService
      .createTextOutput(JSON.stringify({ status: 'ok' }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'error', message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({
      status: 'ok',
      message: 'Tour Explorer Logger is running'
    }))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Helper: get sheet by name or create with headers */
function _getOrCreateSheet(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length)
      .setFontWeight('bold')
      .setBackground('#f59e0b')
      .setFontColor('#000000');
    sheet.setFrozenRows(1);
  }
  return sheet;
}
