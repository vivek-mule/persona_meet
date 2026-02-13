// background.js — Service Worker
// Orchestrates: popup → tab creation → content script → tab capture → offscreen recording → download.

const LOG = '[PersonaMeet BG]';

// Log immediately to confirm service worker is alive
console.log(LOG, '═══════════════════════════════════════════════════════');
console.log(LOG, '🚀 SERVICE WORKER STARTED');
console.log(LOG, 'Timestamp:', new Date().toISOString());
console.log(LOG, '═══════════════════════════════════════════════════════');

let managedTabId = null;    // the Meet tab opened by the extension
let recordingActive = false;
let recordingStartTime = null;
let offscreenReady = false;
let pendingStreamId = null;  // stream ID obtained before navigation (while activeTab is valid)

// ─── Message router ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Log ALL incoming messages for debugging
  console.log(LOG, '📨 Message received:', JSON.stringify(msg), 'from:', sender.tab ? 'tab ' + sender.tab.id : 'extension');
  // ── From popup: open a Meet URL ─────────────────────────────
  if (msg.action === 'openMeet') {
    // Get the tab where popup was opened (it has activeTab permission!)
    chrome.tabs.query({ active: true, currentWindow: true })
      .then(tabs => {
        if (tabs.length === 0) {
          throw new Error('No active tab found');
        }
        // Navigate THAT tab instead of creating a new one
        return handleOpenMeet(msg.url, tabs[0].id);
      })
      .then((res) => sendResponse(res))
      .catch((err) => {
        console.error(LOG, 'openMeet error:', err);
        sendResponse({ error: err.message });
      });
    return true; // async
  }

  // ── From content/inject: status updates ─────────────────────
  if (msg.type === 'PERSONA_STATUS') {
    console.log(LOG, '═══════════════════════════════════════════════════════');
    console.log(LOG, '📊 STATUS UPDATE');
    console.log(LOG, '  Status:', msg.status);
    console.log(LOG, '  Message:', msg.message);
    console.log(LOG, '  Managed tab:', managedTabId);
    console.log(LOG, '═══════════════════════════════════════════════════════');
    
    chrome.storage.local.set({ botStatus: msg });

    // When inject.js says it has joined the meeting, start tab capture
    if (msg.status === 'joined') {
      console.log(LOG, '🎯 JOINED STATUS RECEIVED');
      console.log(LOG, '   Managed tab ID:', managedTabId);
      console.log(LOG, '   Recording already active:', recordingActive);
      if (recordingActive) {
        console.log(LOG, '   ✓ Recording was already started pre-navigation — nothing to do');
        chrome.storage.local.set({
          botStatus: { type: 'PERSONA_STATUS', status: 'recording', message: 'Recording meeting audio…' },
        });
      } else {
        console.log(LOG, '   ⚠️ Recording not active — attempting late start…');
        startTabCapture();
      }
    }

    // When meeting ends, stop recording
    if (msg.status === 'ended' || msg.status === 'stopped') {
      console.log(LOG, '🛑 Meeting ended — stopping recording');
      stopRecording();
    }
    sendResponse({ received: true });
    return false;
  }

  //── From offscreen: recording started ───────────────────────
  if (msg.target === 'background' && msg.action === 'recordingStarted') {
    console.log(LOG, '✅✅✅ RECORDING CONFIRMED ACTIVE ✅✅✅');
    console.log(LOG, 'Offscreen confirms: recording started successfully');
    recordingActive = true;
    recordingStartTime = Date.now();
    chrome.storage.local.set({
      botStatus: { type: 'PERSONA_STATUS', status: 'recording', message: 'Recording meeting audio…' },
    });
    startRecordingMonitor();
    return false;
  }

  // ── From offscreen: recording error ─────────────────────────
  if (msg.target === 'background' && msg.action === 'recordingError') {
    console.error(LOG, 'Recording error from offscreen:', msg.error);
    chrome.storage.local.set({
      botStatus: { type: 'PERSONA_STATUS', status: 'error', message: 'Recording failed: ' + msg.error },
    });
    return false;
  }

  // ── From offscreen: download the recorded file ──────────────
  if (msg.target === 'background' && msg.action === 'downloadRecording') {
    console.log(LOG, 'Download request — file:', msg.filename);
    console.log(LOG, '═══════════════════════════════════════════════════════');
    console.log(LOG, '💾 DOWNLOADING RECORDING');
    console.log(LOG, '  Filename:', msg.filename);
    console.log(LOG, '  Data URL length:', msg.dataUrl.length);
    console.log(LOG, '═══════════════════════════════════════════════════════');
    
    chrome.downloads.download(
      { url: msg.dataUrl, filename: msg.filename, saveAs: false },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error(LOG, '❌ Download failed:', chrome.runtime.lastError.message);
        } else {
          console.log(LOG, '✅ Download started — id:', downloadId);
          console.log(LOG, '📂 Check your Downloads folder');
        }
        cleanupOffscreen();
        chrome.storage.local.set({
          botStatus: {
            type: 'PERSONA_STATUS',
            status: 'completed',
            message: 'Recording saved! Check your Downloads folder.',
          },
        });
      }
    );
    return false;
  }

  // ── From offscreen: recording complete (no data or error) ───
  if (msg.target === 'background' && msg.action === 'recordingComplete') {
    console.log(LOG, 'Recording complete — hasData:', msg.hasData);
    if (!msg.hasData) {
      chrome.storage.local.set({
        botStatus: {
          type: 'PERSONA_STATUS',
          status: 'completed',
          message: 'Meeting ended — no audio was captured.',
        },
      });
    }
    cleanupOffscreen();
    return false;
  }

  return false;
});

// ─── Tab close detection ────────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === managedTabId) {
    console.log(LOG, 'Managed Meet tab closed — stopping recording');
    stopRecording();
    managedTabId = null;
    chrome.storage.local.set({
      botStatus: {
        type: 'PERSONA_STATUS',
        status: 'completed',
        message: 'Tab closed — recording saved.',
      },
    });
  }
});

// ─── Core flow ──────────────────────────────────────────────────

async function handleOpenMeet(url, activeTabId) {
  console.log(LOG, 'Opening Meet URL:', url);
  console.log(LOG, 'Active tab ID (with permission):', activeTabId);

  // If there's already a managed tab, clean up first
  if (managedTabId !== null) {
    console.log(LOG, 'Cleaning up previous session');
    stopRecording();
  }

  managedTabId = activeTabId;

  // CRITICAL: Get tabCapture stream ID NOW, while activeTab permission is still valid.
  // After navigation, activeTab is revoked and getMediaStreamId will fail.
  console.log(LOG, '1. Getting tabCapture stream ID (activeTab still valid)…');
  let streamId = null;
  try {
    streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId(
        { targetTabId: activeTabId },
        (id) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (!id) {
            reject(new Error('getMediaStreamId returned empty ID'));
          } else {
            resolve(id);
          }
        }
      );
    });
    console.log(LOG, '   ✓ Got stream ID (length:', streamId.length + ')');
  } catch (err) {
    console.error(LOG, '   ⚠️ Could not get stream ID:', err.message);
  }

  // CRITICAL: Start capture IMMEDIATELY — before navigating the tab.
  // The stream ID is a one-time token that expires/invalidates after navigation.
  // Once getUserMedia establishes the capture stream, it persists across navigations
  // because tab capture operates at the browser level, not the page level.
  if (streamId) {
    console.log(LOG, '2. Starting tab capture BEFORE navigation…');
    try {
      // Create offscreen document
      if (!offscreenReady) {
        try {
          await chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['USER_MEDIA'],
            justification: 'Recording Google Meet tab audio',
          });
          offscreenReady = true;
          console.log(LOG, '   ✓ Offscreen document created');
        } catch (err) {
          if (err.message.includes('single offscreen')) {
            offscreenReady = true;
            console.log(LOG, '   ✓ Offscreen document already exists');
          } else {
            throw err;
          }
        }
      }

      // Wait for offscreen JS to load
      await sleep(500);

      // Tell offscreen to start capturing the tab audio
      await chrome.runtime.sendMessage({
        target: 'offscreen',
        action: 'startCapture',
        streamId: streamId,
      });
      console.log(LOG, '   ✓ Capture started (recording pre-navigation tab audio)');

      // Give a moment for getUserMedia to establish the stream
      await sleep(500);
    } catch (err) {
      console.error(LOG, '   ⚠️ Pre-navigation capture failed:', err.message);
    }
  } else {
    console.warn(LOG, '2. No stream ID — will attempt capture after bot joins (may fail)');
    pendingStreamId = null;
  }

  // NOW navigate the ACTIVE tab to the Meet URL
  console.log(LOG, '3. Navigating tab to Meet URL…');
  const tab = await chrome.tabs.update(activeTabId, { url, active: true });
  managedTabId = tab.id;
  console.log(LOG, '   ✓ Tab navigated — id:', tab.id);

  // Store managed tab ID so content script knows this is extension-managed
  await chrome.storage.local.set({ managedTabId: tab.id, botStatus: null });

  // Wait for tab to fully load
  await waitForTabLoad(tab.id);
  console.log(LOG, '   ✓ Tab fully loaded');

  // Send startBot to content script (with retries)
  await sendStartBot(tab.id);

  return { status: 'opening', tabId: tab.id };
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab load timeout'));
    }, 30000);

    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function sendStartBot(tabId) {
  // Give more time for inject.js to load (MAIN world scripts load slower)
  console.log(LOG, 'Waiting 3s before sending startBot to allow scripts to initialize…');
  await sleep(3000);
  
  for (let i = 1; i <= 25; i++) {
    try {
      await chrome.tabs.sendMessage(tabId, { action: 'startBot' });
      console.log(LOG, '✓ startBot delivered on attempt', i);
      return;
    } catch (err) {
      console.log(LOG, `startBot attempt ${i}/25:`, err.message);
      await sleep(1000);
    }
  }
  console.error(LOG, '❌ Failed to deliver startBot after 25 attempts');
}

// ─── Tab Capture + Offscreen ────────────────────────────────────

async function startTabCapture() {
  if (!managedTabId) {
    console.error(LOG, 'No managed tab — cannot capture');
    return;
  }
  if (recordingActive) {
    console.log(LOG, 'Recording already active');
    return;
  }

  console.log(LOG, '═══════════════════════════════════════════');
  console.log(LOG, 'STARTING TAB AUDIO CAPTURE');
  console.log(LOG, '═══════════════════════════════════════════');

  try {
    // 0. Verify tab is on correct domain
    console.log(LOG, '0. Verifying tab information…');
    const tab = await chrome.tabs.get(managedTabId);
    console.log(LOG, '   Tab URL:', tab.url);
    console.log(LOG, '   Tab status:', tab.status);
    
    if (!tab.url || !tab.url.startsWith('https://meet.google.com/')) {
      throw new Error('Tab is not on meet.google.com yet. URL: ' + (tab.url || 'unknown'));
    }
    console.log(LOG, '✓ Tab is on Meet domain');

    // 1. Use the pre-navigation stream ID (obtained while activeTab was valid)
    console.log(LOG, '1. Checking for pre-obtained stream ID…');
    
    if (!pendingStreamId) {
      // Fallback: try to get stream ID directly (may fail without activeTab)
      console.log(LOG, '   No pre-obtained stream ID — trying direct capture…');
      try {
        pendingStreamId = await new Promise((resolve, reject) => {
          chrome.tabCapture.getMediaStreamId(
            { targetTabId: managedTabId },
            (id) => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
              } else if (!id) {
                reject(new Error('getMediaStreamId returned empty ID'));
              } else {
                resolve(id);
              }
            }
          );
        });
      } catch (err) {
        throw new Error('Cannot capture tab audio: ' + err.message + '. Ensure you click the extension icon before joining.');
      }
    }
    
    const streamId = pendingStreamId;
    pendingStreamId = null; // consume it (one-time use)
    
    console.log(LOG, '✓ Got stream ID (length:', streamId.length + ')');
    console.log(LOG, '   StreamID preview:', streamId.substring(0, 50) + '…');

    // 2. Create offscreen document if needed
    console.log(LOG, '2. Setting up offscreen document…');
    if (!offscreenReady) {
      try {
        console.log(LOG, '   Creating offscreen document…');
        await chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: ['USER_MEDIA'],
          justification: 'Recording Google Meet tab audio',
        });
        offscreenReady = true;
        console.log(LOG, '✓ Offscreen document created');
      } catch (err) {
        if (err.message.includes('single offscreen')) {
          console.log(LOG, '✓ Offscreen document already exists');
          offscreenReady = true;
        } else {
          throw err;
        }
      }
    } else {
      console.log(LOG, '✓ Offscreen document already ready');
    }

    // Small delay to ensure offscreen JS has loaded
    console.log(LOG, '3. Waiting 500ms for offscreen JS to initialize…');
    await sleep(500);

    // 3. Tell offscreen to start capturing
    console.log(LOG, '4. Sending startCapture message to offscreen…');
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'startCapture',
      streamId: streamId,
    });
    console.log(LOG, '✓ Message sent to offscreen');
    console.log(LOG, '✓ Watch for "[PersonaMeet Offscreen]" logs below');
    console.log(LOG, '═══════════════════════════════════════════');

  } catch (err) {
    console.error(LOG, '═══════════════════════════════════════════════════════');
    console.error(LOG, '❌ TAB CAPTURE SETUP FAILED');
    console.error(LOG, '  Error:', err.message);
    console.error(LOG, '  Stack:', err.stack);
    console.error(LOG, '═══════════════════════════════════════════════════════');
    chrome.storage.local.set({
      botStatus: {
        type: 'PERSONA_STATUS',
        status: 'error',
        message: 'Audio capture failed: ' + err.message,
      },
    });
  }
}

// ─── Recording Monitor ────────────────────────────────────────────
let monitorInterval = null;

function startRecordingMonitor() {
  if (monitorInterval) return;
  
  console.log(LOG, '🔍 Starting recording monitor (logs every 10s)');
  
  monitorInterval = setInterval(() => {
    if (!recordingActive) {
      console.log(LOG, '⚠️ Recording inactive — stopping monitor');
      clearInterval(monitorInterval);
      monitorInterval = null;
      return;
    }
    
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    console.log(LOG, '📊 Recording status: ACTIVE | Elapsed:', elapsed + 's | Tab:', managedTabId);
  }, 10000); // every 10 seconds
}

function stopRecording() {
  console.log(LOG, '🛑 stopRecording() called');
  console.log(LOG, '   Recording was active:', recordingActive);
  console.log(LOG, '   Offscreen ready:', offscreenReady);
  
  if (offscreenReady) {
    chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'stopCapture',
    }).catch((err) => {
      console.error(LOG, 'Error sending stopCapture:', err);
    });
    console.log(LOG, '✓ Sent stopCapture to offscreen');
  }
  
  recordingActive = false;
  
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}

async function cleanupOffscreen() {
  console.log(LOG, 'Cleaning up offscreen document…');
  recordingActive = false;
  managedTabId = null;
  if (offscreenReady) {
    try {
      await chrome.offscreen.closeDocument();
      offscreenReady = false;
      console.log(LOG, '✓ Offscreen document closed');
    } catch (err) {
      console.log(LOG, 'Could not close offscreen:', err.message);
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
