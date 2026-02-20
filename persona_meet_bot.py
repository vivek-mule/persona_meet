"""
PersonaMeet Bot — Playwright Automation
========================================

  1. Navigate to a Google Meet URL
  2. Override getUserMedia / enumerateDevices for a virtual microphone
  3. Disable microphone and camera on the pre-join screen
  4. Dismiss popups and click "Join Now" / "Ask to Join"
  5. Record all meeting audio (via WebRTC stream interception — equivalent to tabCapture)
  6. After 10 seconds in the meeting, enable mic and play sample.mp3 through virtual mic
  7. Disable mic after the song finishes
  8. Monitor for meeting end
  9. Stop recording and save the .webm audio file

  python persona_meet_bot.py "https://meet.google.com/abc-defg-hij" --name "Meeting Agent"
"""

import asyncio
import sys
import os
import base64
import signal
import argparse
from datetime import datetime
from urllib.parse import urlparse

from playwright.async_api import async_playwright, Page, Browser, BrowserContext


# ═══════════════════════════════════════════════════════════════════
# Logging
# ═══════════════════════════════════════════════════════════════════

LOG = "[PersonaMeet Bot]"


def log(*args):
    ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    print(f"{ts} {LOG}", *args, flush=True)


def log_error(*args):
    ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    print(f"{ts} {LOG} ERROR:", *args, file=sys.stderr, flush=True)


# ═══════════════════════════════════════════════════════════════════
# JavaScript injected into the page BEFORE it loads (via add_init_script).
#
# This mirrors inject.js from the extension:
#   - Overrides navigator.mediaDevices.getUserMedia → returns virtual audio stream
#   - Overrides navigator.mediaDevices.enumerateDevices → injects virtual mic device
#   - Sets up AudioContext + GainNode for playing audio through virtual mic
#
# PLUS recording support (replaces the extension's tabCapture + offscreen.js):
#   - Intercepts RTCPeerConnection to capture remote audio tracks
#   - Mixes all remote audio via AudioContext into a single stream
#   - Records the mixed stream with MediaRecorder
#
# Exposes window.__personaMeetBot for Playwright to call from Python.
# ═══════════════════════════════════════════════════════════════════

# ═══════════════════════════════════════════════════════════════════
# Stealth script injected BEFORE the page loads to prevent bot detection.
# Hides navigator.webdriver, fakes navigator.plugins, patches
# permissions query, and removes Playwright/automation markers.
# ═══════════════════════════════════════════════════════════════════

STEALTH_SCRIPT = r"""
(() => {
    // Hide navigator.webdriver (Playwright sets this to true)
    Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
        configurable: true,
    });

    // Spoof navigator.plugins (empty array is a bot giveaway)
    Object.defineProperty(navigator, 'plugins', {
        get: () => {
            const arr = [{
                name: 'Chrome PDF Plugin',
                description: 'Portable Document Format',
                filename: 'internal-pdf-viewer',
                length: 1,
                0: { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' },
            }, {
                name: 'Chrome PDF Viewer',
                description: '',
                filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
                length: 1,
                0: { type: 'application/pdf', suffixes: 'pdf', description: '' },
            }, {
                name: 'Native Client',
                description: '',
                filename: 'internal-nacl-plugin',
                length: 2,
                0: { type: 'application/x-nacl', suffixes: '', description: 'Native Client Executable' },
                1: { type: 'application/x-pnacl', suffixes: '', description: 'Portable Native Client Executable' },
            }];
            arr.refresh = () => {};
            return arr;
        },
        configurable: true,
    });

    // Spoof navigator.languages
    Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
        configurable: true,
    });

    // Fix Permissions API (Playwright gives inconsistent results)
    const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
    window.navigator.permissions.query = (parameters) => {
        if (parameters.name === 'notifications') {
            return Promise.resolve({ state: Notification.permission });
        }
        return originalQuery(parameters);
    };

    // Remove headless markers from window.chrome
    if (!window.chrome) {
        window.chrome = {};
    }
    if (!window.chrome.runtime) {
        window.chrome.runtime = {};
    }

    // Fix window.outerWidth/outerHeight (0 in headless)
    if (window.outerWidth === 0) {
        Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth });
    }
    if (window.outerHeight === 0) {
        Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight });
    }
})();
""";

INIT_SCRIPT = r"""
(() => {
    'use strict';
    const LOG = '[PersonaMeet Bot]';

    // ═══════════════════════════════════════
    // SECTION 1: Virtual Audio System
    // ═══════════════════════════════════════
    let audioContext = null;
    let audioDestination = null;
    let virtualStream = null;
    let gainNode = null;
    let silentOscillator = null;
    let songSource = null;
    let songBuffer = null;
    let isSpeaking = false;

    // Save originals before overriding
    const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const originalEnumerateDevices = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);

    // Override enumerateDevices — inject virtual mic if no physical mic exists
    // (mirrors inject.js enumerateDevices override)
    navigator.mediaDevices.enumerateDevices = async function () {
        let devices = [];
        try {
            devices = await originalEnumerateDevices();
        } catch (err) {
            console.log(LOG, 'Original enumerateDevices failed:', err.message);
        }
        const hasAudioInput = devices.some(d => d.kind === 'audioinput');
        if (!hasAudioInput) {
            console.log(LOG, 'No physical mic — injecting virtual microphone device');
            devices.push({
                deviceId: 'virtual-persona-mic',
                kind: 'audioinput',
                label: 'PersonaMeet Virtual Microphone',
                groupId: 'virtual-persona-group',
                toJSON() {
                    return {
                        deviceId: this.deviceId, kind: this.kind,
                        label: this.label, groupId: this.groupId
                    };
                }
            });
        }
        return devices;
    };

    // Create / reuse the virtual audio stream
    async function getVirtualAudioStream() {
        if (virtualStream && virtualStream.active) return virtualStream;

        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
            console.log(LOG, 'AudioContext created, state:', audioContext.state);

            // Resume AudioContext on any user gesture (click/keydown/mousedown)
            const resumeOnGesture = async () => {
                if (audioContext && audioContext.state === 'suspended') {
                    try {
                        await audioContext.resume();
                        console.log(LOG, 'AudioContext RESUMED via gesture, state:', audioContext.state);
                    } catch (_) {}
                }
                startSilentOscillator();
            };
            document.addEventListener('click', resumeOnGesture);
            document.addEventListener('keydown', resumeOnGesture);
            document.addEventListener('mousedown', resumeOnGesture);
        }

        if (!audioDestination) {
            audioDestination = audioContext.createMediaStreamDestination();
        }
        if (!gainNode) {
            gainNode = audioContext.createGain();
            gainNode.gain.value = 10.0;  // Volume boost (matches inject.js)
            gainNode.connect(audioDestination);
        }
        if (audioContext.state === 'running') startSilentOscillator();

        virtualStream = audioDestination.stream;
        console.log(LOG, 'Virtual audio stream ready, tracks:', virtualStream.getAudioTracks().length);
        return virtualStream;
    }

    // Near-silent oscillator keeps the virtual mic stream producing frames
    function startSilentOscillator() {
        if (silentOscillator) return;
        if (!audioContext || !audioDestination || audioContext.state !== 'running') return;
        silentOscillator = audioContext.createOscillator();
        silentOscillator.frequency.value = 440;
        const g = audioContext.createGain();
        g.gain.value = 0.001;
        silentOscillator.connect(g);
        g.connect(audioDestination);
        silentOscillator.start();
        console.log(LOG, 'Silent oscillator started');
    }

    // Override getUserMedia — return virtual audio for any audio request
    // (mirrors inject.js getUserMedia override)
    navigator.mediaDevices.getUserMedia = async function (constraints) {
        console.log(LOG, 'getUserMedia intercepted:', JSON.stringify(constraints));
        if (constraints && constraints.audio) {
            const vStream = await getVirtualAudioStream();
            if (constraints.video) {
                try {
                    const vidStream = await originalGetUserMedia({ video: constraints.video });
                    const combined = new MediaStream();
                    vStream.getAudioTracks().forEach(t => combined.addTrack(t));
                    vidStream.getVideoTracks().forEach(t => combined.addTrack(t));
                    return combined;
                } catch (_) {
                    return vStream;
                }
            }
            return vStream;
        }
        return originalGetUserMedia(constraints);
    };
    console.log(LOG, 'getUserMedia + enumerateDevices overrides installed');

    // ═══════════════════════════════════════
    // SECTION 2: Recording System (replaces tabCapture + offscreen.js)
    // Uses AudioContext as a mixer: remote WebRTC audio tracks are
    // connected to a single MediaStreamDestination, which feeds a
    // MediaRecorder.  New tracks arriving mid-recording are
    // automatically mixed in.
    // ═══════════════════════════════════════
    let recCtx = null;        // Recording AudioContext
    let recDest = null;       // MediaStreamDestination for mixed audio
    let mediaRecorder = null;
    let recordedChunks = [];
    let totalRecBytes = 0;
    let isRecording = false;
    let connectedTrackIds = new Set();

    function ensureRecordingContext() {
        if (!recCtx) {
            recCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
            recDest = recCtx.createMediaStreamDestination();
            console.log(LOG, 'Recording AudioContext created');
        }
        if (recCtx.state === 'suspended') recCtx.resume().catch(() => {});
        return { ctx: recCtx, dest: recDest };
    }

    // Connect a remote audio track into the recording mixer
    function connectTrackToRecorder(track) {
        if (connectedTrackIds.has(track.id)) return;
        try {
            const { ctx, dest } = ensureRecordingContext();
            if (ctx.state === 'suspended') ctx.resume().catch(() => {});
            const src = ctx.createMediaStreamSource(new MediaStream([track]));
            src.connect(dest);
            connectedTrackIds.add(track.id);
            console.log(LOG, 'Remote track connected to recorder:', track.id.substring(0, 20));
        } catch (err) {
            console.error(LOG, 'Error connecting track:', err);
        }
    }

    // ═══════════════════════════════════════
    // SECTION 3: WebRTC Interception
    // Wraps RTCPeerConnection so we capture every remote audio track
    // that Google Meet delivers.
    // ═══════════════════════════════════════
    const OrigRTC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (OrigRTC) {
        // Wrapper constructor — returns a real RTCPeerConnection instance
        // with an extra 'track' listener for recording
        function PersonaRTCPeerConnection(...args) {
            const pc = new OrigRTC(...args);
            pc.addEventListener('track', (event) => {
                if (event.track.kind === 'audio') {
                    console.log(LOG, 'Remote audio track received via WebRTC');
                    connectTrackToRecorder(event.track);
                    event.track.addEventListener('ended', () => {
                        connectedTrackIds.delete(event.track.id);
                        console.log(LOG, 'Remote audio track ended');
                    });
                }
            });
            return pc;  // 'new' returns this object (not 'this')
        }

        // Preserve the prototype chain so instanceof checks work
        PersonaRTCPeerConnection.prototype = OrigRTC.prototype;

        // Copy static methods (e.g. generateCertificate)
        for (const key of Object.getOwnPropertyNames(OrigRTC)) {
            if (key === 'prototype' || key === 'length' || key === 'name') continue;
            try {
                Object.defineProperty(PersonaRTCPeerConnection, key,
                    Object.getOwnPropertyDescriptor(OrigRTC, key));
            } catch (_) {}
        }

        window.RTCPeerConnection = PersonaRTCPeerConnection;
        if (window.webkitRTCPeerConnection) {
            window.webkitRTCPeerConnection = PersonaRTCPeerConnection;
        }
        console.log(LOG, 'RTCPeerConnection interceptor installed');
    }

    // ═══════════════════════════════════════
    // SECTION 4: API exposed to Playwright
    // (called via page.evaluate)
    // ═══════════════════════════════════════
    window.__personaMeetBot = {
        getVirtualAudioStream,

        // ── Play song through virtual mic ──────────────
        playSong: async function (songUrl) {
            if (isSpeaking) { console.log(LOG, 'Already speaking'); return false; }
            try {
                if (audioContext && audioContext.state === 'suspended') await audioContext.resume();
                if (!songBuffer) {
                    console.log(LOG, 'Loading song from', songUrl);
                    const resp = await fetch(songUrl);
                    if (!resp.ok) throw new Error('Fetch failed: ' + resp.status);
                    const ab = await resp.arrayBuffer();
                    songBuffer = await audioContext.decodeAudioData(ab);
                    console.log(LOG, 'Song loaded:', songBuffer.duration.toFixed(2) + 's',
                                songBuffer.numberOfChannels + 'ch', songBuffer.sampleRate + 'Hz');
                }
                songSource = audioContext.createBufferSource();
                songSource.buffer = songBuffer;
                songSource.connect(gainNode);
                isSpeaking = true;
                return new Promise(resolve => {
                    songSource.onended = () => {
                        console.log(LOG, 'Song finished');
                        isSpeaking = false;
                        songSource = null;
                        resolve(true);
                    };
                    songSource.start(0);
                    console.log(LOG, 'Song playing through virtual mic (' +
                                songBuffer.duration.toFixed(2) + 's, ' +
                                gainNode.gain.value + 'x volume)');
                });
            } catch (err) {
                console.error(LOG, 'Play error:', err);
                isSpeaking = false;
                return false;
            }
        },

        isSpeaking: () => isSpeaking,

        // ── Start recording ────────────────────────────
        startRecording: function () {
            if (isRecording) return true;
            const { ctx, dest } = ensureRecordingContext();
            try {
                if (ctx.state === 'suspended') ctx.resume().catch(() => {});
                const stream = dest.stream;
                if (stream.getAudioTracks().length === 0) {
                    console.log(LOG, 'No audio tracks in recording stream');
                    return false;
                }
                const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                    ? 'audio/webm;codecs=opus' : 'audio/webm';
                mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
                recordedChunks = [];
                totalRecBytes = 0;

                mediaRecorder.ondataavailable = (e) => {
                    if (e.data && e.data.size > 0) {
                        recordedChunks.push(e.data);
                        totalRecBytes += e.data.size;
                    }
                };
                mediaRecorder.onerror = (e) => console.error(LOG, 'Recorder error:', e.error || e);
                mediaRecorder.start(3000);  // chunk every 3 s (same as offscreen.js)
                isRecording = true;
                console.log(LOG, 'Recording started (' + mime + '), connected tracks:', connectedTrackIds.size);
                return true;
            } catch (err) {
                console.error(LOG, 'Failed to start recording:', err);
                return false;
            }
        },

        // ── Stop recording and return data URL ─────────
        stopRecording: function () {
            if (!mediaRecorder || !isRecording) return Promise.resolve(null);
            return new Promise(resolve => {
                mediaRecorder.onstop = () => {
                    isRecording = false;
                    console.log(LOG, 'Recorder stopped, chunks:', recordedChunks.length,
                                'total:', totalRecBytes, 'bytes');
                    if (recordedChunks.length === 0 || totalRecBytes === 0) {
                        resolve(null); return;
                    }
                    try {
                        const blob = new Blob(recordedChunks, { type: 'audio/webm' });
                        if (blob.size === 0) { resolve(null); return; }
                        const reader = new FileReader();
                        reader.onloadend = () => resolve(reader.result);
                        reader.onerror = () => resolve(null);
                        reader.readAsDataURL(blob);
                    } catch (err) {
                        console.error(LOG, 'Blob error:', err);
                        resolve(null);
                    }
                };
                try {
                    if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
                    else resolve(null);
                } catch (_) { resolve(null); }
            });
        },

        // ── Status for monitoring ──────────────────────
        getStatus: function () {
            return {
                isRecording,
                chunks: recordedChunks.length,
                totalBytes: totalRecBytes,
                connectedTracks: connectedTrackIds.size,
                isSpeaking
            };
        }
    };

    console.log(LOG, 'In-page system fully initialized');
})();
"""


# ═══════════════════════════════════════════════════════════════════
# JavaScript snippets used by the bot (mirror inject.js logic)
# ═══════════════════════════════════════════════════════════════════

# Returns { state: 'on'|'off'|'unknown'|null, x, y } for a mic/camera toggle
JS_FIND_TOGGLE = r"""
(type) => {
    const els = document.querySelectorAll('button, [role="button"], [data-is-muted]');
    for (const el of els) {
        const label = [
            el.getAttribute('aria-label') || '',
            el.getAttribute('data-tooltip') || '',
            el.getAttribute('title') || '',
        ].join(' ').toLowerCase();

        if (label.includes('settings') || label.includes('option') ||
            label.includes('effect') || label.includes('layout') || label.includes('tile'))
            continue;

        let isMatch = false;
        if (type === 'microphone') {
            if (label.includes('microphone') || label.includes(' mic ') || /\bmic\b/.test(label))
                isMatch = true;
        }
        if (type === 'camera') {
            if (label.includes('camera')) isMatch = true;
            if (label.includes('video') && (label.includes('turn off') || label.includes('turn on')))
                isMatch = true;
        }

        if (isMatch) {
            const rect = el.getBoundingClientRect();
            let state = 'unknown';
            if (label.includes('turn off')) state = 'on';
            else if (label.includes('turn on') || label.includes('is off')) state = 'off';
            return { state, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }
    }
    return null;
}
"""

# Dismiss popups / dialogs (mirrors inject.js dismissPopups)
JS_DISMISS_POPUPS = r"""
() => {
    const dismiss = ['got it', 'dismiss', 'close', 'ok', 'no thanks',
                     'continue without microphone', 'continue without mic'];
    for (const btn of document.querySelectorAll('button, [role="button"]')) {
        const text = (btn.innerText || '').trim().toLowerCase();
        if (dismiss.some(d => text.includes(d))) btn.click();
    }
    for (const el of document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')) {
        const text = (el.innerText || '').trim().toLowerCase();
        if (text.includes('continue') || text.includes('got it') ||
            text.includes('use without') || text.includes('ok'))
            el.click();
    }
}
"""

# Find the Join / Ask-to-join button and return its center coords
JS_FIND_JOIN = r"""
() => {
    const targets = ['join now', 'ask to join'];
    for (const btn of document.querySelectorAll('button')) {
        const text = (btn.innerText || '').trim().toLowerCase();
        if (targets.some(t => text.includes(t))) {
            const r = btn.getBoundingClientRect();
            return { text: (btn.innerText || '').trim(), x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
    }
    for (const span of document.querySelectorAll('button span')) {
        const text = (span.innerText || '').trim().toLowerCase();
        if (targets.some(t => text.includes(t))) {
            const btn = span.closest('button');
            if (btn) {
                const r = btn.getBoundingClientRect();
                return { text: (btn.innerText || '').trim(), x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }
        }
    }
    return null;
}
"""

# Check whether the pre-join UI is visible (mic/camera toggles, join button, OR name input)
JS_PREJOIN_DETECTED = r"""
() => {
    // Check for mic/camera toggle buttons
    const buttons = document.querySelectorAll('button, [role="button"]');
    for (const btn of buttons) {
        const labels = [
            btn.getAttribute('aria-label') || '',
            btn.getAttribute('data-tooltip') || '',
            btn.getAttribute('title') || '',
        ].join(' ').toLowerCase();
        if (labels.includes('microphone') || labels.includes('camera')) return true;
    }
    // Check for Join / Ask to Join buttons
    for (const btn of document.querySelectorAll('button')) {
        const text = (btn.innerText || '').trim().toLowerCase();
        if (text.includes('join now') || text.includes('ask to join')) return true;
    }
    // Check for "Your name" input field (shown when not signed in)
    const nameInput = document.querySelector('input[placeholder="Your name"]');
    if (nameInput) return true;
    // Check for "What's your name?" text on page
    const bodyText = (document.body && document.body.innerText) || '';
    if (bodyText.includes("What's your name") || bodyText.includes("Your name")) return true;
    return false;
}
"""

# Meeting-end detection (mirrors inject.js isMeetingOver)
JS_IS_MEETING_OVER = r"""
() => {
    const text = (document.body && document.body.innerText) || '';
    return (
        text.includes('You left the meeting') ||
        text.includes('The meeting has ended') ||
        text.includes("You've been removed from the meeting") ||
        text.includes('You were removed from this meeting') ||
        text.includes('Return to home screen')
    );
}
"""


# ═══════════════════════════════════════════════════════════════════
# PersonaMeetBot
# ═══════════════════════════════════════════════════════════════════

class PersonaMeetBot:

    def __init__(self, meet_url: str, audio_file: str = "sample.mp3",
                 user_data_dir: str = None, bot_name: str = "Meeting Agent"):
        self.meet_url = self._normalize_url(meet_url)
        self.audio_file = os.path.abspath(audio_file) if audio_file else None
        self.user_data_dir = user_data_dir
        self.bot_name = bot_name
        self.playwright = None
        self.browser: Browser = None
        self.context: BrowserContext = None
        self.page: Page = None
        self.bot_active: bool = False
        self.recording_active: bool = False
        self._audio_data: bytes = None  # cached audio file bytes

    # ─── URL helpers ──────────────────────────────────────────────

    @staticmethod
    def _normalize_url(url: str) -> str:
        url = url.strip()
        if url.startswith("meet.google.com/"):
            url = "https://" + url
        return url

    @staticmethod
    def _is_valid_meet_url(url: str) -> bool:
        try:
            parsed = urlparse(url)
            return parsed.hostname == "meet.google.com" and len(parsed.path) > 1
        except Exception:
            return url.startswith("meet.google.com/") and len(url) > len("meet.google.com/")

    # ─── Main entry point ────────────────────────────────────────

    async def start(self):
        """Orchestrate the entire bot lifecycle (mirrors background.js handleOpenMeet + inject.js runBot)."""
        if not self._is_valid_meet_url(self.meet_url):
            log_error(f"Invalid Meet URL: {self.meet_url}")
            return

        has_audio = self.audio_file and os.path.exists(self.audio_file)
        if not has_audio:
            log(f"Warning: audio file not found ({self.audio_file})")
            log("Bot will join and record but won't play audio through mic")

        log("=" * 60)
        log("PERSONAMEET BOT STARTING")
        log(f"  Meet URL  : {self.meet_url}")
        log(f"  Bot name  : {self.bot_name}")
        log(f"  Audio file: {self.audio_file if has_audio else 'N/A'}")
        log(f"  Profile   : {self.user_data_dir or 'ephemeral (not logged in)'}")
        log(f"  Timestamp : {datetime.now().isoformat()}")
        log("=" * 60)

        try:
            # ── Launch & setup (mirrors background.js tab creation + offscreen setup) ──
            await self._launch_browser()
            await self._setup_page()

            # ── Navigate (mirrors background.js chrome.tabs.update) ──
            await self._navigate_to_meet()

            # ── Bot flow (mirrors inject.js runBot steps 1–12) ──

            # Step 1-2: Wait for page to fully load + UI settle
            log("Step 1: Waiting for page to load completely...")
            await self._wait_for_prejoin_ui()

            # Step 4.5: Fill in name if the name field is present (not signed in)
            log("Step 4.5: Checking for name input field...")
            await self._fill_name_if_needed()

            # Step 5: Disable mic & camera BEFORE joining
            log("Step 5: Disabling mic & camera (pre-join)...")
            await self._disable_with_retry("microphone", 8)
            log("  Microphone disabled")
            await asyncio.sleep(1)
            await self._disable_with_retry("camera", 8)
            log("  Camera disabled")

            # Step 6: Wait for toggle states to settle
            log("Step 6: Waiting 2s for toggle states to settle...")
            await asyncio.sleep(2)

            # Step 7: Click Join / Ask to Join
            log("Step 7: Clicking Join Now / Ask to Join...")
            await self._click_join()

            # Step 8: Wait for meeting to fully load
            log("Step 8: Waiting 10s for in-meeting UI to fully load...")
            await asyncio.sleep(10)
            log("  Meeting UI should be loaded")

            # Step 9: Re-verify mic & camera OFF inside the meeting
            log("Step 9: Re-verifying mic & camera are OFF (in-meeting)...")
            await self._disable_with_retry("microphone", 5)
            log("  Microphone verified OFF")
            await asyncio.sleep(0.5)
            await self._disable_with_retry("camera", 5)
            log("  Camera verified OFF")

            # Step 10: Start recording (replaces background.js startTabCapture + offscreen)
            log("Step 10: Starting audio recording...")
            await self._start_recording()

            self.bot_active = True
            log("=" * 60)
            log("BOT FULLY OPERATIONAL")
            log("All participants' audio is being captured via WebRTC interception")
            log("=" * 60)

            # Step 11: (optional) Speech recognition — skipped in Playwright version
            # The extension used Web Speech API on the physical mic; not applicable here.

            # Step 12: Monitor meeting end (runs concurrently with bot speech)
            log("Step 12: Starting meeting-end monitor...")

            # Step 13: Bot speech after 10 seconds (mirrors inject.js setTimeout)
            log("Step 13: Scheduling bot speech in 10 seconds...")
            # Run speech + monitor concurrently
            await asyncio.gather(
                self._schedule_bot_speech(),
                self._monitor_meeting_end(),
            )

            # ── Save recording (mirrors offscreen.js finalizeRecording + background.js download) ──
            await self._stop_and_save_recording()

            log("=" * 60)
            log("BOT SESSION COMPLETE")
            log("=" * 60)

        except Exception as e:
            log_error(f"Bot error: {e}")
            import traceback
            traceback.print_exc()
            # Try to save any recording data we have
            try:
                await self._stop_and_save_recording()
            except Exception:
                pass
        finally:
            await self._cleanup()

    # ─── Browser launch ──────────────────────────────────────────

    async def _launch_browser(self):
        log("Launching browser...")
        self.playwright = await async_playwright().start()

        launch_args = [
            "--use-fake-ui-for-media-stream",        # Auto-grant mic/camera permission dialogs
            "--use-fake-device-for-media-stream",     # Provide fake devices (camera feed)
            "--disable-features=WebRtcHideLocalIpsWithMdns",
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-blink-features=AutomationControlled",
            "--disable-infobars",
            "--start-maximized",                      # Open browser window maximized
        ]

        ua = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
              "AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/132.0.0.0 Safari/537.36")

        # Use a persistent profile by default so Google doesn't see
        # a fresh, never-before-seen browser each time (which triggers
        # bot-detection).  If no --profile is given we create one
        # automatically in the script directory.
        profile_dir = self.user_data_dir
        if not profile_dir:
            profile_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_persona_bot_profile")
            os.makedirs(profile_dir, exist_ok=True)
            log(f"  Using auto-created persistent profile: {profile_dir}")

        # Always use a persistent context (with real Chrome when available)
        # so cookies/fingerprint persist across runs.
        try:
            self.context = await self.playwright.chromium.launch_persistent_context(
                profile_dir,
                channel="chrome",            # ← use the REAL Chrome installation
                headless=False,
                args=launch_args,
                permissions=["microphone", "camera", "notifications"],
                ignore_https_errors=True,
                user_agent=ua,
                no_viewport=True,  # Let --start-maximized control window size
            )
            log("  Launched with real Chrome (channel='chrome')")
        except Exception as e:
            log(f"  Real Chrome not available ({e}), falling back to bundled Chromium")
            self.context = await self.playwright.chromium.launch_persistent_context(
                profile_dir,
                headless=False,
                args=launch_args,
                permissions=["microphone", "camera", "notifications"],
                ignore_https_errors=True,
                user_agent=ua,
                no_viewport=True,
            )

        self.page = self.context.pages[0] if self.context.pages else await self.context.new_page()
        log("  Browser launched")

    # ─── Page setup ──────────────────────────────────────────────

    async def _setup_page(self):
        log("Setting up page...")

        # Forward browser console to Python stdout for debugging
        self.page.on("console", lambda msg: print(
            f"        [BROWSER {msg.type.upper()}] {msg.text}", flush=True
        ))

        # Prepare audio file as a base64 data URL.
        # We inject this directly into the page via evaluate() instead of routing
        # an HTTP URL, because Meet's service worker intercepts HTTP requests
        # after page reload (Join click), causing 404s on routed URLs.
        self._audio_data_url = None
        if self.audio_file and os.path.exists(self.audio_file):
            self._audio_data = open(self.audio_file, "rb").read()
            b64 = base64.b64encode(self._audio_data).decode("ascii")
            self._audio_data_url = f"data:audio/mpeg;base64,{b64}"
            log(f"  Audio file loaded ({len(self._audio_data) / 1024:.1f} KB) as data URL")

        # Inject stealth patches to hide automation (MUST be first init script)
        await self.page.add_init_script(STEALTH_SCRIPT)
        log("  Stealth anti-detection patches injected")

        # Inject the virtual audio + recording system before page loads
        # (replaces inject.js MAIN world content script)
        await self.page.add_init_script(INIT_SCRIPT)
        log("  Virtual audio & recording system configured")

    # ─── Navigation ──────────────────────────────────────────────

    async def _navigate_to_meet(self):
        # Clear Google Meet cookies & site data so leftover session state from a
        # previous run (e.g. "you left the meeting") doesn't block re-joining.
        log("Clearing previous Meet session data...")
        try:
            await self.context.clear_cookies()
            log("  Cookies cleared")
        except Exception as e:
            log(f"  Cookie clear failed (non-fatal): {e}")

        # Also wipe localStorage / sessionStorage for the Meet origin
        try:
            await self.page.goto("https://meet.google.com", wait_until="domcontentloaded", timeout=15_000)
            await self.page.evaluate("""() => {
                try { localStorage.clear(); } catch(_) {}
                try { sessionStorage.clear(); } catch(_) {}
            }""")
            log("  localStorage/sessionStorage cleared")
        except Exception as e:
            log(f"  Storage clear failed (non-fatal): {e}")

        log(f"Navigating to {self.meet_url}...")
        await self.page.goto(self.meet_url, wait_until="domcontentloaded", timeout=60_000)
        try:
            await self.page.wait_for_load_state("load", timeout=30_000)
        except Exception:
            log("  Page load timed out — proceeding anyway")
        log("  Page loaded")

        # Step 2: Wait for UI framework to initialize (mirrors inject.js sleep(4000))
        log("Step 2: Waiting 4s for UI framework to initialize...")
        await asyncio.sleep(4)

    # ─── Pre-join UI detection ────────────────────────────────────

    async def _wait_for_prejoin_ui(self):
        """Wait up to 40s for mic/camera toggles or join button (mirrors inject.js step 3)."""
        log("Step 3: Detecting pre-join UI elements...")
        for i in range(80):  # 80 × 0.5s = 40s
            try:
                found = await self.page.evaluate(JS_PREJOIN_DETECTED)
                if found:
                    log("  Pre-join UI detected")
                    # Step 4: Additional wait (mirrors inject.js sleep(5000))
                    log("Step 4: Waiting 5s for buttons to become fully interactive...")
                    await asyncio.sleep(5)
                    return
            except Exception:
                pass
            await asyncio.sleep(0.5)
        raise TimeoutError("Pre-join UI not found within 40 seconds")

    # ─── Name field (when not signed in) ─────────────────────────

    async def _fill_name_if_needed(self):
        """
        When not signed into Google, Meet shows a 'What's your name?' text field.
        Detect it and fill in the bot name so Join Now becomes clickable.
        """
        try:
            # Look for the name input field — it's an <input> with placeholder "Your name"
            # or near the text "What's your name?"
            name_input = None

            # Strategy 1: Find input with placeholder "Your name"
            try:
                name_input = self.page.locator('input[placeholder="Your name"]')
                if await name_input.count() > 0:
                    log("  Name input field found (placeholder match)")
                else:
                    name_input = None
            except Exception:
                name_input = None

            # Strategy 2: Find any text input near "What's your name?"
            if not name_input:
                try:
                    name_input = self.page.locator('input[type="text"]').first
                    if await name_input.count() > 0:
                        # Verify it's actually a name field by checking surrounding text
                        page_text = await self.page.evaluate("() => document.body.innerText || ''")
                        if "your name" in page_text.lower() or "what's your name" in page_text.lower():
                            log("  Name input field found (text input near name prompt)")
                        else:
                            name_input = None
                    else:
                        name_input = None
                except Exception:
                    name_input = None

            # Strategy 3: Look for any input element that isn't hidden
            if not name_input:
                try:
                    name_input = self.page.locator('input:visible').first
                    if await name_input.count() > 0:
                        input_type = await name_input.get_attribute("type") or "text"
                        if input_type in ("text", "", None):
                            log("  Name input field found (visible input fallback)")
                        else:
                            name_input = None
                    else:
                        name_input = None
                except Exception:
                    name_input = None

            if name_input:
                # Clear any existing text and type the bot name
                await name_input.click()
                await name_input.fill(self.bot_name)
                await asyncio.sleep(0.5)

                # Verify the name was entered
                value = await name_input.input_value()
                if value:
                    log(f"  Name entered: \"{value}\"")
                else:
                    # Fallback: type character by character
                    log("  fill() didn't work, typing character by character...")
                    await name_input.click(triple=True)  # select all
                    await self.page.keyboard.type(self.bot_name, delay=50)
                    await asyncio.sleep(0.3)
                    log(f"  Name typed: \"{self.bot_name}\"")
            else:
                log("  No name input field found (user may be signed in)")

        except Exception as e:
            log(f"  Name field handling: {e} (continuing anyway)")

    # ─── Toggle buttons (mic / camera) ───────────────────────────

    async def _disable_with_retry(self, button_type: str, max_attempts: int = 8):
        """Disable mic or camera with retries (mirrors inject.js disableWithRetry)."""
        for attempt in range(1, max_attempts + 1):
            info = await self.page.evaluate(JS_FIND_TOGGLE, button_type)

            if info is None:
                log(f"    {button_type} button not found (attempt {attempt}/{max_attempts})")
                if attempt < max_attempts:
                    await asyncio.sleep(1.5)
                continue

            state = info["state"]

            if state == "off":
                log(f"    {button_type} already OFF")
                return True

            if state == "on":
                # Click using trusted Playwright mouse event
                await self.page.mouse.click(info["x"], info["y"])
                log(f"    {button_type} turned OFF via click")
                await asyncio.sleep(0.4)
                return True

            # Unknown state — retry
            log(f"    {button_type} state unclear, retrying...")
            if attempt < max_attempts:
                await asyncio.sleep(1.5)

        log(f"    Could not confirm {button_type} OFF after {max_attempts} attempts")
        return False

    async def _enable_toggle(self, button_type: str) -> bool:
        """Enable mic or camera (mirrors inject.js enableMicForSpeaking)."""
        for attempt in range(1, 6):
            info = await self.page.evaluate(JS_FIND_TOGGLE, button_type)

            if info is None:
                log(f"    {button_type} button not found (attempt {attempt}/5)")
                await asyncio.sleep(1)
                continue

            state = info["state"]

            if state == "on":
                log(f"    {button_type} already ON")
                return True

            if state == "off":
                log(f"    Clicking to ENABLE {button_type}...")
                await self.page.mouse.click(info["x"], info["y"])
                await asyncio.sleep(1.5)

                # Verify
                new_info = await self.page.evaluate(JS_FIND_TOGGLE, button_type)
                if new_info and new_info["state"] == "on":
                    log(f"    {button_type} ENABLED (verified)")
                    return True
                log(f"    {button_type} click may not have worked, retrying...")
                continue

            await asyncio.sleep(1)

        log(f"    Failed to enable {button_type}")
        return False

    # ─── Join button ─────────────────────────────────────────────

    async def _click_join(self):
        """Find and click Join Now / Ask to Join (mirrors inject.js clickJoin)."""
        for attempt in range(40):
            # Dismiss popups first
            try:
                await self.page.evaluate(JS_DISMISS_POPUPS)
            except Exception:
                pass

            info = await self.page.evaluate(JS_FIND_JOIN)
            if info:
                log(f"  Join button found: \"{info['text']}\"")
                await self.page.mouse.click(info["x"], info["y"])
                log("  Join button CLICKED")
                return

            if (attempt + 1) % 10 == 0:
                log(f"  Still looking for Join button — attempt {attempt + 1}/40")

            await asyncio.sleep(1)

        raise TimeoutError("Join button not found within 40 seconds")

    # ─── Recording ───────────────────────────────────────────────

    async def _start_recording(self):
        """Start recording meeting audio (replaces background.js startTabCapture + offscreen.js startCapture)."""
        for attempt in range(30):
            try:
                started = await self.page.evaluate("() => window.__personaMeetBot.startRecording()")
                if started:
                    self.recording_active = True
                    log("  Recording started")
                    return
            except Exception:
                pass

            if (attempt + 1) % 10 == 0:
                try:
                    status = await self.page.evaluate("() => window.__personaMeetBot.getStatus()")
                    log(f"  Recording attempt {attempt + 1}/30 — "
                        f"connected tracks: {status.get('connectedTracks', 0)}")
                except Exception:
                    pass

            await asyncio.sleep(1)

        # Force-start (will record silence until participants speak, then auto-capture)
        log("  Starting recording without confirmed remote tracks")
        try:
            started = await self.page.evaluate("() => window.__personaMeetBot.startRecording()")
            self.recording_active = started
            if started:
                log("  Recording started (will capture audio when participants speak)")
            else:
                log("  Could not start recording")
        except Exception as e:
            log_error(f"  Recording start failed: {e}")

    # ─── Bot speech ──────────────────────────────────────────────

    async def _schedule_bot_speech(self):
        """
        After 10 seconds, enable mic and play sample.mp3 through virtual mic.
        Mirrors inject.js step 13 (setTimeout → enableMicForSpeaking → playSongThroughMic).
        """
        if not self._audio_data_url:
            log("  No audio file — skipping bot speech")
            return

        log("  Waiting 10 seconds before bot speech...")
        await asyncio.sleep(10)

        if not self.bot_active:
            log("  Bot no longer active, skipping speech")
            return

        log("=" * 60)
        log("10 SECONDS ELAPSED — BOT WILL NOW SPEAK")
        log("=" * 60)

        try:
            # Resume AudioContext (gesture should have unlocked it from Join click)
            await self.page.evaluate("""
                async () => {
                    if (window.__personaMeetBot && window.__personaMeetBot.getVirtualAudioStream)
                        await window.__personaMeetBot.getVirtualAudioStream();
                }
            """)

            # Enable microphone (mirrors inject.js enableMicForSpeaking)
            mic_enabled = await self._enable_toggle("microphone")
            if not mic_enabled:
                raise Exception("Failed to enable microphone")

            # Small delay for Meet to process mic enable (mirrors inject.js sleep(2000))
            await asyncio.sleep(2)

            # Inject audio data URL into the page so playSong can use it.
            # We pass it via evaluate() (CDP) instead of HTTP fetch, because
            # Meet's service worker blocks routed URLs after page reload.
            log("  Injecting audio data into page...")
            await self.page.evaluate(
                "(dataUrl) => { window.__personaMeetAudioDataUrl = dataUrl; }",
                self._audio_data_url,
            )

            # Play song through virtual mic using the injected data URL
            log("  Playing audio through virtual microphone...")
            result = await self.page.evaluate("""
                async () => {
                    try {
                        const url = window.__personaMeetAudioDataUrl;
                        if (!url) throw new Error('Audio data URL not injected');
                        return await window.__personaMeetBot.playSong(url);
                    } catch (err) {
                        console.error('[PersonaMeet Bot] Song error:', err);
                        return false;
                    }
                }
            """)

            if result:
                log("  Song finished playing")
            else:
                log("  Song playback failed or was skipped")

            # Disable mic after song ends (mirrors inject.js disableMicAfterSpeaking + 1s delay)
            await asyncio.sleep(1)
            log("  Disabling microphone after song...")
            await self._disable_with_retry("microphone", 5)

        except Exception as e:
            log_error(f"Error during bot speech: {e}")

    # ─── Meeting end detection ───────────────────────────────────

    async def _monitor_meeting_end(self):
        """
        Monitor for meeting end (mirrors inject.js monitorMeetingEnd).
        Checks every 3 seconds for end-of-meeting text or page navigation.
        """
        log("  Meeting-end monitor active")
        last_url = self.page.url

        while self.bot_active:
            try:
                # Check for end-of-meeting text
                if await self.page.evaluate(JS_IS_MEETING_OVER):
                    log("=" * 60)
                    log("MEETING ENDED (detected end-of-meeting text)")
                    log("=" * 60)
                    self.bot_active = False
                    return

                # Backup: check if page navigated away from Meet
                # (mirrors background.js tabs.onUpdated listener)
                current_url = self.page.url
                if last_url != current_url:
                    if not current_url.startswith("https://meet.google.com/") or "/landing" in current_url:
                        log("=" * 60)
                        log("MEETING ENDED (page navigated away from Meet)")
                        log(f"  Old URL: {last_url}")
                        log(f"  New URL: {current_url}")
                        log("=" * 60)
                        self.bot_active = False
                        return
                    last_url = current_url

                # Periodic status log
                try:
                    status = await self.page.evaluate("() => window.__personaMeetBot.getStatus()")
                    log(f"  Monitor: recording={'active' if status.get('isRecording') else 'inactive'}"
                        f" | chunks={status.get('chunks', 0)}"
                        f" | bytes={status.get('totalBytes', 0)}"
                        f" | tracks={status.get('connectedTracks', 0)}")
                except Exception:
                    pass

            except Exception:
                # Page closed or context destroyed — meeting ended
                log("=" * 60)
                log("MEETING ENDED (page context destroyed)")
                log("=" * 60)
                self.bot_active = False
                return

            await asyncio.sleep(3)

    # ─── Save recording ─────────────────────────────────────────

    async def _stop_and_save_recording(self):
        """
        Stop recording and save audio file.
        Mirrors offscreen.js finalizeRecording + background.js downloadRecording.
        """
        if not self.recording_active:
            log("No active recording to save")
            return

        log("Stopping recording and saving...")

        try:
            data_url = await self.page.evaluate(
                "async () => await window.__personaMeetBot.stopRecording()"
            )

            if data_url:
                # Parse data URL: "data:audio/webm;base64,XXXXXX..."
                _, b64data = data_url.split(",", 1)
                audio_bytes = base64.b64decode(b64data)

                ts = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
                filename = f"meeting-recording-{ts}.webm"
                filepath = os.path.join(os.getcwd(), filename)

                with open(filepath, "wb") as f:
                    f.write(audio_bytes)

                size_kb = len(audio_bytes) / 1024
                log(f"  Recording saved: {filename}")
                log(f"  Size: {size_kb:.2f} KB")
                log(f"  Path: {filepath}")
            else:
                log("  No audio data was captured")
                log("  Possible reasons:")
                log("    - No one spoke in the meeting")
                log("    - Meeting ended immediately")
                log("    - No other participants joined")

        except Exception as e:
            log_error(f"Error saving recording: {e}")

        self.recording_active = False

    # ─── Cleanup ─────────────────────────────────────────────────

    async def _cleanup(self):
        log("Cleaning up...")
        try:
            if self.context:
                await self.context.close()
        except Exception:
            pass
        try:
            if self.browser:
                await self.browser.close()
        except Exception:
            pass
        try:
            if self.playwright:
                await self.playwright.stop()
        except Exception:
            pass
        log("  Cleanup complete")


# ═══════════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════════

async def main():
    parser = argparse.ArgumentParser(
        description="PersonaMeet Bot — Playwright Automation\n"
                    "Joins a Google Meet, records audio, and plays an audio file.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            '  python persona_meet_bot.py "https://meet.google.com/abc-defg-hij"\n'
            '  python persona_meet_bot.py "https://meet.google.com/abc-defg-hij" --audio sample.mp3\n'
            '  python persona_meet_bot.py "https://meet.google.com/abc-defg-hij" --name "My Bot"\n'
            '  python persona_meet_bot.py "https://meet.google.com/abc-defg-hij" --profile ./chrome-profile\n'
            "\n"
            "Notes:\n"
            "  - The bot uses your real Chrome installation (not Chromium) to\n"
            "    avoid Google Meet's bot detection.  Run:\n"
            "      playwright install chrome\n"
            "  - A persistent browser profile is auto-created in _persona_bot_profile/\n"
            "    so cookies/fingerprints persist across runs.\n"
            "  - Without --profile the bot enters --name into the \"Your name\" field\n"
            "    on the pre-join screen and clicks Join Now.\n"
            "  - With --profile, point to a Chrome user data directory where you're\n"
            "    already logged into your Google account.\n"
            "  - The audio file is played through a virtual microphone 10 seconds\n"
            "    after joining the meeting."
        ),
    )
    parser.add_argument("meet_url", help="Google Meet URL to join")
    parser.add_argument(
        "--audio", default="sample.mp3",
        help="Path to audio file to play through virtual mic (default: sample.mp3)",
    )
    parser.add_argument(
        "--name", default="Meeting Agent",
        help="Bot display name when not signed in (default: Meeting Agent)",
    )
    parser.add_argument(
        "--profile", default=None,
        help="Chrome user data directory for a pre-logged-in session",
    )

    args = parser.parse_args()

    bot = PersonaMeetBot(
        meet_url=args.meet_url,
        audio_file=args.audio,
        user_data_dir=args.profile,
        bot_name=args.name,
    )
    await bot.start()


if __name__ == "__main__":
    asyncio.run(main())
