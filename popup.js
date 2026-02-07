// popup.js — Minimal popup: paste link + join button + live status.

document.addEventListener('DOMContentLoaded', () => {
  const LOG = '[PersonaMeet Popup]';
  const linkInput = document.getElementById('meetLink');
  const joinBtn   = document.getElementById('joinBtn');
  const statusMsg = document.getElementById('statusMsg');

  console.log(LOG, 'Popup opened');

  // ── Load saved link & current status ──────────────────────────
  chrome.storage.local.get(['lastMeetLink', 'botStatus'], (data) => {
    if (data.lastMeetLink) linkInput.value = data.lastMeetLink;
    if (data.botStatus && data.botStatus.message) {
      showStatus(data.botStatus);
    }
    refreshUI();
  });

  // ── URL input handlers (typing, pasting, etc.) ────────────────
  linkInput.addEventListener('input', handleUrlChange);
  linkInput.addEventListener('change', handleUrlChange);
  linkInput.addEventListener('keyup', handleUrlChange);
  linkInput.addEventListener('paste', () => setTimeout(handleUrlChange, 50));

  // Allow Enter key to join
  linkInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !joinBtn.disabled) joinBtn.click();
  });

  function handleUrlChange() {
    const url = linkInput.value.trim();
    chrome.storage.local.set({ lastMeetLink: url });
    refreshUI();
  }

  // ── Join button ───────────────────────────────────────────────
  joinBtn.addEventListener('click', () => {
    let url = linkInput.value.trim();

    // Auto-prepend https:// if missing
    if (url.startsWith('meet.google.com/')) {
      url = 'https://' + url;
      linkInput.value = url;
    }

    if (!isValidMeetUrl(url)) {
      showMsg('Enter a valid Google Meet link', 'error');
      return;
    }

    joinBtn.disabled = true;
    showMsg('Opening meeting…', 'info');

    chrome.runtime.sendMessage({ action: 'openMeet', url }, (res) => {
      if (chrome.runtime.lastError) {
        console.error(LOG, 'Error:', chrome.runtime.lastError.message);
        showMsg('Failed to open meeting', 'error');
        joinBtn.disabled = false;
        return;
      }
      if (res && res.error) {
        showMsg('Error: ' + res.error, 'error');
        joinBtn.disabled = false;
        return;
      }
      console.log(LOG, 'Meeting opened — tab:', res.tabId);
      showMsg('Bot is joining the meeting…', 'info');
    });
  });

  // ── Live status updates from storage ──────────────────────────
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.botStatus && changes.botStatus.newValue) {
      showStatus(changes.botStatus.newValue);
    }
  });

  // ── Helpers ───────────────────────────────────────────────────
  function refreshUI() {
    const valid = isValidMeetUrl(linkInput.value.trim());
    joinBtn.disabled = !valid;
  }

  function isValidMeetUrl(url) {
    if (!url) return false;
    try {
      const u = new URL(url);
      return u.hostname === 'meet.google.com' && u.pathname.length > 1;
    } catch {
      if (url.startsWith('meet.google.com/') && url.length > 'meet.google.com/'.length) {
        return true;
      }
      return false;
    }
  }

  function showStatus(statusObj) {
    const s = statusObj.status;
    const m = statusObj.message;

    if (s === 'recording') {
      showMsg('● REC — ' + m, 'recording');
    } else if (s === 'error') {
      showMsg(m, 'error');
      joinBtn.disabled = false;
    } else if (s === 'completed' || s === 'ended') {
      showMsg(m, 'success');
      joinBtn.disabled = false;
    } else {
      showMsg(m, 'info');
    }
  }

  function showMsg(text, type) {
    statusMsg.textContent = text;
    statusMsg.className = 'status-msg' + (type ? ' ' + type : '');
  }
});
