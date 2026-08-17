/**
 * popup.js — Gemini Auto-Listen
 *
 * Manages the settings popup UI. Reads from and writes to chrome.storage.local.
 * Settings are propagated live to content.js via the storage.onChanged event.
 */

'use strict';

const DEFAULT_SETTINGS = {
  enabled: true,
  minWords: 5,
};

const toggleEnabled = /** @type {HTMLInputElement} */ (document.getElementById('toggle-enabled'));
const inputMinWords  = /** @type {HTMLInputElement} */ (document.getElementById('input-min-words'));
const rowMinWords    = document.getElementById('row-min-words');
const statusMsg      = document.getElementById('status-msg');

let saveTimeout = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Show a brief status message in the footer, then fade it out.
 * @param {string} text
 */
function showStatus(text) {
  statusMsg.textContent = text;
  statusMsg.classList.add('visible');
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => statusMsg.classList.remove('visible'), 1500);
}

/**
 * Apply the "disabled" visual state to the min-words row when the extension
 * is toggled off, since that setting becomes irrelevant.
 * @param {boolean} enabled
 */
function setRowDisabledState(enabled) {
  if (enabled) {
    rowMinWords.classList.remove('setting-row--disabled');
    inputMinWords.removeAttribute('disabled');
  } else {
    rowMinWords.classList.add('setting-row--disabled');
    inputMinWords.setAttribute('disabled', 'true');
  }
}

/**
 * Persist the current UI state to chrome.storage.local.
 */
async function saveSettings() {
  const minWordsRaw = parseInt(inputMinWords.value, 10);
  const minWords = isNaN(minWordsRaw) || minWordsRaw < 0 ? 0 : minWordsRaw;

  // Normalise the input display in case of invalid entry.
  inputMinWords.value = String(minWords);

  try {
    await chrome.storage.local.set({
      enabled:  toggleEnabled.checked,
      minWords: minWords,
    });
    showStatus('Saved ✓');
  } catch (err) {
    console.error('[Auto-Listen Popup] Failed to save settings:', err);
    showStatus('Error saving settings');
  }
}

// ─── Initialization ───────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Load persisted settings (fall back to defaults for any missing keys).
  let stored = DEFAULT_SETTINGS;
  try {
    stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  } catch (err) {
    console.warn('[Auto-Listen Popup] Could not load settings:', err);
  }

  // Apply to UI.
  toggleEnabled.checked = stored.enabled;
  inputMinWords.value   = String(stored.minWords);
  setRowDisabledState(stored.enabled);

  // ── Event Listeners ──────────────────────────────────────────────────────

  toggleEnabled.addEventListener('change', () => {
    setRowDisabledState(toggleEnabled.checked);
    saveSettings();
  });

  // Save on blur (leaving the field) or Enter key to avoid hammering storage
  // on every keystroke.
  inputMinWords.addEventListener('blur',    saveSettings);
  inputMinWords.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') inputMinWords.blur();
  });
});
