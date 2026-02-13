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

  // ─── Virtual Audio System (Bot Speaking) ─────────────────────
  let audioContext = null;
  let audioDestination = null;
  let virtualStream = null;
  let songBuffer = null;
  let songSource = null;
  let gainNode = null; // For volume control
  let silentOscillator = null; // Keeps virtual mic stream active
  let isSpeaking = false;
  let originalGetUserMedia = null;
  let originalEnumerateDevices = null;
  let songUrl = null; // Will be set by content.js via postMessage

  // ─── EARLY Message Listener (must be first to catch song URL) ─────
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || !e.data.type) return;

    // Receive song URL from content.js - HIGHEST PRIORITY
    if (e.data.type === 'PERSONA_SONG_URL') {
      songUrl = e.data.url;
      console.log(LOG, '═══════════════════════════════════════════');
      console.log(LOG, '✅✅✅ SONG URL RECEIVED ✅✅✅');
      console.log(LOG, '   URL:', songUrl);
      console.log(LOG, '═══════════════════════════════════════════');
      return;
    }

    if (e.data.type === 'PERSONA_START') {
      if (!botActive) {
        botActive = true;
        console.log(LOG, 'Received PERSONA_START');
        runBot();
      }
    }

    if (e.data.type === 'PERSONA_STOP') {
      console.log(LOG, 'Received PERSONA_STOP');
      botActive = false;
      stopTranscription();
      sendStatus('stopped', 'Bot stopped');
    }

    // Forward status updates
    if (e.data.type === 'PERSONA_STATUS') {
      // Already handled, just ignore
    }
  });
  
  console.log(LOG, '═══════════════════════════════════════════');
  console.log(LOG, '✓✓✓ MESSAGE LISTENER REGISTERED ✓✓✓');
  console.log(LOG, '    Ready to receive song URL from content.js');
  console.log(LOG, '═══════════════════════════════════════════');

  // Override getUserMedia and enumerateDevices IMMEDIATELY before Meet calls them
  (function setupVirtualAudio() {
    console.log(LOG, '🎤 Setting up virtual audio override...');
    
    // Save originals
    originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    originalEnumerateDevices = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);

    // Override enumerateDevices to always report a virtual microphone
    // (Critical when physical mic driver is broken — Meet won't see any audioinput device otherwise)
    navigator.mediaDevices.enumerateDevices = async function() {
      console.log(LOG, '🎯 enumerateDevices intercepted!');
      let devices = [];
      try {
        devices = await originalEnumerateDevices();
      } catch (err) {
        console.log(LOG, '   Original enumerateDevices failed:', err.message);
      }

      // Check if any audio input devices exist
      const hasAudioInput = devices.some(d => d.kind === 'audioinput');
      if (!hasAudioInput) {
        console.log(LOG, '🎵 No physical mic found — injecting virtual microphone device');
        devices.push({
          deviceId: 'virtual-persona-mic',
          kind: 'audioinput',
          label: 'PersonaMeet Virtual Microphone',
          groupId: 'virtual-persona-group',
          toJSON() { return { deviceId: this.deviceId, kind: this.kind, label: this.label, groupId: this.groupId }; }
        });
      } else {
        console.log(LOG, '   Physical mic(s) found, keeping device list as-is');
      }

      return devices;
    };
    console.log(LOG, '✅ enumerateDevices override installed');

    // Override getUserMedia with our virtual audio stream
    navigator.mediaDevices.getUserMedia = async function(constraints) {
      console.log(LOG, '🎯 getUserMedia intercepted! Constraints:', JSON.stringify(constraints));
      
      if (constraints && constraints.audio) {
        const virtualAudioStream = await getVirtualAudioStream();

        // If also requesting video, combine virtual audio + real video
        if (constraints.video) {
          console.log(LOG, '🎵 Returning virtual audio + original video');
          try {
            const videoStream = await originalGetUserMedia({ video: constraints.video });
            const combinedStream = new MediaStream();
            virtualAudioStream.getAudioTracks().forEach(t => combinedStream.addTrack(t));
            videoStream.getVideoTracks().forEach(t => combinedStream.addTrack(t));
            return combinedStream;
          } catch (err) {
            console.log(LOG, '   Video request failed, returning audio-only:', err.message);
            return virtualAudioStream;
          }
        }

        console.log(LOG, '🎵 Returning virtual audio stream for microphone');
        return virtualAudioStream;
      }
      
      // For video-only or other requests, use original
      return originalGetUserMedia(constraints);
    };
    
    console.log(LOG, '✅ getUserMedia override installed');
  })();

  // Helper function to adjust bot volume (can be called from console)
  window.PersonaMeetSetVolume = function(volumeMultiplier) {
    if (!gainNode) {
      console.error(LOG, 'Audio system not initialized yet');
      return false;
    }
    gainNode.gain.value = volumeMultiplier;
    console.log(LOG, '🔊 Volume set to:', volumeMultiplier + 'x');
    return true;
  };
  
  console.log(LOG, '💡 TIP: To adjust volume, run in console: PersonaMeetSetVolume(5.0)');
  console.log(LOG, '   Values: 1.0=normal, 2.0=2x, 3.0=3x, 5.0=5x louder');

  // Create virtual audio stream using Web Audio API
  async function getVirtualAudioStream() {
    if (virtualStream && virtualStream.active) {
      console.log(LOG, '♻️  Reusing existing virtual stream');
      if (audioContext && audioContext.state === 'suspended') {
        try { await audioContext.resume(); console.log(LOG, '✓ AudioContext resumed'); } catch (_) {}
      }
      return virtualStream;
    }
    
    console.log(LOG, '🔧 Creating new virtual audio stream...');
    
    // Create audio context if not exists
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
      console.log(LOG, '✓ AudioContext created, state:', audioContext.state);
      
      // CRITICAL: Install a one-time click listener on the document.
      // Chrome blocks AudioContext until a real user gesture.
      // When the bot later clicks "Join" or any button, this fires and resumes audio.
      const resumeOnGesture = async () => {
        if (audioContext && audioContext.state === 'suspended') {
          try {
            await audioContext.resume();
            console.log(LOG, '✅ AudioContext RESUMED via user gesture! State:', audioContext.state);
          } catch (err) {
            console.warn(LOG, '⚠️ AudioContext resume on gesture failed:', err.message);
          }
        }
        // Start the silent oscillator now that AudioContext is running
        startSilentOscillator();
      };
      document.addEventListener('click', resumeOnGesture, { once: false });
      document.addEventListener('keydown', resumeOnGesture, { once: false });
      document.addEventListener('mousedown', resumeOnGesture, { once: false });
      console.log(LOG, '✓ Gesture listeners installed to resume AudioContext on first interaction');
    }
    
    // Try to resume (may only work if called during a user gesture)
    if (audioContext.state === 'suspended') {
      try {
        await audioContext.resume();
        console.log(LOG, '✓ AudioContext resumed, state:', audioContext.state);
      } catch (err) {
        console.warn(LOG, '⚠️ Could not resume AudioContext yet (no gesture). Will resume on first click.');
      }
    }
    
    // Create destination (this becomes our virtual microphone output)
    if (!audioDestination) {
      audioDestination = audioContext.createMediaStreamDestination();
      console.log(LOG, '✓ MediaStreamDestination created');
    }
    
    // Create gain node for volume control (amplify the audio!)
    if (!gainNode) {
      gainNode = audioContext.createGain();
      gainNode.gain.value = 3.0;
      gainNode.connect(audioDestination);
      console.log(LOG, '✓ GainNode created with volume boost:', gainNode.gain.value + 'x');
    }
    
    // Start silent oscillator only if AudioContext is already running
    if (audioContext.state === 'running') {
      startSilentOscillator();
    } else {
      console.log(LOG, '⚠️ AudioContext still suspended — oscillator will start on first user gesture');
    }
    
    virtualStream = audioDestination.stream;
    console.log(LOG, '✅ Virtual audio stream ready:', virtualStream.id);
    console.log(LOG, '   Audio tracks:', virtualStream.getAudioTracks().length);
    console.log(LOG, '   Track state:', virtualStream.getAudioTracks()[0]?.readyState);
    console.log(LOG, '   Volume boost:', gainNode.gain.value + 'x');
    console.log(LOG, '   AudioContext state:', audioContext.state);
    
    return virtualStream;
  }

  // Start a near-silent oscillator to keep the virtual mic stream producing audio frames
  function startSilentOscillator() {
    if (silentOscillator) return; // already running
    if (!audioContext || !audioDestination) return;
    if (audioContext.state !== 'running') return;
    
    silentOscillator = audioContext.createOscillator();
    silentOscillator.frequency.value = 440;
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0.001; // Near-silent but keeps stream producing audio data
    silentOscillator.connect(silentGain);
    silentGain.connect(audioDestination);
    silentOscillator.start();
    console.log(LOG, '✓ Silent oscillator started (keeps virtual mic stream active)');
  }

  // Load song.mp3 from extension resources
  async function loadSong() {
    if (songBuffer) {
      console.log(LOG, '♻️  Song already loaded');
      return songBuffer;
    }
    
    // Wait for song URL from content.js if not yet received
    if (!songUrl) {
      console.log(LOG, '⏳ Waiting for song URL from content.js...');
      await waitForSongUrl();
    }
    
    console.log(LOG, '📥 Loading song.mp3...');
    
    try {
      console.log(LOG, '   URL:', songUrl);
      
      // Fetch the audio file
      const response = await fetch(songUrl);
      if (!response.ok) throw new Error('Failed to fetch song: ' + response.status);
      
      const arrayBuffer = await response.arrayBuffer();
      console.log(LOG, '   Downloaded:', (arrayBuffer.byteLength / 1024).toFixed(2), 'KB');
      
      // Decode audio data
      songBuffer = await audioContext.decodeAudioData(arrayBuffer);
      console.log(LOG, '✅ Song loaded and decoded');
      console.log(LOG, '   Duration:', songBuffer.duration.toFixed(2), 'seconds');
      console.log(LOG, '   Channels:', songBuffer.numberOfChannels);
      console.log(LOG, '   Sample rate:', songBuffer.sampleRate, 'Hz');
      
      return songBuffer;
    } catch (err) {
      console.error(LOG, '❌ Failed to load song:', err);
      throw err;
    }
  }

  // Wait for song URL from content.js
  function waitForSongUrl() {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const maxAttempts = 100; // Check for 10 seconds (100 * 100ms)
      
      const checkInterval = setInterval(() => {
        attempts++;
        
        if (songUrl) {
          clearInterval(checkInterval);
          console.log(LOG, '✅ Song URL received after', attempts * 100, 'ms');
          resolve();
          return;
        }
        
        // Log progress every 2 seconds
        if (attempts % 20 === 0) {
          console.log(LOG, '   Still waiting for song URL... (' + (attempts * 100 / 1000) + 's)');
        }
        
        if (attempts >= maxAttempts) {
          clearInterval(checkInterval);
          reject(new Error('Timeout waiting for song URL from content.js after 10 seconds'));
        }
      }, 100);
    });
  }

  // Play song through virtual microphone
  async function playSongThroughMic() {
    if (isSpeaking) {
      console.log(LOG, '⚠️  Already speaking, ignoring play request');
      return;
    }
    
    console.log(LOG, '═══════════════════════════════════════════');
    console.log(LOG, '🎤 BOT STARTING TO SPEAK');
    console.log(LOG, '═══════════════════════════════════════════');
    
    try {
      // Ensure AudioContext is running before playback
      if (audioContext && audioContext.state === 'suspended') {
        await audioContext.resume();
        console.log(LOG, '✓ AudioContext resumed for playback');
      }
      
      // Load song if not already loaded
      await loadSong();
      
      // Create buffer source to play the song
      songSource = audioContext.createBufferSource();
      songSource.buffer = songBuffer;
      
      // Connect through gain node for volume boost: Source → Gain → Destination
      songSource.connect(gainNode);
      
      console.log(LOG, '🎵 Starting song playback...');
      console.log(LOG, '   Volume level:', gainNode.gain.value + 'x (amplified)');
      console.log(LOG, '   Audio pipeline: BufferSource → GainNode(×' + gainNode.gain.value + ') → VirtualMic → Meet');
      isSpeaking = true;
      
      // Handle song end
      songSource.onended = () => {
        console.log(LOG, '✅ Song finished playing');
        console.log(LOG, '   Total duration played:', songBuffer.duration.toFixed(2), 'seconds');
        isSpeaking = false;
        songSource = null;
        
        // Disable mic after song ends
        setTimeout(() => {
          console.log(LOG, '🔇 Disabling microphone after song...');
          disableMicAfterSpeaking();
        }, 1000);
      };
      
      // Start playing
      songSource.start(0);
      console.log(LOG, '▶️  Song playing through virtual microphone!');
      console.log(LOG, '   Everyone in the meeting should hear it now');
      console.log(LOG, '   Duration:', songBuffer.duration.toFixed(2), 'seconds');
      console.log(LOG, '   Volume boost: ' + gainNode.gain.value + 'x');
      console.log(LOG, '══════════════════════════════════════════');
      
      // Monitor playback after 3 seconds to confirm it's working
      setTimeout(() => {
        if (isSpeaking && songSource) {
          console.log(LOG, '✓ Audio still playing... (3s check)');
          console.log(LOG, '✓ If others can\'t hear, they may have muted you or audio is off');
        }
      }, 3000);
      console.log(LOG, '══════════════════════════════════════════');
      
    } catch (err) {
      console.error(LOG, '❌ Error playing song:', err);
      isSpeaking = false;
    }
  }

  // Enable microphone programmatically
  async function enableMicForSpeaking() {
    console.log(LOG, '🎤 Enabling microphone for bot speech...');
    
    // CRITICAL: Resume AudioContext before enabling mic
    // Meet may re-check the audio stream when mic is toggled
    if (audioContext && audioContext.state === 'suspended') {
      try {
        await audioContext.resume();
        console.log(LOG, '✓ AudioContext resumed before mic enable');
        startSilentOscillator();
      } catch (err) {
        console.warn(LOG, '⚠️ Could not resume AudioContext:', err.message);
      }
    }
    
    for (let attempt = 1; attempt <= 5; attempt++) {
      const btn = findToggleButton('microphone');
      if (!btn) {
        console.log(LOG, '   Mic button not found, attempt', attempt + '/5');
        await sleep(1000);
        continue;
      }
      
      const labels = getAllLabels(btn);
      console.log(LOG, '   Mic button labels:', JSON.stringify(labels));
      
      // If it says "turn on" → mic is currently OFF, click to turn ON
      if (labels.includes('turn on') || labels.includes('is off')) {
        console.log(LOG, '   Clicking to ENABLE microphone...');
        simulateRealClick(btn);
        await sleep(1500);
        
        // Verify the mic actually toggled
        const afterLabels = getAllLabels(btn);
        console.log(LOG, '   After click, labels:', JSON.stringify(afterLabels));
        if (afterLabels.includes('turn off')) {
          console.log(LOG, '✅ Microphone ENABLED (verified)');
          return true;
        } else {
          console.log(LOG, '⚠️ Mic click may not have worked, retrying...');
          continue;
        }
      }
      
      // If it says "turn off" → mic is already ON
      if (labels.includes('turn off')) {
        console.log(LOG, '✅ Microphone already ENABLED');
        return true;
      }
      
      await sleep(1000);
    }
    
    console.error(LOG, '❌ Failed to enable microphone');
    return false;
  }

  // Disable microphone after speaking
  async function disableMicAfterSpeaking() {
    console.log(LOG, '🔇 Disabling microphone after speech...');
    
    for (let attempt = 1; attempt <= 5; attempt++) {
      const btn = findToggleButton('microphone');
      if (!btn) {
        console.log(LOG, '   Mic button not found, attempt', attempt + '/5');
        await sleep(1000);
        continue;
      }
      
      const labels = getAllLabels(btn);
      
      // If it says "turn off" → mic is currently ON, click to turn OFF
      if (labels.includes('turn off')) {
        console.log(LOG, '   Clicking to DISABLE microphone...');
        simulateRealClick(btn);
        await sleep(500);
        console.log(LOG, '✅ Microphone DISABLED');
        return true;
      }
      
      // If it says "turn on" → mic is already OFF
      if (labels.includes('turn on') || labels.includes('is off')) {
        console.log(LOG, '✅ Microphone already DISABLED');
        return true;
      }
      
      await sleep(1000);
    }
    
    console.log(LOG, '⚠️  Could not confirm mic disabled');
    return false;
  }

  // ─── Transcription (optional — works if audio plays through speakers) ──
  let recognition = null;
  let fullTranscript = '';
  let transcriptLines = [];

  // Signal readiness (send multiple times to ensure content.js receives it)
  window.postMessage({ type: 'PERSONA_READY' }, '*');
  setTimeout(() => window.postMessage({ type: 'PERSONA_READY' }, '*'), 500);
  setTimeout(() => window.postMessage({ type: 'PERSONA_READY' }, '*'), 1500);
  setTimeout(() => window.postMessage({ type: 'PERSONA_READY' }, '*'), 3000);
  log('inject.js loaded and READY (v4.1 — virtual audio + tabCapture)');

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

      // 13. BOT SPEAKING: Wait 10 seconds, then enable mic and play song
      log('Step 13: Scheduling bot speech in 10 seconds...');
      setTimeout(async () => {
        if (!botActive) {
          log('⚠️  Bot no longer active, skipping speech');
          return;
        }
        
        log('══════════════════════════════════');
        log('⏰ 10 SECONDS ELAPSED — BOT WILL NOW SPEAK');
        log('══════════════════════════════════');
        
        // Debug: Check if song URL was received
        if (!songUrl) {
          logError('❌ CRITICAL: songUrl is null!');
          logError('   Song URL was never received from content.js');
          logError('   Check that content.js is loaded and sending the URL');
          return;
        } else {
          log('✓ Song URL confirmed available:', songUrl);
        }
        
        try {
          // First, enable the microphone
          const micEnabled = await enableMicForSpeaking();
          if (!micEnabled) {
            throw new Error('Failed to enable microphone');
          }
          
          // Small delay to ensure Meet has processed the mic enable
          await sleep(2000);
          
          // Now play the song through the virtual mic
          await playSongThroughMic();
          
        } catch (err) {
          logError('❌ Error during bot speech:', err);
        }
      }, 10000);

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
      simulateRealClick(btn);
      log(type, 'turned OFF via simulated click');
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
          simulateRealClick(btn);
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
    const dismiss = ['got it', 'dismiss', 'close', 'ok', 'no thanks', 'continue without microphone', 'continue without mic'];
    for (const btn of document.querySelectorAll('button, [role="button"]')) {
      const text = (btn.innerText || '').trim().toLowerCase();
      if (dismiss.some(d => text.includes(d))) {
        btn.click();
        log('Dismissed popup:', text);
      }
    }
    // Also dismiss any mic/device warning dialogs
    for (const el of document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')) {
      const text = (el.innerText || '').trim().toLowerCase();
      if (text.includes('continue') || text.includes('got it') || text.includes('use without') || text.includes('ok')) {
        el.click();
        log('Dismissed dialog button:', text);
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

  // Simulate a real user click with full event sequence.
  // A bare el.click() may not trigger React/Polymer event handlers on Meet's UI.
  // Dispatching mousedown → mouseup → click with {bubbles, cancelable, isTrusted-like}
  // gives the framework all the events it listens for.
  function simulateRealClick(el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    // Also call the native click as a fallback
    el.click();
  }
})();
