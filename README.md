# PersonaMeet Bot - Google Meet Automation & Recording Extension

A Chrome extension that automatically joins Google Meet sessions, disables your microphone and camera, and records the entire meeting audio to a downloadable file.

## 🎯 Features

- ✅ **Auto-Join Meetings** - Automatically joins Google Meet with one click
- 🎤 **Auto-Disable Mic** - Ensures your microphone is off before and during the meeting
- 📹 **Auto-Disable Camera** - Ensures your camera is off before and during the meeting
- 🎙️ **Meeting Audio Recording** - Records all audio from the meeting (all participants)
- 💾 **Automatic Download** - Saves recording as `.webm` file when meeting ends
- 📝 **Optional Live Transcript** - Real-time speech-to-text during the meeting (bonus feature)
- 🔄 **Smart Retry Logic** - Multiple attempts to ensure mic/camera are disabled
- 📊 **Status Tracking** - Real-time status updates in the extension popup
- 🛡️ **Safe & Isolated** - Recording happens in isolated offscreen document

---

## 📋 Requirements

- **Google Chrome** or any Chromium-based browser (Edge, Brave, Opera, etc.)
- **Chrome version**: 116 or higher (Manifest V3 support)
- **Permissions**: Extension requires tab capture and storage permissions

---

## 🚀 Installation

### Step 1: Download the Extension

1. Download or clone this repository to your computer:
   ```bash
   git clone https://github.com/yourusername/PersonaMeetExtension.git
   ```
   Or download as ZIP and extract it.

### Step 2: Enable Developer Mode in Chrome

1. Open Google Chrome
2. Navigate to **`chrome://extensions`** in the address bar
3. Toggle **"Developer mode"** ON (switch in the top-right corner)

### Step 3: Load the Extension

1. Click the **"Load unpacked"** button (top-left corner)
2. Navigate to the `PersonaMeetExtension` folder
3. Select the folder and click **"Select Folder"** (or "Open" on Mac)
4. The extension will appear in your extensions list

### Step 4: Pin the Extension (Optional but Recommended)

1. Click the **puzzle piece icon** (🧩) in Chrome's toolbar
2. Find **"PersonaMeet Bot"** in the dropdown
3. Click the **pin icon** to keep it visible in your toolbar

---

## 📖 How to Use

### Quick Start

1. **Open a new tab** in Chrome (this tab will become your meeting tab)
2. **Click the PersonaMeet Bot extension icon** in your toolbar
3. **Paste the Google Meet URL** in the input field (e.g., `https://meet.google.com/abc-defg-hij`)
4. **Click "Join Meeting"**
5. Watch as the extension:
   - Navigates to the meeting
   - Disables your microphone and camera
   - Clicks "Join Now" automatically
   - Starts recording the meeting audio
6. **During the meeting**: Extension popup shows "● REC Recording..." status
7. **When you leave**: Meeting audio automatically downloads to your Downloads folder

### What You'll See

- **Extension Popup**: Shows real-time status
  - "Bot initialising..." → Setting up
  - "Clicking Join..." → Joining meeting
  - "● REC Recording..." → Meeting in progress, recording active
  - "✓ Recording saved!" → Meeting ended, file downloaded

- **Downloaded File**: `download.webm`
  - Located in your default Downloads folder
  - WebM audio format (opus codec)
  - Can be played in Chrome, VLC, or converted to MP3

### Optional: Speech Recognition Transcript

If you enable your physical microphone during the meeting, the extension will also generate a live transcript (`meeting-transcript-[timestamp].txt`) using the Web Speech API. This is optional and separate from the audio recording.

---

## 🏗️ Technical Architecture

### File Structure

```
PersonaMeetExtension/
│
├── manifest.json         # Extension configuration & permissions
├── popup.html           # Extension popup UI
├── popup.js             # Popup logic and user interaction
├── background.js        # Service worker - orchestrates everything
├── content.js           # Message bridge (ISOLATED world)
├── inject.js            # Meet automation (MAIN world)
├── offscreen.html       # Container for offscreen recorder
├── offscreen.js         # Audio recording engine
└── README.md           # This file
```

---

## 📁 File Descriptions

### 1. **manifest.json**
- **Purpose**: Extension blueprint and configuration
- **Defines**: Permissions, content scripts, background worker, popup
- **Key Permissions**:
  - `activeTab` - Access current tab when user clicks extension
  - `tabCapture` - Capture audio from browser tabs
  - `offscreen` - Create offscreen documents for recording
  - `downloads` - Save recorded files

### 2. **popup.html** & **popup.js**
- **Purpose**: User interface when clicking extension icon
- **Features**:
  - URL input field with validation
  - Join Meeting button
  - Real-time status display
  - Pulsing recording indicator

### 3. **background.js** (Service Worker)
- **Purpose**: Brain of the extension - coordinates all components
- **Responsibilities**:
  - Manages tab creation and navigation
  - Initiates audio capture via Chrome's tabCapture API
  - Creates and manages offscreen document
  - Handles file downloads
  - Routes messages between all components
  - Monitors tab lifecycle and meeting status

**Key Functions**:
- `handleOpenMeet()` - Navigates tab to Meet URL
- `startTabCapture()` - Gets stream ID and starts recording
- `stopRecording()` - Stops capture when meeting ends

### 4. **content.js** (ISOLATED World Bridge)
- **Purpose**: Message bridge between background.js and inject.js
- **Why Needed**: Chrome's security model isolates content scripts from page JavaScript
- **Role**: Relays messages using `window.postMessage()` to cross isolation boundary

### 5. **inject.js** (MAIN World Automation)
- **Purpose**: Automates Google Meet UI interactions
- **Lives In**: Same JavaScript context as the Meet page
- **Can Access**: Page DOM directly to click buttons

**12-Step Automation Process**:
1. Wait for page to fully load
2. Wait for UI framework initialization (4s)
3. Detect pre-join UI elements
4. Wait for button interactivity (5s)
5. Disable microphone (8 retry attempts)
6. Disable camera (8 retry attempts)
7. Wait for toggle states to settle (2s)
8. Click "Join Now" button (40s timeout)
9. Wait for meeting to load (10s)
10. Re-verify mic/camera are OFF (5 retry attempts each)
11. Start optional speech recognition
12. Monitor for meeting end (DOM mutation observer)

**Key Functions**:
- `findToggleButton()` - Locates mic/camera toggles by ARIA labels
- `disableWithRetry()` - Ensures controls are disabled with retries
- `clickJoin()` - Finds and clicks Join button
- `monitorMeetingEnd()` - Detects when meeting ends

### 6. **offscreen.html** & **offscreen.js**
- **Purpose**: Hidden document that performs actual audio recording
- **Why Needed**: Service workers can't access `getUserMedia()` API
- **Process**:
  1. Receives stream ID from background
  2. Calls `getUserMedia({ chromeMediaSource: 'tab' })` with stream ID
  3. Creates MediaRecorder to encode audio
  4. Collects audio chunks every 3 seconds
  5. Converts to Blob → base64 dataURL
  6. Sends completed recording back to background for download

---

## 🔄 Complete Workflow

### Phase 1: User Initiates
```
User clicks extension → popup.html opens
→ User enters Meet URL + clicks "Join"
→ popup.js validates URL
→ Sends 'openMeet' message to background.js
```

### Phase 2: Tab Setup
```
background.js receives message
→ Gets current active tab ID (where popup was opened)
→ Navigates that tab to Meet URL (preserves activeTab permission!)
→ Waits for tab to load
→ Sends 'startBot' message to content.js
```

### Phase 3: Content Script Communication
```
background.js → content.js (chrome.runtime.sendMessage)
→ content.js → inject.js (window.postMessage)
→ inject.js receives in MAIN world
```

### Phase 4: Meet Automation
```
inject.js executes 12-step process:
→ Waits for page/UI to be ready
→ Disables microphone & camera
→ Clicks "Join Now"
→ Waits for meeting to load
→ Re-verifies controls are off
→ Sends 'joined' status back to background
```

### Phase 5: Audio Capture Starts
```
background.js sees status === 'joined'
→ Calls chrome.tabCapture.getMediaStreamId()
→ Creates offscreen document
→ Sends streamId to offscreen.js
→ offscreen.js calls getUserMedia with streamId
→ MediaRecorder starts capturing audio
```

### Phase 6: Recording in Progress
```
CONCURRENT PROCESSES:

inject.js:
  - Monitors for meeting end
  - Optional speech recognition

offscreen.js:
  - MediaRecorder collecting audio chunks every 3s
  - Health checks every 20s

background.js:
  - Status logging every 10s
  - Monitors tab events

popup.js:
  - Displays "● REC Recording..." with animation
```

### Phase 7: Meeting Ends
```
inject.js detects meeting end ("You left the meeting")
→ Sends 'ended' status to background
→ background.js calls stopRecording()
→ Sends 'stopCapture' to offscreen.js
```

### Phase 8: Finalization & Download
```
offscreen.js stops MediaRecorder
→ Combines all audio chunks into single Blob
→ Converts to base64 dataURL
→ Sends 'downloadRecording' to background
→ background.js initiates download
→ File saved to Downloads folder
→ Offscreen document closed
→ Status updated to "✓ Recording saved!"
```

---

## 🔐 Key Technical Decisions

### Why Two Content Scripts?

- **content.js (ISOLATED world)**: Can use Chrome APIs but can't access page JavaScript
- **inject.js (MAIN world)**: Can access page DOM/JavaScript to click buttons
- **Bridge**: They communicate via `window.postMessage()`

### Why Offscreen Document?

- Service workers can't call `getUserMedia()`
- Need a document context to access media APIs
- Offscreen runs invisibly with full web API access

### Why Navigate Tab Instead of Creating New One?

- `activeTab` permission granted when user clicks extension
- Permission tied to tab where popup opened
- Navigating keeps permission; new tab = no permission = capture fails

### Why Use getMediaStreamId()?

- Background has tabCapture permission but can't use getUserMedia
- Offscreen can use getUserMedia but needs stream ID from background
- Pass ID from background → offscreen for capture

---

## 🎨 Message Flow

### Between Components:

```
popup.js → background.js
  Message: {action: 'openMeet', url: 'https://...'}

background.js → content.js → inject.js
  Message: {action: 'startBot'}

inject.js → content.js → background.js
  Message: {type: 'PERSONA_STATUS', status: 'joined', message: '...'}

background.js → offscreen.js
  Message: {target: 'offscreen', action: 'startCapture', streamId: '...'}

offscreen.js → background.js
  Message: {target: 'background', action: 'recordingStarted'}

offscreen.js → background.js
  Message: {target: 'background', action: 'downloadRecording', dataUrl: '...', filename: '...'}
```

---

## 🐛 Debugging

### Service Worker Console
To see background.js logs:
1. Go to `chrome://extensions`
2. Find PersonaMeet Bot
3. Click **"Inspect views: service worker"**
4. Watch for `[PersonaMeet BG]` logs

### Offscreen Console
To see offscreen.js logs:
1. Go to `chrome://extensions`
2. Find PersonaMeet Bot
3. Click **"Inspect views: offscreen.html"**
4. Watch for `[PersonaMeet Offscreen]` logs

### Meet Tab Console
To see inject.js logs:
1. Open DevTools on the Meet tab (F12)
2. Watch for `[PersonaMeet]` logs

### Common Issues

**❌ "Extension has not been invoked" error**
- Make sure you click the extension icon from the tab you want to use for the meeting
- Don't create a separate new tab manually

**❌ No audio in recording**
- Meeting might have been silent (no one spoke)
- Check offscreen console for "Empty chunk" warnings
- Try speaking or having someone else speak in the meeting

**❌ Extension not joining meeting**
- Check Meet tab console for errors
- Ensure content scripts loaded (look for "inject.js INITIALIZING" log)
- Google Meet UI may have changed - buttons might have different labels

---

## 🔧 Development

### Prerequisites
- Node.js (optional, for any build tools)
- Chrome or Chromium-based browser
- Basic understanding of Chrome Extension APIs

### Making Changes

1. Edit the relevant files
2. Go to `chrome://extensions`
3. Click the **refresh icon** on PersonaMeet Bot
4. Test your changes

### Adding Features

- **UI changes**: Modify `popup.html` and `popup.js`
- **Automation logic**: Modify `inject.js`
- **Recording logic**: Modify `offscreen.js`
- **Orchestration**: Modify `background.js`
- **Permissions**: Update `manifest.json`

---

## ⚠️ Limitations

- Only works on **Google Meet** (meet.google.com)
- Requires **Chromium-based browser** (no Firefox support)
- **activeTab permission**: Must click extension on tab you want to use
- Recording captures **tab audio only** (not system audio from other apps)
- Works best with **speaker audio** enabled on Meet (to capture other participants)
- If you mute tab in Chrome, recording will be silent

---

## 📜 License

This project is open source and available under the MIT License.

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

### Ideas for Improvement
- Support for other video conferencing platforms (Zoom, Teams)
- Cloud upload option for recordings
- Better transcript integration
- Automatic recording to cloud storage
- Meeting notes/summary generation

---

## 📧 Support

If you encounter issues:
1. Check the debugging section above
2. Look at console logs in all three contexts (service worker, offscreen, Meet tab)
3. Open an issue on GitHub with detailed logs

---

## 🙏 Acknowledgments

Built with:
- Chrome Extension Manifest V3
- Chrome Tab Capture API
- Web MediaRecorder API
- Web Speech Recognition API (optional)

---

