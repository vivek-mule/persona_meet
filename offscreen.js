// offscreen.js — Offscreen document for tab audio capture & recording.
// Receives a tabCapture stream ID from background.js, calls getUserMedia
// with chromeMediaSource:'tab', and records the audio via MediaRecorder.

(function () {
  'use strict';

  const LOG = '[PersonaMeet Offscreen]';
  let mediaRecorder = null;
  let audioChunks = [];
  let totalBytes = 0;
  let isRecording = false;
  let captureStream = null;
  let healthInterval = null;

  console.log(LOG, 'Offscreen document loaded');

  // ─── Message handling ─────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.target !== 'offscreen') return;

    if (msg.action === 'startCapture') {
      console.log(LOG, 'Received startCapture — streamId:', msg.streamId.substring(0, 30) + '…');
      startCapture(msg.streamId);
      sendResponse({ ok: true });
    }

    if (msg.action === 'stopCapture') {
      console.log(LOG, 'Received stopCapture');
      stopCapture();
      sendResponse({ ok: true });
    }

    return true;
  });

  // ─── Tab Audio Capture ────────────────────────────────────────
  async function startCapture(streamId) {
    if (isRecording) {
      console.log(LOG, 'Already recording — ignoring duplicate start');
      return;
    }

    console.log(LOG, '═══════════════════════════════════════════');
    console.log(LOG, 'OFFSCREEN: Starting tab capture');
    console.log(LOG, '═══════════════════════════════════════════');

    try {
      // Get the tab's audio stream via getUserMedia with tab capture source
      console.log(LOG, '1. Calling getUserMedia with chromeMediaSource:tab…');
      console.log(LOG, '   streamId:', streamId.substring(0, 50) + '…');
      
      captureStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId,
          },
        },
        video: false,
      });

      console.log(LOG, '✓ getUserMedia succeeded — got MediaStream');
      console.log(LOG, '  Stream ID:', captureStream.id);
      console.log(LOG, '  Stream active:', captureStream.active);
      
      const audioTracks = captureStream.getAudioTracks();
      console.log(LOG, '✓ Audio tracks in stream:', audioTracks.length);
      
      if (audioTracks.length === 0) {
        const errMsg = 'No audio tracks in captured stream - tabCapture may have failed';
        console.error(LOG, '✗ ERROR:', errMsg);
        chrome.runtime.sendMessage({
          target: 'background',
          action: 'recordingError',
          error: errMsg,
        });
        return;
      }
      
      audioTracks.forEach((t, i) => {
        console.log(LOG, `   Track ${i + 1}:`);
        console.log(LOG, `     id: ${t.id.substring(0, 30)}…`);
        console.log(LOG, `     label: "${t.label}"`);
        console.log(LOG, `     kind: ${t.kind}`);
        console.log(LOG, `     readyState: ${t.readyState}`);
        console.log(LOG, `     enabled: ${t.enabled}`);
        console.log(LOG, `     muted: ${t.muted}`);
        
        // Monitor track state changes
        t.onended = () => {
          console.warn(LOG, `⚠️ Track ${i + 1} ENDED`);
          // When the tab navigates away (meeting ends), the capture stream's
          // tracks end.  If we're still recording, auto-stop & save.
          if (isRecording && mediaRecorder && mediaRecorder.state !== 'inactive') {
            console.log(LOG, '🚨 Track ended while recording — auto-stopping to save audio');
            stopCapture();
          }
        };
        t.onmute = () => console.warn(LOG, `⚠️ Track ${i + 1} MUTED`);
        t.onunmute = () => console.log(LOG, `✓ Track ${i + 1} UNMUTED`);
      });

      // Choose best available codec
      console.log(LOG, '2. Selecting audio codec…');
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      console.log(LOG, '✓ Using:', mimeType);

      console.log(LOG, '3. Creating MediaRecorder…');
      mediaRecorder = new MediaRecorder(captureStream, { mimeType });
      audioChunks = [];
      totalBytes = 0;
      console.log(LOG, '✓ MediaRecorder created');

      console.log(LOG, '4. Setting up MediaRecorder event handlers…');
      
      mediaRecorder.onstart = () => {
        console.log(LOG, '🎬 MediaRecorder.onstart fired!');
        console.log(LOG, '   State:', mediaRecorder.state);
        console.log(LOG, '   Stream active:', captureStream.active);
        console.log(LOG, '   Track readyState:', captureStream.getAudioTracks()[0]?.readyState);
      };
      
      mediaRecorder.ondataavailable = (e) => {
        console.log(LOG, '📦 ondataavailable fired — chunk size:', e.data?.size || 0);
        if (e.data && e.data.size > 0) {
          audioChunks.push(e.data);
          totalBytes += e.data.size;
          console.log(LOG,
            '✅ Audio chunk #' + audioChunks.length + ':',
            formatBytes(e.data.size),
            ' | Total:', formatBytes(totalBytes)
          );
        } else {
          console.warn(LOG, '⚠️  Empty chunk received (size: 0) - NO AUDIO DATA!');
          console.warn(LOG, '    This means the tab is not producing audio or capture failed');
        }
      };

      mediaRecorder.onerror = (e) => {
        console.error(LOG, '❌ MediaRecorder error:', e.error || e);
        chrome.runtime.sendMessage({
          target: 'background',
          action: 'recordingError',
          error: 'MediaRecorder error: ' + (e.error?.message || 'unknown'),
        });
      };

      mediaRecorder.onstop = () => {
        console.log(LOG, 'MediaRecorder stopped — chunks:', audioChunks.length,
          ' total:', formatBytes(totalBytes));
        finalizeRecording();
      };

      // Emit data every 3 seconds
      console.log(LOG, '5. Starting MediaRecorder (timeslice: 3000ms)…');
      console.log(LOG, '   NOTE: Chunks will only contain data if tab is producing audio!');
      console.log(LOG, '   If Meet tab is silent (no one speaking), chunks will be 0 bytes');
      mediaRecorder.start(3000);
      isRecording = true;
      console.log(LOG, '✓ MediaRecorder.start() called — state:', mediaRecorder.state);

      console.log(LOG, '═══════════════════════════════════════════');
      console.log(LOG, '🎙️  RECORDING ACTIVE');
      console.log(LOG, '  Format:', mimeType);
      console.log(LOG, '  Tracks:', audioTracks.length);
      console.log(LOG, '  Recorder state:', mediaRecorder.state);
      console.log(LOG, '  Stream active:', captureStream.active);
      console.log(LOG, '  IMPORTANT: Audio chunks appear ONLY when tab produces sound');
      console.log(LOG, '  Try speaking in the Meet or playing audio to test!');
      console.log(LOG, '═══════════════════════════════════════════');

      // Report status
      chrome.runtime.sendMessage({
        target: 'background',
        action: 'recordingStarted',
      });

      // Health check logging
      healthInterval = setInterval(() => {
        if (!isRecording) { clearInterval(healthInterval); return; }
        console.log(LOG, '─────── Health Check ───────');
        console.log(LOG, '  Recording:', isRecording);
        console.log(LOG, '  Recorder state:', mediaRecorder ? mediaRecorder.state : 'N/A');
        console.log(LOG, '  Chunks collected:', audioChunks.length);
        console.log(LOG, '  Total audio data:', formatBytes(totalBytes));
        const tracks = captureStream ? captureStream.getAudioTracks() : [];
        console.log(LOG, '  Live tracks:', tracks.filter(t => t.readyState === 'live').length);
        
        if (audioChunks.length === 0 || totalBytes === 0) {
          console.warn(LOG, '  ⚠️ WARNING: No audio data captured yet!');
          console.warn(LOG, '  Possible reasons:');
          console.warn(LOG, '    - No one is speaking in the Meet');
          console.warn(LOG, '    - Tab audio is muted');
          console.warn(LOG, '    - Meeting hasn\'t started producing audio');
        }
        console.log(LOG, '────────────────────────────');
      }, 20000);

    } catch (err) {
      console.error(LOG, 'Failed to start tab capture:', err);
      console.error(LOG, '  Error name:', err.name);
      console.error(LOG, '  Error message:', err.message);
      console.error(LOG, '  Full error:', JSON.stringify({ name: err.name, message: err.message, code: err.code }));
      chrome.runtime.sendMessage({
        target: 'background',
        action: 'recordingError',
        error: (err.name || 'Error') + ': ' + (err.message || 'Unknown error starting tab capture'),
      });
    }
  }

  function stopCapture() {
    if (!isRecording || !mediaRecorder) {
      console.log(LOG, 'Not recording — nothing to stop');
      finalizeRecording(); // still try to save any chunks
      return;
    }

    try {
      if (mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop(); // triggers onstop → finalizeRecording
      }
      isRecording = false;
    } catch (err) {
      console.error(LOG, 'Error stopping recorder:', err);
      finalizeRecording();
    }

    // Stop capture stream tracks
    if (captureStream) {
      captureStream.getTracks().forEach((t) => t.stop());
      captureStream = null;
    }

    if (healthInterval) {
      clearInterval(healthInterval);
      healthInterval = null;
    }
  }

  async function finalizeRecording() {
    isRecording = false;

    console.log(LOG, '═══════════════════════════════════════════');
    console.log(LOG, 'FINALIZING RECORDING');
    console.log(LOG, '  Chunks collected:', audioChunks.length);
    console.log(LOG, '  Total bytes:', totalBytes);
    console.log(LOG, '═══════════════════════════════════════════');

    if (audioChunks.length === 0 || totalBytes === 0) {
      console.warn(LOG, '⚠️ No audio data was captured!');
      console.warn(LOG, 'Possible reasons:');
      console.warn(LOG, '  - Meeting had no audio (no one spoke)');
      console.warn(LOG, '  - Tab audio was muted');
      console.warn(LOG, '  - You were alone in the meeting');
      console.warn(LOG, '  - Meeting ended immediately after joining');
      chrome.runtime.sendMessage({
        target: 'background',
        action: 'recordingComplete',
        hasData: false,
      });
      return;
    }

    console.log(LOG, '✓ Have audio data — creating download file…');
    console.log(LOG, '  Total chunks:', audioChunks.length);
    console.log(LOG, '  Total size:', formatBytes(totalBytes));

    try {
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      console.log(LOG, '  Blob created — size:', formatBytes(blob.size));
      
      if (blob.size === 0) {
        console.error(LOG, '❌ Blob size is 0! Chunks had no real data.');
        chrome.runtime.sendMessage({
          target: 'background',
          action: 'recordingComplete',
          hasData: false,
        });
        return;
      }

      // Convert to data URL for download via background
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = reader.result;
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = 'meeting-recording-' + ts + '.webm';

        console.log(LOG, '  Data URL ready — sending to background for download');
        console.log(LOG, '  Filename:', filename);

        chrome.runtime.sendMessage({
          target: 'background',
          action: 'downloadRecording',
          dataUrl: dataUrl,
          filename: filename,
        });
      };
      reader.onerror = (err) => {
        console.error(LOG, 'FileReader error:', err);
      };
      reader.readAsDataURL(blob);
    } catch (err) {
      console.error(LOG, 'Error finalizing recording:', err);
    }
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
})();
