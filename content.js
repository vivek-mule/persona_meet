// content.js — ISOLATED world
// Bridges background.js ↔ inject.js (MAIN world) via postMessage.
// Only activates when background.js explicitly sends startBot
// (i.e., user clicked Join in the extension popup).

(function () {
  'use strict';

  const LOG = '[PersonaMeet Content]';
  console.log(LOG, '═══════════════════════════════════════════');
  console.log(LOG, 'CONTENT SCRIPT LOADED');
  console.log(LOG, 'URL:', window.location.href);
  console.log(LOG, '═══════════════════════════════════════════');

  let injectReady = false;
  let pendingAction = null;

  // Send sample.mp3 URL to inject.js immediately and retry to ensure delivery
  const songUrl = chrome.runtime.getURL('sample.mp3');
  console.log(LOG, '🎵 Sending sample.mp3 URL to inject.js:', songUrl);
  
  // Send immediately
  window.postMessage({ type: 'PERSONA_SONG_URL', url: songUrl }, '*');
  
  // Send again after a short delay to catch late listeners
  setTimeout(() => {
    window.postMessage({ type: 'PERSONA_SONG_URL', url: songUrl }, '*');
    console.log(LOG, '🎵 Resent song URL (delayed send for safety)');
  }, 100);
  
  // Send again when inject reports ready
  setTimeout(() => {
    window.postMessage({ type: 'PERSONA_SONG_URL', url: songUrl }, '*');
    console.log(LOG, '🎵 Resent song URL (final send)');
  }, 500);

  // ── Listen for messages from inject.js (MAIN world) ─────────
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;

    if (e.data.type === 'PERSONA_READY') {
      console.log(LOG, 'inject.js reports READY');
      injectReady = true;

      if (pendingAction) {
        console.log(LOG, 'Sending queued action:', pendingAction);
        window.postMessage({ type: pendingAction }, '*');
        pendingAction = null;
      }
    }

    // Forward status updates from inject.js → background.js
    if (e.data.type === 'PERSONA_STATUS') {
      console.log(LOG, 'Forwarding status →', e.data.status, '—', e.data.message);
      try {
        chrome.runtime.sendMessage(e.data)
          .then((response) => {
            if (response && response.received) {
              console.log(LOG, '✓ Background confirmed receipt of status');
            } else {
              console.log(LOG, '⚠️ Background did not confirm receipt');
            }
          })
          .catch((err) => {
            console.warn(LOG, 'Could not forward status to background:', err.message);
          });
      } catch (err) {
        // "Extension context invalidated" — happens when Meet navigates away on meeting end.
        // background.js has a backup tab-navigation listener that handles this.
        console.warn(LOG, 'Extension context invalidated — background will detect meeting end via tab listener.');
      }
    }
  });

  // ── Listen for commands from background.js ──────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // Ignore messages meant for offscreen
    if (msg.target === 'offscreen') return;

    if (msg.action === 'startBot') {
      console.log(LOG, 'Received startBot from background');
      sendToInject('PERSONA_START');
      sendResponse({ ok: true });
    } else if (msg.action === 'stopBot') {
      console.log(LOG, 'Received stopBot from background');
      sendToInject('PERSONA_STOP');
      sendResponse({ ok: true });
    }
    return true;
  });

  // NOTE: We do NOT auto-start from storage. The bot only starts
  // when background.js explicitly sends startBot (via the popup).

  function sendToInject(type) {
    if (injectReady) {
      console.log(LOG, 'Posting to inject.js:', type);
      window.postMessage({ type }, '*');
    } else {
      console.log(LOG, 'inject.js not ready — queuing:', type);
      pendingAction = type;
    }
  }
})();
