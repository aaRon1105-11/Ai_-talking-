/**
 * content.js — Gemini Auto-Listen
 *
 * Automatically triggers the built-in "Listen" (text-to-speech) feature on
 * gemini.google.com whenever a new AI response finishes streaming.
 *
 * ── HOW DETECTION WORKS ────────────────────────────────────────────────────
 * Gemini's DOM uses obfuscated/changing class names, so we rely exclusively on
 * stable ARIA attributes and DOM structure. Three strategies run in cascade:
 *
 *   Strategy 1 (primary): Watch for the "Stop generating" button to DISAPPEAR.
 *     The stop-button is only present during active streaming and removed the
 *     moment generation is complete — this is the most reliable signal.
 *
 *   Strategy 2 (fallback): Watch for a "Listen" button to appear directly on
 *     the action bar using a battery of aria-label selectors.
 *
 *   Strategy 3 (fallback): MutationObserver debounce — if DOM mutations stop
 *     for DEBOUNCE_MS milliseconds after active generation, we attempt to trigger.
 *
 * All console output is prefixed with "[Auto-Listen]" for easy filtering.
 *
 * @version 1.2.0
 */

'use strict';

// ─── CONFIGURABLE SELECTOR BANK ──────────────────────────────────────────────
// Add new selectors to the START of each array so the most current one is
// tried first. Old ones remain as fallbacks.

/** Direct "Listen" buttons visible in the action bar (no menu needed). */
const LISTEN_BUTTON_SELECTORS = [
  'button[aria-label*="Listen" i]',
  'button[aria-label="Listen to response"]',
  'button[aria-label="Listen"]',
  'button[aria-label="Read aloud"]',
  'button[aria-label*="Read aloud" i]',
  'button[aria-label="Play"]',
];

/** The three-dot / "More options" menu button on an AI turn's action bar. */
const MORE_BUTTON_SELECTORS = [
  'button[aria-label="More options"]',
  'button[aria-label="More"]',
  'button[aria-label="Response options"]',
  'button[aria-label="Message actions"]',
];

/** "Listen" as a menu item inside the kebab/more menu. */
const LISTEN_MENU_ITEM_SELECTORS = [
  '[role="menuitem"][aria-label*="Listen" i]',
  '[role="menuitem"][aria-label="Listen to response"]',
  '[role="menuitem"][aria-label="Listen"]',
  '[role="menuitem"][aria-label*="Read aloud" i]',
  '[role="menuitem"][aria-label="Read aloud"]',
  // Text-content fallback is handled separately in findMenuItemByText().
];

/** The button present *only while* Gemini is streaming a response. */
const STOP_BUTTON_SELECTORS = [
  'button[aria-label*="Stop" i]',
  'button[aria-label="Stop generating"]',
  'button[aria-label="Cancel"]',
  'button[aria-label="Stop"]',
];

const RESPONSE_BLOCK_SELECTORS = [
  'model-response',
  '[data-message-author-role="model"]',
  'message-content.model-response-text',
  '.response-container',
];

/**
 * How far up the DOM to walk when looking for the turn container that holds
 * both <model-response> and its sibling action buttons.
 */
const MAX_ANCESTOR_WALK = 8;

// ─── TIMING CONSTANTS ────────────────────────────────────────────────────────

/** Debounce delay after a DOM mutation before running checks. */
const DEBOUNCE_MS = 600;

/** Settling delay after stop-button disappears before trying to click Listen. */
const POST_STOP_DELAY_MS = 800;

/** How long to wait for the "More" dropdown menu to render. */
const MENU_OPEN_DELAY_MS = 350;

/** Retry count for scanning for a menu item after the menu opens. */
const MENU_SCAN_RETRIES = 5;

/** Delay between menu-scan retries. */
const MENU_RETRY_DELAY_MS = 200;

// ─── EXTENSION STATE ─────────────────────────────────────────────────────────

let settings = {
  enabled: true,
  minWords: 5,
};

/** Prevents concurrent runs of maybeAutoListen(). */
let isProcessing = false;

/** Tracks if active generation has been observed in the current turn. */
let hasActivelyGenerated = false;

/** The root MutationObserver. */
let mainObserver = null;

/** Debounce timer handle for the observer. */
let debounceTimer = null;

/** Tracks whether the stop-button was present on the last sentinel tick. */
let stopBtnPresent = false;

/** The setInterval handle for the stop-button sentinel. */
let stopSentinelHandle = null;

/** Last known href — used to detect SPA navigation. */
let lastHref = location.href;

// ─── SETTINGS MANAGEMENT ─────────────────────────────────────────────────────

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get({ enabled: true, minWords: 5 });
    settings = stored;
    console.log('[Auto-Listen] Settings loaded:', settings);
  } catch (err) {
    console.warn('[Auto-Listen] Could not load settings, using defaults:', err);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.enabled !== undefined) {
    settings.enabled = changes.enabled.newValue;
    console.log('[Auto-Listen] "enabled" updated to:', settings.enabled);
  }
  if (changes.minWords !== undefined) {
    settings.minWords = changes.minWords.newValue;
    console.log('[Auto-Listen] "minWords" updated to:', settings.minWords);
  }
});

// ─── SHADOW DOM TRAVERSAL ────────────────────────────────────────────────────
// Gemini uses Shadow DOM (Web Components) extensively. We traverse open shadow roots efficiently.

/**
 * Efficiently query for the FIRST element matching `selector` across open shadow roots.
 * @param {string} selector
 * @param {Element|Document|ShadowRoot} root
 * @returns {Element|null}
 */
function deepQuerySelector(selector, root = document) {
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    try {
      const match = current.querySelector(selector);
      if (match) return match;
    } catch (_) { /* ignore malformed selector */ }

    // Check child shadow roots
    const children = current.children || current.childNodes || [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.shadowRoot) queue.push(child.shadowRoot);
        // If current wasn't full document, traverse element hierarchy
        if (root !== document && child.children && child.children.length > 0) {
          queue.push(child);
        }
      }
    }
  }
  return null;
}

/**
 * Efficiently query for ALL elements matching `selector` across open shadow roots.
 * @param {string} selector
 * @param {Element|Document|ShadowRoot} root
 * @returns {Element[]}
 */
function deepQuerySelectorAll(selector, root = document) {
  let results = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    try {
      const matches = current.querySelectorAll(selector);
      if (matches.length > 0) {
        results = results.concat(Array.from(matches));
      }
    } catch (_) { /* ignore malformed selector */ }

    const children = current.children || current.childNodes || [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.shadowRoot) queue.push(child.shadowRoot);
        if (root !== document && child.children && child.children.length > 0) {
          queue.push(child);
        }
      }
    }
  }
  return results;
}

// ─── SELECTOR UTILITIES ──────────────────────────────────────────────────────

/**
 * Returns the first match for any selector in the array.
 * @param {string[]} selectors
 * @param {Element|Document} [root=document]
 * @returns {Element|null}
 */
function queryAny(selectors, root = document) {
  for (const sel of selectors) {
    const el = deepQuerySelector(sel, root);
    if (el) return el;
  }
  return null;
}

/**
 * Returns all matches for the first selector in the array that yields results.
 * @param {string[]} selectors
 * @param {Element|Document} [root=document]
 * @returns {Element[]}
 */
function queryAllAny(selectors, root = document) {
  for (const sel of selectors) {
    const els = deepQuerySelectorAll(sel, root);
    if (els.length > 0) return els;
  }
  return [];
}

/** @returns {boolean} True while Gemini is actively streaming. */
function isGenerating() {
  return queryAny(STOP_BUTTON_SELECTORS) !== null;
}

/**
 * Returns the latest <model-response> (or equivalent) element.
 * @returns {Element|null}
 */
function getLatestResponseBlock() {
  const all = queryAllAny(RESPONSE_BLOCK_SELECTORS);
  return all.length > 0 ? all[all.length - 1] : null;
}

/**
 * Walk UP from the response block to find the ancestor turn container that holds
 * both the response text and its sibling action buttons, without escaping into the multi-turn container.
 *
 * @param {Element} responseBlock  The <model-response> element.
 * @returns {Element}
 */
function getTurnContainer(responseBlock) {
  let node = responseBlock;

  for (let i = 0; i < MAX_ANCESTOR_WALK; i++) {
    if (!node.parentElement || node.parentElement === document.body) break;
    node = node.parentElement;

    // If this container contains multiple response blocks, we walked too far (into global chat container)
    const containedResponses = queryAllAny(RESPONSE_BLOCK_SELECTORS, node);
    if (containedResponses.length > 1) {
      // Step back down to the previous container
      return responseBlock.parentElement || responseBlock;
    }

    const hasListenBtn = queryAny(LISTEN_BUTTON_SELECTORS, node) !== null;
    const hasMoreBtn   = queryAny(MORE_BUTTON_SELECTORS, node) !== null;

    if (hasListenBtn || hasMoreBtn) {
      console.log(`[Auto-Listen] Turn container found after walking ${i + 1} level(s) up.`);
      return node;
    }
  }

  return node;
}

/**
 * Collect text from an element including open Shadow DOM, ignoring style/script tags.
 * @param {Node} node
 * @returns {string}
 */
function collectDeepText(node) {
  if (!node) return '';
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
  if (node.nodeType === Node.ELEMENT_NODE) {
    const tag = (node.tagName || '').toUpperCase();
    if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'NOSCRIPT') return '';
  }

  let parts = '';
  if (node.nodeType === Node.ELEMENT_NODE && node.shadowRoot) {
    parts += collectDeepText(node.shadowRoot);
  }
  const children = node.childNodes || [];
  for (let i = 0; i < children.length; i++) {
    parts += ' ' + collectDeepText(children[i]);
  }
  return parts;
}

/**
 * Counts words in a response block's visible text, including open Shadow DOM.
 * @param {Element} block
 * @returns {number}
 */
function countWords(block) {
  const deepText = collectDeepText(block).trim();
  if (!deepText) return 0;
  return deepText.split(/\s+/).filter(Boolean).length;
}

/**
 * Search for a "Listen" menu item scoped to the open [role="menu"] element.
 * @returns {Element|null}
 */
function findListenMenuItem() {
  const openMenu = deepQuerySelector('[role="menu"]');
  const searchRoot = openMenu ?? document;

  // 1. Try ARIA-label selectors.
  const byAriaLabel = queryAny(LISTEN_MENU_ITEM_SELECTORS, searchRoot);
  if (byAriaLabel) return byAriaLabel;

  // 2. Text-content fallback: scan all menu items for "listen" or "read aloud".
  const allItems = deepQuerySelectorAll(
    '[role="menuitem"], [role="option"]', searchRoot
  );
  return allItems.find(el => {
    const label = (el.getAttribute('aria-label') || el.textContent || '').toLowerCase();
    return label.includes('listen') || label.includes('read aloud');
  }) ?? null;
}

// ─── LISTEN TRIGGER LOGIC ────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Try to click a "Listen" button that is directly visible in the turn container.
 * @param {Element} turnContainer
 * @returns {boolean}
 */
function tryDirectListenButton(turnContainer) {
  const allButtons = [];
  for (const sel of LISTEN_BUTTON_SELECTORS) {
    const matches = deepQuerySelectorAll(sel, turnContainer);
    if (matches.length > 0) {
      allButtons.push(...matches);
    }
  }
  if (allButtons.length === 0) return false;

  // Pick the last matching button (closest to this turn's bottom action bar)
  const btn = allButtons[allButtons.length - 1];

  if (btn.dataset.autoListened === 'true') {
    console.log('[Auto-Listen] Direct button already marked, skipping.');
    return false;
  }

  console.log('[Auto-Listen] ✅ Found direct Listen button, clicking.');
  btn.dataset.autoListened = 'true';
  btn.click();
  return true;
}

/**
 * Open the "More options" kebab menu and click the "Listen" item inside it.
 * @param {Element} turnContainer
 * @returns {Promise<boolean>}
 */
async function tryMenuListenItem(turnContainer) {
  const allMoreButtons = [];
  for (const sel of MORE_BUTTON_SELECTORS) {
    const matches = deepQuerySelectorAll(sel, turnContainer);
    if (matches.length > 0) {
      allMoreButtons.push(...matches);
    }
  }
  if (allMoreButtons.length === 0) {
    console.log('[Auto-Listen] No "More" menu button found on turn container.');
    return false;
  }

  const moreBtn = allMoreButtons[allMoreButtons.length - 1];
  if (moreBtn.dataset.autoListened === 'true') {
    console.log('[Auto-Listen] More button already marked, skipping.');
    return false;
  }

  console.log('[Auto-Listen] Opening "More options" menu…');
  moreBtn.click();
  await sleep(MENU_OPEN_DELAY_MS);

  // Retry: the menu may need a frame or two to render.
  let menuItem = null;
  for (let attempt = 0; attempt < MENU_SCAN_RETRIES; attempt++) {
    menuItem = findListenMenuItem();
    if (menuItem) break;
    console.log(
      `[Auto-Listen] Menu scan attempt ${attempt + 1}/${MENU_SCAN_RETRIES}` +
      ' — item not yet visible.'
    );
    await sleep(MENU_RETRY_DELAY_MS);
  }

  if (!menuItem) {
    console.warn('[Auto-Listen] "Listen" item not found in menu — closing and aborting.');
    document.body.click();
    return false;
  }

  console.log('[Auto-Listen] ✅ Found "Listen" menu item, clicking.');
  moreBtn.dataset.autoListened = 'true';
  menuItem.click();

  // Give the menu time to self-close, then force-dismiss if still open.
  await sleep(150);
  if (deepQuerySelector('[role="menu"]')) {
    console.log('[Auto-Listen] Menu still open after item click — dismissing.');
    document.body.click();
  }
  return true;
}

/**
 * Core handler: tries to trigger Listen on the newest response block.
 */
async function maybeAutoListen() {
  if (!settings.enabled) return;
  if (isGenerating()) {
    console.log('[Auto-Listen] Still generating — waiting.');
    return;
  }
  if (isProcessing) {
    console.log('[Auto-Listen] Already processing — skipping.');
    return;
  }

  // Only auto-play if active generation was observed
  if (!hasActivelyGenerated) {
    return;
  }

  const responseBlock = getLatestResponseBlock();
  if (!responseBlock) {
    console.log('[Auto-Listen] No response block found in DOM.');
    return;
  }

  // Skip if this block was already auto-played.
  if (responseBlock.dataset.autoListened === 'true') return;

  // Word-count guard — skip very short responses.
  const wordCount = countWords(responseBlock);
  if (wordCount < settings.minWords) {
    console.log(
      `[Auto-Listen] Response too short (${wordCount} words < ${settings.minWords}). Skipping.`
    );
    responseBlock.dataset.autoListened = 'true';
    hasActivelyGenerated = false;
    return;
  }

  isProcessing = true;
  console.log(`[Auto-Listen] Attempting auto-listen (~${wordCount} words).`);

  try {
    const turnContainer = getTurnContainer(responseBlock);

    // Strategy 1: click a directly visible Listen button.
    if (tryDirectListenButton(turnContainer)) {
      responseBlock.dataset.autoListened = 'true';
      hasActivelyGenerated = false;
      return;
    }

    // Strategy 2: open the More menu and click Listen inside it.
    const success = await tryMenuListenItem(turnContainer);
    if (success) {
      responseBlock.dataset.autoListened = 'true';
      hasActivelyGenerated = false;
      return;
    }

    console.warn(
      '[Auto-Listen] ⚠️  Could not find a Listen button or menu item. ' +
      'Gemini\'s UI may have changed — see README.md for the selector update guide.'
    );
  } catch (err) {
    console.error('[Auto-Listen] Unexpected error:', err);
  } finally {
    isProcessing = false;
  }
}

// ─── EXISTING-BLOCK TAGGING ───────────────────────────────────────────────────

/**
 * Mark all currently visible response blocks as already-processed.
 */
function tagExistingBlocks() {
  const existingBlocks = queryAllAny(RESPONSE_BLOCK_SELECTORS);
  existingBlocks.forEach(block => {
    block.dataset.autoListened = 'true';
  });
  console.log(`[Auto-Listen] Tagged ${existingBlocks.length} existing response block(s).`);
}

// ─── MUTATION OBSERVER ───────────────────────────────────────────────────────

function startObserver() {
  if (mainObserver) mainObserver.disconnect();

  mainObserver = new MutationObserver(() => {
    // Detect SPA navigation on every mutation callback.
    if (location.href !== lastHref) {
      lastHref = location.href;
      hasActivelyGenerated = false;
      clearTimeout(debounceTimer);
      tagExistingBlocks();
      console.log('[Auto-Listen] SPA navigation detected — retagged existing blocks.');
      return;
    }

    if (isGenerating()) {
      hasActivelyGenerated = true;
    }

    // Standard debounced check for generation completion.
    if (hasActivelyGenerated) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(maybeAutoListen, DEBOUNCE_MS);
    }
  });

  mainObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });

  console.log('[Auto-Listen] MutationObserver started.');
}

// ─── STOP-BUTTON SENTINEL ─────────────────────────────────────────────────────

/**
 * Poll for the stop-button → gone transition.
 */
function startStopButtonSentinel() {
  if (stopSentinelHandle) clearInterval(stopSentinelHandle);

  stopSentinelHandle = setInterval(() => {
    const nowPresent = isGenerating();
    if (nowPresent) {
      hasActivelyGenerated = true;
    }
    if (stopBtnPresent && !nowPresent && hasActivelyGenerated) {
      console.log('[Auto-Listen] Stop-button disappeared — scheduling listen check.');
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(maybeAutoListen, POST_STOP_DELAY_MS);
    }
    stopBtnPresent = nowPresent;
  }, 300);

  console.log('[Auto-Listen] Stop-button sentinel started.');
}

// ─── BOOT ─────────────────────────────────────────────────────────────────────

(async function init() {
  console.log('[Auto-Listen] v1.2.0 initializing on', location.href);
  await loadSettings();
  tagExistingBlocks();
  startObserver();
  startStopButtonSentinel();
})();

