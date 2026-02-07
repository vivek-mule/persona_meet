// inject.js — MAIN world content script
// Handles Google Meet automation: disable mic/camera, click Join, detect meeting end.
// Audio recording is handled separately by the offscreen document via tabCapture.

// Immediate initialization log to confirm script is loading
console.log('[PersonaMeet] ✓✓✓ inject.js INITIALIZING ✓✓✓');

(function () {
  'use strict';

  const LOG = '[PersonaMeet]';
  console.log(LOG, '🚀 Script started — URL:', window.location.href);
  let botActive = false;

  // ─── Transcription (optional — works if audio plays through speakers) ──
  let recognition = null;
  let fullTranscript = '';
  let transcriptLines = [];

  // ─── Message handling ─────────────────────────────────────────
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || !e.data.type) return;

    if (e.data.type === 'PERSONA_START') {
      if (!botActive) {
        botActive = true;
        log('Received PERSONA_START');
        runBot();
      }
    }

    if (e.data.type === 'PERSONA_STOP') {
      log('Received PERSONA_STOP');
      botActive = false;
      stopTranscription();
      sendStatus('stopped', 'Bot stopped');
    }
  });

  // Signal readiness
  window.postMessage({ type: 'PERSONA_READY' }, '*');
  log('inject.js loaded and READY  (v3.0 — tabCapture recording)');

  // ─── Bot flow ─────────────────────────────────────────────────
  async function runBot() {
    sendStatus('starting', 'Bot initialising…');
    log('══════════════════════════════════');
    log('BOT STARTING');
    log('══════════════════════════════════');

    try {
      // 1. Wait for page to fully load first
      log('Step 1: Waiting for page to load completely…');
      await waitFor(
        () => document.readyState === 'complete',
        30000,
        'page load'
      );
      log('✓ Page readyState is complete');

      // 2. Wait for UI to settle
      log('Step 2: Waiting 4s for UI framework to initialize…');
      await sleep(4000);

      // 3. Wait for pre-join screen to render
      log('Step 3: Detecting pre-join UI elements…');
      await waitFor(
        () => findToggleButton('microphone') || findToggleButton('camera') || findJoinButton(),
        40000,
        'pre-join UI'
      );
      log('✓ Pre-join UI detected');

      // 4. Additional wait to ensure buttons are fully interactive
      log('Step 4: Waiting 5s for buttons to become fully interactive…');
      await sleep(5000);
      log('✓ Buttons should now be ready');

      // 5. Disable mic & camera BEFORE joining
      log('Step 5: Disabling mic & camera (pre-join)…');
      await disableWithRetry('microphone', 8);
      log('✓ Microphone disabled');
      await sleep(1000);
      await disableWithRetry('camera', 8);
      log('✓ Camera disabled');

      // 6. Wait before clicking Join to ensure toggles are processed
      log('Step 6: Waiting 2s for toggle states to settle…');
      await sleep(2000);
      log('✓ Ready to join');

      sendStatus('joining', 'Clicking Join…');

      // 7. Click Join / Ask to Join
      log('Step 7: Clicking Join Now / Ask to Join…');
      await clickJoin();
      log('✓ Join button clicked — waiting for meeting to load…');

      // 8. Wait for the meeting to fully load
      log('Step 8: Waiting 10s for in-meeting UI to fully load…');
      await sleep(10000);
      log('✓ Meeting UI should be loaded');

      // 9. Re-verify mic & camera are OFF inside the meeting
      log('Step 9: Re-verifying mic & camera are OFF (in-meeting)…');
      await disableWithRetry('microphone', 5);
      log('✓ Microphone verified OFF');
      await sleep(500);
      await disableWithRetry('camera', 5);
      log('✓ Camera verified OFF');

      // 10. Report "joined" so background starts tab capture
      log('Step 10: Reporting JOINED status to background…');
      sendStatus('joined', 'In meeting — starting audio capture…');
      log('✓ Status "joined" sent — background will now start tab audio capture');
      log('══════════════════════════════════');
      log('AUDIO CAPTURE STARTING');
      log('Watch for "[PersonaMeet BG]" and "[PersonaMeet Offscreen]" logs');
      log('══════════════════════════════════');

      // 11. Start optional speech recognition
      log('Step 11: Starting optional speech recognition…');
      startTranscription();

      // 12. Monitor for meeting end
      log('Step 12: Starting meeting-end monitor…');
      monitorMeetingEnd();

      log('══════════════════════════════════');
      log('BOT FULLY OPERATIONAL');
      log('All participants\' audio is being captured via tabCapture');
      log('══════════════════════════════════');

    } catch (err) {
      logError('Bot error:', err);
      sendStatus('error', err.message);
    }
  }

  // ─── Mic & Camera Control ─────────────────────────────────────

  async function disableWithRetry(type, maxAttempts) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      log(type, '— attempt', attempt + '/' + maxAttempts);
      const result = await tryDisable(type);
      if (result === 'off' || result === 'already-off') {
        log(type, '— ✓ Success on attempt', attempt);
        return; // success
      }
      if (attempt < maxAttempts) {
        log(type, '— retry in 1.5s…');
        await sleep(1500);
      }
    }
    log(type, '— ⚠️ Could not confirm OFF after', maxAttempts, 'attempts');
  }

  async function tryDisable(type) {
    const btn = findToggleButton(type);
    if (!btn) {
      log(type, '❌ toggle button not found');
      return 'not-found';
    }

    const labels = getAllLabels(btn);
    log(type, '✓ button found — labels:', JSON.stringify(labels));

    // "Turn off X" → currently ON, click to turn OFF
    if (labels.includes('turn off')) {
      btn.click();
      log(type, 'turned OFF via button click');
      await sleep(400);
      return 'off';
    }

    // "Turn on X" or "is off" → already OFF
    if (labels.includes('turn on') || labels.includes('is off')) {
      log(type, 'already OFF');
      return 'already-off';
    }

    // Unknown state
    log(type, 'state unclear from labels');
    return 'unknown';
  }

  /**
   * Find the toggle button for mic or camera on Meet's UI.
   * Carefully excludes "settings" / "options" buttons.
   */
  function findToggleButton(type) {
    const els = document.querySelectorAll(
      'button, [role="button"], [data-is-muted]'
    );

    for (const el of els) {
      const label = getAllLabels(el);

      // Skip settings, options, effects, tile buttons
      if (
        label.includes('settings') ||
        label.includes('option') ||
        label.includes('effect') ||
        label.includes('layout') ||
        label.includes('tile')
      ) {
        continue;
      }

      if (type === 'microphone') {
        if (label.includes('microphone') || label.includes(' mic ') || label.match(/\bmic\b/)) {
          return el;
        }
      }

      if (type === 'camera') {
        // Match "camera" directly
        if (label.includes('camera')) return el;

        // Match "turn off/on video" but not generic "video" buttons
        if (
          label.includes('video') &&
          (label.includes('turn off') || label.includes('turn on'))
        ) {
          return el;
        }
      }
    }
    return null;
  }

  function getAllLabels(el) {
    return [
      el.getAttribute('aria-label') || '',
      el.getAttribute('data-tooltip') || '',
      el.getAttribute('title') || '',
    ]
      .join(' ')
      .toLowerCase();
  }

  // ─── Join Button ──────────────────────────────────────────────

  function findJoinButton() {
    const targets = ['join now', 'ask to join'];

    for (const btn of document.querySelectorAll('button')) {
      const text = (btn.innerText || '').trim().toLowerCase();
      if (targets.some((t) => text.includes(t))) return btn;
    }
    for (const span of document.querySelectorAll('button span')) {
      const text = (span.innerText || '').trim().toLowerCase();
      if (targets.some((t) => text.includes(t))) return span.closest('button');
    }
    return null;
  }

  function clickJoin() {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const MAX = 40;

      const iv = setInterval(() => {
        attempts++;
        dismissPopups();

        const btn = findJoinButton();
        if (btn) {
          log('Join button found:', (btn.innerText || '').trim());
          btn.click();
          log('Join button CLICKED');
          clearInterval(iv);
          resolve();
          return;
        }

        if (attempts % 10 === 0) {
          log('Still looking for Join button — attempt', attempts + '/' + MAX);
        }
        if (attempts >= MAX) {
          clearInterval(iv);
          reject(new Error('Join button not found within ' + MAX + ' s'));
        }
      }, 1000);
    });
  }

  function dismissPopups() {
    const dismiss = ['got it', 'dismiss', 'close', 'ok', 'no thanks'];
    for (const btn of document.querySelectorAll('button')) {
      const text = (btn.innerText || '').trim().toLowerCase();
      if (dismiss.includes(text)) {
        btn.click();
        log('Dismissed popup:', text);
      }
    }
  }

  // ─── Meeting End Detection ────────────────────────────────────

  function monitorMeetingEnd() {
    log('Meeting-end monitor active');

    const observer = new MutationObserver(() => {
      if (isMeetingOver()) {
        observer.disconnect();
        handleMeetingEnd();
      }
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });

    // Backup periodic check
    const iv = setInterval(() => {
      if (!botActive) { clearInterval(iv); return; }
      if (isMeetingOver()) {
        clearInterval(iv);
        observer.disconnect();
        handleMeetingEnd();
      }
    }, 5000);
  }

  function isMeetingOver() {
    const text = (document.body && document.body.innerText) || '';
    return (
      text.includes('You left the meeting') ||
      text.includes('The meeting has ended') ||
      text.includes("You've been removed from the meeting") ||
      text.includes('You were removed from this meeting') ||
      text.includes('Return to home screen')
    );
  }

  function handleMeetingEnd() {
    if (!botActive) return;
    log('══════════════════════════════════');
    log('MEETING ENDED');
    log('══════════════════════════════════');

    botActive = false;
    stopTranscription();
    
    log('Sending "ended" status to background...');
    sendStatus('ended', 'Meeting ended — saving recording…');
    
    // Give background time to process and stop recording
    setTimeout(() => {
      log('If no file downloaded, check background service worker logs.');
      log('Open chrome://extensions → PersonaMeet → Service Worker "Inspect views"');
    }, 3000);
  }

  // ─── Speech Recognition (bonus — uses physical mic) ───────────
  
  let recognitionStoppingIntentionally = false;

  function startTranscription() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      log('SpeechRecognition not available — audio will be in downloaded .webm file');
      return;
    }

    try {
      recognition = new SR();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onstart = () => log('SpeechRecognition started (uses physical mic)');

      recognition.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const text = event.results[i][0].transcript.trim();
          if (event.results[i].isFinal && text) {
            const ts = new Date().toLocaleTimeString();
            const line = '[' + ts + '] ' + text;
            transcriptLines.push(line);
            fullTranscript += line + '\n';
            console.log(
              '%c' + LOG + ' TRANSCRIPT: ' + line,
              'color: #4CAF50; font-weight: bold; font-size: 13px;'
            );
          }
        }
      };

      recognition.onerror = (event) => {
        // Ignore "no-speech" timeouts - they're normal
        if (event.error === 'no-speech') {
          return;
        }
        
        // Ignore "aborted" if we're stopping intentionally
        if (event.error === 'aborted') {
          if (recognitionStoppingIntentionally) {
            log('SpeechRecognition stopped intentionally');
            recognitionStoppingIntentionally = false;
            return;
          }
        }
        
        // Log other real errors
        if (event.error !== 'aborted') {
          logError('SpeechRecognition error:', event.error);
        }
        
        // Auto-restart only if bot is still active and error is recoverable
        if (['audio-capture'].includes(event.error) && botActive) {
          log('Attempting to restart SpeechRecognition in 3s...');
          setTimeout(() => { if (botActive) safeStartSR(); }, 3000);
        }
      };

      recognition.onend = () => {
        // Only restart if bot is still active and not stopping intentionally
        if (botActive && !recognitionStoppingIntentionally) {
          setTimeout(() => { if (botActive) safeStartSR(); }, 2000);
        }
      };

      safeStartSR();
    } catch (err) {
      logError('SpeechRecognition init failed:', err);
    }
  }

  function safeStartSR() {
    try { recognition.start(); } catch (_) { /* already started */ }
  }

  function stopTranscription() {
    if (recognition) {
      log('Stopping SpeechRecognition...');
      recognitionStoppingIntentionally = true;
      try { 
        recognition.abort(); 
      } catch (err) { 
        log('Error aborting recognition:', err.message);
      }
      recognition = null;
    }

    if (transcriptLines.length > 0) {
      console.log('%c' + LOG + ' ════════════════════════════════════════', 'color:#2196F3;font-weight:bold;');
      console.log('%c' + LOG + ' FULL TRANSCRIPT (' + transcriptLines.length + ' lines):', 'color:#2196F3;font-weight:bold;font-size:14px;');
      transcriptLines.forEach((l) => console.log('%c' + LOG + ' ' + l, 'color:#4CAF50;'));
      console.log('%c' + LOG + ' ════════════════════════════════════════', 'color:#2196F3;font-weight:bold;');

      downloadTranscript();
    } else {
      log('No transcript from SpeechRecognition. Full audio is in the downloaded .webm file.');
    }
  }

  function downloadTranscript() {
    if (!fullTranscript) return;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = 'meeting-transcript-' + ts + '.txt';
    const blob = new Blob([fullTranscript], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    log('Transcript downloaded:', filename);
  }

  // ─── Utilities ────────────────────────────────────────────────

  function waitFor(predicate, timeout, label) {
    return new Promise((resolve, reject) => {
      if (predicate()) return resolve();
      const obs = new MutationObserver(() => {
        if (predicate()) { obs.disconnect(); resolve(); }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); reject(new Error(label + ' timeout (' + timeout + 'ms)')); }, timeout);
    });
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function sendStatus(status, message) {
    window.postMessage({ type: 'PERSONA_STATUS', status, message }, '*');
  }

  function log(...args) { console.log(LOG, ...args); }
  function logError(...args) { console.error(LOG, ...args); }
})();
