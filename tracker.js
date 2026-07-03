/* ============================================
   TOUR EXPLORER — Activity Tracker
   Sends login attempts & user activity to
   Google Sheets via Apps Script web app.
   ============================================ */

(function () {
  'use strict';

  // ============================================
  // CONFIGURATION
  // Paste your deployed Google Apps Script URL below.
  // Leave empty to disable tracking (events log to console).
  // ============================================
  const WEBHOOK_URL = '';

  // ---- Internal queue ----
  const _queue = [];
  let _sending = false;

  // ============================================
  // Public API
  // ============================================
  window.__tracker = Object.freeze({

    /**
     * Log a login attempt.
     * @param {string} userName
     * @param {boolean} success
     */
    logLogin(userName, success) {
      _enqueue({
        type: 'login',
        timestamp: _ts(),
        userName: userName,
        success: success,
        userAgent: navigator.userAgent,
      });
    },

    /**
     * Log a user activity (photo view, location open, tab switch, etc.)
     * @param {string} userName
     * @param {string} action   — e.g. "opened_location", "viewed_photo"
     * @param {string} details  — human-readable context
     */
    logActivity(userName, action, details) {
      _enqueue({
        type: 'activity',
        timestamp: _ts(),
        userName: userName,
        action: action,
        details: details || '',
      });
    },
  });

  // ============================================
  // Internals
  // ============================================

  function _ts() {
    return new Date().toISOString();
  }

  function _enqueue(data) {
    if (!WEBHOOK_URL) {
      // No webhook — silent log to console for debugging
      console.debug('[Tracker]', data.type, data);
      return;
    }
    _queue.push(data);
    _flush();
  }

  async function _flush() {
    if (_sending || _queue.length === 0) return;
    _sending = true;

    while (_queue.length > 0) {
      const item = _queue.shift();
      try {
        await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify(item),
          mode: 'no-cors',
        });
      } catch (err) {
        console.debug('[Tracker] Send failed, re-queuing:', err);
        _queue.unshift(item);
        // Back off for 5 seconds before retrying
        await new Promise(r => setTimeout(r, 5000));
        break;
      }
    }

    _sending = false;
  }

  // Flush on page unload
  window.addEventListener('beforeunload', () => {
    if (!WEBHOOK_URL || _queue.length === 0) return;
    // Use sendBeacon for reliable delivery on page close
    for (const item of _queue) {
      try {
        navigator.sendBeacon(WEBHOOK_URL, JSON.stringify(item));
      } catch {}
    }
  });

})();
