# PersonaMeet Bot — Playwright Automation

A Python bot that autonomously joins a Google Meet call, records all participants' audio, and can play an audio file through a **virtual microphone** — all without any Chrome extension. Built on **Playwright** (async) with injected JavaScript that overrides browser media APIs.

---

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Installation](#installation)
4. [Usage (CLI)](#usage-cli)
5. [Architecture Overview](#architecture-overview)
6. [Complete Bot Flow (Step by Step)](#complete-bot-flow-step-by-step)
7. [Key Components In Detail](#key-components-in-detail)
   - [Stealth Script (Anti-Detection)](#1-stealth-script-anti-detection)
   - [Virtual Audio System](#2-virtual-audio-system)
   - [Recording System (WebRTC Interception)](#3-recording-system-webrtc-interception)
   - [Page-Level API (`window.__personaMeetBot`)](#4-page-level-api-window__personameetbot)
   - [JavaScript DOM Helpers](#5-javascript-dom-helpers)
   - [PersonaMeetBot Python Class](#6-personameetbot-python-class)
8. [How the Virtual Microphone Works](#how-the-virtual-microphone-works)
9. [How Audio Recording Works](#how-audio-recording-works)
10. [How Audio Playback (Bot Speech) Works](#how-audio-playback-bot-speech-works)
11. [Meeting End Detection](#meeting-end-detection)
12. [File Output](#file-output)
13. [Configuration & CLI Arguments](#configuration--cli-arguments)
14. [Troubleshooting](#troubleshooting)
15. [Project Structure](#project-structure)

---

## Overview

`persona_meet_bot.py` is a single-file, self-contained automation script that:

1. **Launches a real Chrome browser** (or bundled Chromium) with anti-bot-detection patches.
2. **Navigates to a Google Meet URL** and waits for the pre-join lobby.
3. **Disables microphone and camera** on the pre-join screen.
4. **Fills in a bot display name** if the user isn't signed into Google.
5. **Dismisses popups** (permission dialogs, "Got it" banners, etc.).
6. **Clicks "Join Now"** (or "Ask to Join").
7. **Records all meeting audio** by intercepting WebRTC peer connections.
8. **Plays an audio file** (e.g., `sample.mp3`) through a virtual mic after 10 seconds.
9. **Monitors for meeting end**, then saves the recording as a `.webm` file.

The script replaces an entire Chrome Extension stack (background service worker + content script + offscreen document) with a single Python file using Playwright's `add_init_script` and `page.evaluate`.

---

## Prerequisites

| Requirement | Version |
|-------------|---------|
| **Python**  | 3.8+    |
| **Playwright** | latest (`pip install playwright`) |
| **Chrome** (recommended) | Any recent version installed on the system |

> The bot prefers the **real Chrome installation** (`channel="chrome"`) over bundled Chromium, because Google Meet's bot-detection flags headless/automation browsers more aggressively when they use Chromium's default fingerprint.

---

## Installation

```bash
# 1. Install Python dependencies
pip install playwright

# 2. Install browser binaries (run once)
playwright install chrome
# or, for bundled Chromium fallback:
playwright install chromium

# 3. (Optional) Place an audio file named sample.mp3 in the project root
#    This is the file the bot will play through the virtual mic.
```

---

## Usage (CLI)

```bash
# Basic — join a meeting, record audio, play sample.mp3
python persona_meet_bot.py "https://meet.google.com/abc-defg-hij"

# Custom bot name
python persona_meet_bot.py "https://meet.google.com/abc-defg-hij" --name "My Bot"

# Custom audio file
python persona_meet_bot.py "https://meet.google.com/abc-defg-hij" --audio greeting.mp3

# Use a Chrome profile where you're already logged into Google
python persona_meet_bot.py "https://meet.google.com/abc-defg-hij" --profile "C:\Users\me\AppData\Local\Google\Chrome\User Data"

# No audio playback (record only)
python persona_meet_bot.py "https://meet.google.com/abc-defg-hij" --audio ""
```

| Argument | Default | Description |
|----------|---------|-------------|
| `meet_url` (positional) | *required* | Full Google Meet URL |
| `--audio` | `sample.mp3` | Path to audio file for virtual mic playback |
| `--name` | `Meeting Agent` | Bot display name (used when not signed in) |
| `--profile` | `_persona_bot_profile/` (auto-created) | Chrome user data directory for persistent sessions |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Python (Playwright)                       │
│                                                                  │
│  PersonaMeetBot class                                            │
│  ├── _launch_browser()     → Persistent Chrome context           │
│  ├── _setup_page()         → Injects STEALTH_SCRIPT + INIT_SCRIPT│
│  ├── _navigate_to_meet()   → Clears cookies, loads Meet URL      │
│  ├── _wait_for_prejoin_ui()→ Polls for lobby elements            │
│  ├── _fill_name_if_needed()→ Types bot name if not signed in     │
│  ├── _disable_with_retry() → Turns off mic/camera toggles        │
│  ├── _click_join()         → Finds & clicks "Join Now"           │
│  ├── _start_recording()    → Triggers in-page MediaRecorder      │
│  ├── _schedule_bot_speech()→ Enables mic, plays audio, disables  │
│  ├── _monitor_meeting_end()→ Watches for end-of-meeting signals  │
│  └── _stop_and_save_recording() → Retrieves data URL, saves .webm│
│                                                                  │
│         page.evaluate() ←──→ page.add_init_script()              │
│                │                      │                          │
└────────────────┼──────────────────────┼──────────────────────────┘
                 │                      │
                 ▼                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Browser (In-Page JavaScript)                 │
│                                                                  │
│  STEALTH_SCRIPT (runs first)                                     │
│  ├── Hides navigator.webdriver                                   │
│  ├── Spoofs navigator.plugins, languages                         │
│  ├── Patches Permissions API                                     │
│  └── Fixes window.chrome, outerWidth/outerHeight                 │
│                                                                  │
│  INIT_SCRIPT (runs second)                                       │
│  ├── Section 1: Virtual Audio System                             │
│  │   ├── Overrides navigator.mediaDevices.getUserMedia           │
│  │   ├── Overrides navigator.mediaDevices.enumerateDevices       │
│  │   ├── Creates AudioContext + GainNode + MediaStreamDestination│
│  │   └── Silent oscillator to keep stream alive                  │
│  │                                                               │
│  ├── Section 2: Recording System                                 │
│  │   ├── Separate recording AudioContext                         │
│  │   ├── MediaStreamDestination as audio mixer                   │
│  │   └── MediaRecorder writing chunks every 3s                   │
│  │                                                               │
│  ├── Section 3: WebRTC Interception                              │
│  │   ├── Wraps RTCPeerConnection constructor                     │
│  │   └── Auto-connects remote audio tracks to recorder           │
│  │                                                               │
│  └── Section 4: window.__personaMeetBot API                      │
│      ├── playSong(url)     → Decode + play through virtual mic   │
│      ├── startRecording()  → Start MediaRecorder                 │
│      ├── stopRecording()   → Stop & return base64 data URL       │
│      └── getStatus()       → Monitoring info                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Complete Bot Flow (Step by Step)

Below is the exact sequence of operations when you run the bot. Each step maps to a method in the `PersonaMeetBot` class.

### Phase 1: Launch & Setup

| Step | Method | What Happens |
|------|--------|-------------|
| **Launch** | `_launch_browser()` | Starts Playwright, opens a persistent Chrome context with `--use-fake-ui-for-media-stream`, `--use-fake-device-for-media-stream`, and anti-automation flags. Uses a persistent user data directory (`_persona_bot_profile/`) so cookies and fingerprints survive across runs. |
| **Setup** | `_setup_page()` | (a) Hooks browser console → Python stdout. (b) Reads the audio file from disk and encodes it as a `data:audio/mpeg;base64,...` URL. (c) Injects `STEALTH_SCRIPT` via `add_init_script` (hides automation markers). (d) Injects `INIT_SCRIPT` via `add_init_script` (installs virtual audio + recording + WebRTC interception). |

### Phase 2: Navigation

| Step | Method | What Happens |
|------|--------|-------------|
| **Clear session** | `_navigate_to_meet()` | Clears cookies, `localStorage`, and `sessionStorage` for the Meet origin so stale "You left the meeting" screens don't block re-joining. |
| **Navigate** | `_navigate_to_meet()` | Calls `page.goto(meet_url)` and waits for `domcontentloaded` + `load`. Then waits 4 seconds for Meet's SPA framework to bootstrap. |

### Phase 3: Pre-Join Lobby

| Step | Method | What Happens |
|------|--------|-------------|
| **Step 1-3** | `_wait_for_prejoin_ui()` | Polls the page every 500 ms (up to 40 s) looking for mic/camera toggle buttons, "Join Now"/"Ask to Join" buttons, or a "Your name" input field. Once detected, waits another 5 s for buttons to become fully interactive. |
| **Step 4.5** | `_fill_name_if_needed()` | If not signed in, Meet shows a "What's your name?" prompt. The bot locates the input field (tries three strategies: placeholder match → text input near name prompt → any visible input) and types the `--name` value. |
| **Step 5** | `_disable_with_retry("microphone")` / `_disable_with_retry("camera")` | Finds mic/camera toggle buttons by scanning `aria-label`, `data-tooltip`, and `title` attributes. Determines state from label text ("turn off" → ON, "turn on" → OFF). Clicks to disable if currently ON. Retries up to 8 times with 1.5 s delays. |
| **Step 6** | *(sleep 2 s)* | Lets toggle state changes settle before proceeding. |

### Phase 4: Join the Meeting

| Step | Method | What Happens |
|------|--------|-------------|
| **Step 7** | `_click_join()` | Dismisses popups (scans for "Got it", "Dismiss", "Continue without microphone", etc.), then finds a button whose text includes "join now" or "ask to join". Clicks it using Playwright's trusted mouse event. Retries up to 40 times (1 s each). |
| **Step 8** | *(sleep 10 s)* | Waits for the in-meeting UI to fully render. |
| **Step 9** | `_disable_with_retry(...)` again | Re-verifies that mic and camera are OFF inside the meeting (Meet sometimes resets toggles on join). |

### Phase 5: Recording & Bot Speech

| Step | Method | What Happens |
|------|--------|-------------|
| **Step 10** | `_start_recording()` | Calls `window.__personaMeetBot.startRecording()` via `page.evaluate()`. The in-page code starts a `MediaRecorder` on the mixed remote-audio stream. Retries up to 30 times waiting for at least one remote audio track. |
| **Step 12 + 13** | `_monitor_meeting_end()` + `_schedule_bot_speech()` | These two coroutines run **concurrently** via `asyncio.gather()`. |
| **Bot Speech** | `_schedule_bot_speech()` | After a 10-second delay: (a) resumes the AudioContext, (b) enables the mic toggle, (c) injects the base64 audio data URL into the page, (d) calls `playSong()` which decodes and plays it through the virtual mic, (e) waits for playback to finish, (f) disables the mic. |
| **Monitor** | `_monitor_meeting_end()` | Polls every 3 s for end-of-meeting indicators (page text like "You left the meeting", URL navigation away from Meet, or page context destruction). Also logs periodic recording status. |

### Phase 6: Save & Cleanup

| Step | Method | What Happens |
|------|--------|-------------|
| **Save** | `_stop_and_save_recording()` | Calls `window.__personaMeetBot.stopRecording()`, which returns a `data:audio/webm;base64,...` URL. Python decodes it and writes a `.webm` file to the current working directory (named `meeting-recording-YYYY-MM-DDTHH-MM-SS.webm`). |
| **Cleanup** | `_cleanup()` | Closes the browser context, browser instance, and Playwright process. |

---

## Key Components In Detail

### 1. Stealth Script (Anti-Detection)

**Constant:** `STEALTH_SCRIPT`  
**Injected via:** `page.add_init_script()` (runs before any page JavaScript)

Google Meet actively checks for automation markers. This script patches:

| What | Why |
|------|-----|
| `navigator.webdriver` | Playwright sets this to `true`; we override it to `undefined`. |
| `navigator.plugins` | An empty plugins array is a bot giveaway. We inject Chrome PDF Plugin, Chrome PDF Viewer, and Native Client. |
| `navigator.languages` | Set to `['en-US', 'en']` to look like a real browser. |
| `navigator.permissions.query` | Playwright returns inconsistent results for notifications; we patch it. |
| `window.chrome` / `window.chrome.runtime` | Ensure these objects exist (they're absent in headless mode). |
| `window.outerWidth` / `window.outerHeight` | Zero in headless mode; we alias them to `innerWidth`/`innerHeight`. |

### 2. Virtual Audio System

**Location:** `INIT_SCRIPT` → Section 1  
**Purpose:** Create a fake microphone that Google Meet treats as a real audio input device.

**Components:**

| Component | Role |
|-----------|------|
| `AudioContext` (48 kHz) | Central audio processing graph. Created lazily on first `getUserMedia` call. |
| `MediaStreamDestination` | The "output" node whose `.stream` property is the virtual mic's `MediaStream`. |
| `GainNode` (gain = 10.0) | Volume amplifier. Audio sources (song playback) connect through this before reaching the destination. |
| `Silent Oscillator` (440 Hz, gain 0.001) | A near-inaudible tone that keeps the `MediaStream` producing audio frames. Without it, Meet detects the stream as "dead" and may show a mic error. |

**API Overrides:**

- **`navigator.mediaDevices.enumerateDevices()`** — If no physical `audioinput` device exists, injects a fake device entry (`deviceId: 'virtual-persona-mic'`, `label: 'PersonaMeet Virtual Microphone'`).
- **`navigator.mediaDevices.getUserMedia(constraints)`** — When `constraints.audio` is requested, returns the virtual `MediaStream` instead of accessing real hardware. If video is also requested, it fetches a real video stream and combines it with the virtual audio tracks.

### 3. Recording System (WebRTC Interception)

**Location:** `INIT_SCRIPT` → Sections 2 & 3  
**Purpose:** Capture all remote participants' audio without `chrome.tabCapture`.

**How it works:**

1. **RTCPeerConnection Wrapper** (Section 3):
   - The original `RTCPeerConnection` constructor is replaced with `PersonaRTCPeerConnection`.
   - Every time Google Meet creates a peer connection (one per remote participant), the wrapper adds a `'track'` event listener.
   - When a remote **audio** track arrives, it's passed to `connectTrackToRecorder()`.
   - The wrapper preserves the prototype chain and static methods so `instanceof` checks still work.

2. **Audio Mixer** (Section 2):
   - A **separate** `AudioContext` (`recCtx`, 48 kHz) is used for recording (distinct from the virtual mic's `AudioContext`).
   - `recCtx.createMediaStreamDestination()` → `recDest` serves as the mixer output.
   - Each remote audio track is wrapped in a `MediaStreamSource` and connected to `recDest`.
   - New tracks arriving mid-meeting are automatically connected (hot-plugging).

3. **MediaRecorder**:
   - Records from `recDest.stream` using MIME type `audio/webm;codecs=opus` (falls back to `audio/webm`).
   - Chunks are collected every 3 seconds (`mediaRecorder.start(3000)`).
   - On stop, all chunks are concatenated into a `Blob`, converted to a base64 data URL via `FileReader`, and returned to Python.

### 4. Page-Level API (`window.__personaMeetBot`)

**Location:** `INIT_SCRIPT` → Section 4  
**Purpose:** Bridge between Python (Playwright `page.evaluate()`) and the in-page audio system.

| Method | Returns | Description |
|--------|---------|-------------|
| `getVirtualAudioStream()` | `Promise<MediaStream>` | Creates or returns the virtual mic stream. |
| `playSong(songUrl)` | `Promise<boolean>` | Fetches the audio URL, decodes it with `AudioContext.decodeAudioData()`, creates a `BufferSource`, connects it through the `GainNode`, and plays it. Resolves `true` when the song finishes. |
| `isSpeaking()` | `boolean` | Whether a song is currently playing. |
| `startRecording()` | `boolean` | Starts the `MediaRecorder`. Returns `false` if no audio tracks are connected yet. |
| `stopRecording()` | `Promise<string\|null>` | Stops the recorder and returns the full recording as a `data:audio/webm;base64,...` URL, or `null` if no data was captured. |
| `getStatus()` | `object` | Returns `{ isRecording, chunks, totalBytes, connectedTracks, isSpeaking }` for monitoring. |

### 5. JavaScript DOM Helpers

These are JS snippets evaluated via `page.evaluate()` to interact with Google Meet's UI:

| Constant | Purpose |
|----------|---------|
| `JS_FIND_TOGGLE` | Scans all buttons/role="button" elements for mic or camera toggles. Reads `aria-label`/`data-tooltip`/`title` to determine state (`on`/`off`/`unknown`) and returns button center coordinates for Playwright mouse clicks. |
| `JS_DISMISS_POPUPS` | Clicks any button containing text like "Got it", "Dismiss", "Close", "Continue without microphone", etc. Also handles `role="dialog"` and `role="alertdialog"` containers. |
| `JS_FIND_JOIN` | Searches for a button whose text includes "join now" or "ask to join". Falls back to checking nested `<span>` elements inside buttons. Returns button center coordinates. |
| `JS_PREJOIN_DETECTED` | Returns `true` if the pre-join lobby is visible: checks for mic/camera toggle buttons, join buttons, "Your name" input, or "What's your name?" text. |
| `JS_IS_MEETING_OVER` | Returns `true` if the page contains end-of-meeting text ("You left the meeting", "The meeting has ended", "You've been removed", "Return to home screen"). |

### 6. PersonaMeetBot Python Class

**Constructor Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `meet_url` | `str` | *required* | Google Meet URL (auto-prepends `https://` if missing) |
| `audio_file` | `str` | `"sample.mp3"` | Path to the audio file for virtual mic playback |
| `user_data_dir` | `str` | `None` | Chrome user data directory (auto-creates `_persona_bot_profile/` if None) |
| `bot_name` | `str` | `"Meeting Agent"` | Display name when not signed into Google |

**Key Methods:**

| Method | Async | Description |
|--------|-------|-------------|
| `start()` | Yes | Main entry point. Orchestrates the entire bot lifecycle from launch to cleanup. |
| `_launch_browser()` | Yes | Launches Chrome with persistent context, anti-detection flags, and auto-granted permissions. |
| `_setup_page()` | Yes | Injects stealth + init scripts, loads audio file as base64 data URL. |
| `_navigate_to_meet()` | Yes | Clears session data, navigates to the Meet URL, waits for load. |
| `_wait_for_prejoin_ui()` | Yes | Polls for lobby UI elements (up to 40 s). |
| `_fill_name_if_needed()` | Yes | Detects and fills the "Your name" input field using three strategies. |
| `_disable_with_retry(button_type, max_attempts)` | Yes | Finds a toggle button and clicks to disable it, with retries. |
| `_enable_toggle(button_type)` | Yes | Finds a toggle button and clicks to enable it, with verification. |
| `_click_join()` | Yes | Dismisses popups, finds and clicks the Join button (40 retries). |
| `_start_recording()` | Yes | Calls the in-page `startRecording()` API with retries (30 attempts). |
| `_schedule_bot_speech()` | Yes | Waits 10 s, enables mic, injects & plays audio, disables mic. |
| `_monitor_meeting_end()` | Yes | Polls every 3 s for meeting-end signals; sets `bot_active = False`. |
| `_stop_and_save_recording()` | Yes | Stops recorder, decodes base64 data URL, writes `.webm` file. |
| `_cleanup()` | Yes | Closes context, browser, and Playwright process. |

---

## How the Virtual Microphone Works

This is the core trick that lets the bot "speak" in a Google Meet without a physical microphone.

```
                    ┌───────────────────────────────────────┐
                    │          AudioContext (48 kHz)          │
                    │                                        │
  Audio File ──►  [BufferSource] ──► [GainNode 10x] ──►     │
                                                        [MediaStreamDestination]
  Silent Osc ──► [Gain 0.001] ─────────────────────►        │
                    │                    │                    │
                    │                    ▼                    │
                    │             virtualStream              │
                    │          (MediaStream object)           │
                    └───────────────────┬───────────────────┘
                                        │
                    getUserMedia({audio:true}) returns this
                                        │
                                        ▼
                              Google Meet treats it
                              as a real microphone
```

1. **`enumerateDevices` override** — Injects a fake `audioinput` device so Meet's device picker sees a microphone.
2. **`getUserMedia` override** — When Meet requests audio, it receives the `virtualStream` (output of `MediaStreamDestination`).
3. **Silent oscillator** — A 440 Hz tone at gain 0.001 keeps the stream "alive" so Meet doesn't flag it as broken.
4. **Song playback** — The audio file is decoded into an `AudioBuffer`, wrapped in a `BufferSource`, connected through a `GainNode` (10x volume boost) to the same destination. Meet's WebRTC pipeline picks it up and transmits it to other participants.

---

## How Audio Recording Works

Instead of using `chrome.tabCapture` (extension-only API), the bot intercepts WebRTC at the JavaScript level.

```
  Other Participants
        │
        │ WebRTC (audio tracks)
        ▼
┌─────────────────────────────┐
│  RTCPeerConnection Wrapper   │
│  (PersonaRTCPeerConnection)  │
│                              │
│  on 'track' event:           │
│    if kind === 'audio'       │
│      connectTrackToRecorder()│
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────────────────────┐
│        Recording AudioContext (48 kHz)         │
│                                                │
│  [MediaStreamSource A] ──►                     │
│  [MediaStreamSource B] ──► [MediaStreamDest]   │
│  [MediaStreamSource C] ──►       │             │
│                                  ▼             │
│                          mixed audio stream    │
│                                  │             │
│                          [MediaRecorder]       │
│                           chunks every 3s      │
│                                  │             │
│                          recordedChunks[]      │
└──────────────────────────────────────────────┘
                                   │
                      stopRecording() called
                                   │
                                   ▼
                        Blob → FileReader → base64 data URL
                                   │
                        page.evaluate() returns to Python
                                   │
                                   ▼
                        base64.b64decode → .webm file on disk
```

1. **RTCPeerConnection is monkey-patched** — Every new peer connection created by Meet passes through our wrapper.
2. **Remote audio tracks** are captured via the `'track'` event and wrapped in `MediaStreamSource` nodes.
3. **All tracks are mixed** into a single `MediaStreamDestination` (acts as an audio mixer).
4. **MediaRecorder** encodes the mixed stream as WebM/Opus, collecting data every 3 seconds.
5. **On stop**, chunks are merged into a `Blob`, read as a base64 data URL, and returned to Python.

---

## How Audio Playback (Bot Speech) Works

10 seconds after joining the meeting, the bot plays an audio file through the virtual microphone.

**Sequence:**

1. `_schedule_bot_speech()` waits 10 seconds.
2. Resumes the `AudioContext` (may be suspended due to Chrome's autoplay policy — the Join click gesture should have unlocked it).
3. Calls `_enable_toggle("microphone")` — finds the mic button in the UI and clicks to unmute.
4. Waits 2 seconds for Meet to activate the mic.
5. Injects the base64 audio data URL into the page as `window.__personaMeetAudioDataUrl`.
6. Calls `window.__personaMeetBot.playSong(dataUrl)`:
   - `fetch()` retrieves the data URL (instant, since it's base64-encoded).
   - `audioContext.decodeAudioData()` converts it to a raw `AudioBuffer`.
   - A `BufferSource` is created, connected through the `GainNode` (10x volume) to the `MediaStreamDestination`.
   - `.start(0)` begins playback.
   - The `onended` callback resolves the promise when the song finishes.
7. Waits 1 second, then clicks the mic button to mute again.

> **Why base64 data URL instead of HTTP?**  
> Google Meet registers a service worker that intercepts HTTP requests after the page reloads (when "Join Now" is clicked). Playwright's `page.route()` URLs get 404'd by the service worker. Using a `data:` URL bypasses this entirely.

---

## Meeting End Detection

The `_monitor_meeting_end()` coroutine runs concurrently with bot speech and checks for these signals every 3 seconds:

| Signal | Detection Method |
|--------|-----------------|
| **"You left the meeting"** | Page body text check |
| **"The meeting has ended"** | Page body text check |
| **"You've been removed from the meeting"** | Page body text check |
| **"You were removed from this meeting"** | Page body text check |
| **"Return to home screen"** | Page body text check |
| **Page navigated away from Meet** | URL comparison (e.g., redirected to `/landing`) |
| **Page/context destroyed** | Exception handler catches Playwright disconnect |

When any signal is detected, `bot_active` is set to `False`, which causes the monitor to exit and triggers the recording save.

---

## File Output

Recordings are saved to the **current working directory**:

```
meeting-recording-2026-02-22T14-30-00.webm
```

- **Format:** WebM container with Opus audio codec
- **Naming:** `meeting-recording-{ISO timestamp}.webm`
- **Content:** Mixed audio from all remote participants (not the bot's own virtual mic output)

---

## Configuration & CLI Arguments

```
python persona_meet_bot.py <meet_url> [--audio FILE] [--name NAME] [--profile DIR]
```

| Argument | Default | Description |
|----------|---------|-------------|
| `meet_url` | *(required)* | Google Meet URL. Accepts with or without `https://` prefix. |
| `--audio` | `sample.mp3` | Audio file to play through the virtual mic. Set to empty string to skip playback. |
| `--name` | `Meeting Agent` | Display name shown in the Meet lobby when not signed into Google. |
| `--profile` | Auto-created `_persona_bot_profile/` | Chrome user data directory. Use this to point to a profile where you're already signed into Google. |

### Browser Launch Flags

These Chrome flags are applied automatically:

| Flag | Purpose |
|------|---------|
| `--use-fake-ui-for-media-stream` | Auto-grants mic/camera permission dialogs |
| `--use-fake-device-for-media-stream` | Provides a fake camera feed (green screen) |
| `--disable-features=WebRtcHideLocalIpsWithMdns` | Prevents mDNS IP masking in WebRTC |
| `--no-sandbox` | Required in some environments |
| `--disable-blink-features=AutomationControlled` | Hides the `AutomationControlled` flag |
| `--disable-infobars` | Removes "Chrome is being controlled" infobar |
| `--start-maximized` | Opens the window maximized |

---

## Troubleshooting

| Problem | Cause | Solution |
|---------|-------|----------|
| **"Pre-join UI not found within 40 seconds"** | Meet didn't load or shows a login/error page | Use `--profile` with a Google-signed-in Chrome profile, or check your network |
| **"Join button not found within 40 seconds"** | Popup blocking the Join button, or page layout changed | The bot auto-dismisses known popups; check console logs for clues |
| **No audio recorded (0 bytes)** | No other participants spoke, or WebRTC tracks weren't connected | Check the "connected tracks" count in logs; ensure others join and speak |
| **Bot detected / "Couldn't verify you're not a robot"** | Google flagged the browser fingerprint | Use `--profile` with a real Chrome profile, or run `playwright install chrome` to use real Chrome |
| **"Real Chrome not available"** | Chrome isn't installed or `playwright install chrome` wasn't run | Run `playwright install chrome` |
| **Song playback failed** | Audio file missing, corrupt, or AudioContext suspended | Check `--audio` path; ensure the file is a valid MP3/WAV; check browser console for decode errors |
| **Mic/camera didn't toggle** | Meet's UI changed button labels/attributes | Check `JS_FIND_TOGGLE` patterns against current Meet UI; update `aria-label` patterns if needed |

---

## Project Structure

```
PersonaMeetExtension/
├── persona_meet_bot.py          ← Main bot script (this file)
├── sample.mp3                   ← (Optional) Audio file for virtual mic playback
├── _persona_bot_profile/        ← Auto-created Chrome persistent profile
│   ├── Default/                 ← Chrome profile data (cookies, storage, etc.)
│   └── ...
├── meeting-recording-*.webm     ← Output recordings (created after meetings)
│
├── manifest.json                ← Chrome Extension manifest (extension version)
├── background.js                ← Extension background service worker
├── content.js                   ← Extension content script
├── inject.js                    ← Extension injected script (MAIN world)
├── offscreen.html / .js         ← Extension offscreen document for recording
├── popup.html / .js             ← Extension popup UI
└── README.md                    ← Project-level README
```

> **Note:** The Chrome Extension files (`manifest.json`, `background.js`, `content.js`, `inject.js`, `offscreen.*`, `popup.*`) are the original extension version of this project. `persona_meet_bot.py` is the standalone Playwright port that consolidates all extension functionality into a single Python script.
