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
 *     for DEBOUNCE_MS milliseconds we attempt to trigger. Least reliable but
 *     acts as a safety net.
 *
 * ── SELECTOR UPDATE GUIDE ──────────────────────────────────────────────────
 * If auto-listen stops working after a Gemini UI update, open DevTools on
 * gemini.google.com and update the constants below. Look for:
 *   - LISTEN_BUTTON_SELECTORS    → aria-label of the TTS button.
 *   - MORE_BUTTON_SELECTORS      → aria-label of the three-dot / kebab menu.
 *   - LISTEN_MENU_ITEM_SELECTORS → aria-label / text of "Listen" inside menu.
 *   - STOP_BUTTON_SELECTORS      → aria-label of the "Stop generating" button.
 *   - RESPONSE_BLOCK_SELECTORS   → Tag/selector for one AI response turn.
 *
 * ── BUG FIXES (v1.1.0) ─────────────────────────────────────────────────────
 *   Fix 1: RESPONSE_BLOCK_SELECTORS kept as an array (was wrongly .join'd),
 *           so queryAllAny() can try each selector individually.
 *   Fix 2: After finding <model-response>, walk UP to the "turn container"
 *           ancestor that holds both the response text AND its action buttons
 *           (buttons are siblings of <model-response>, not children of it).
 *   Fix 3: URL-change observer re-tags existing blocks on SPA navigation,
 *           preventing old responses from replaying after conversation switch.
 *   Fix 4: Menu item search is scoped to the open [role="menu"] element.
 *   Fix 5: Menu dismissal uses document.body.click() instead of dispatching
 *           Escape on `document`, which Angular may not pick up correctly.
 *
 * All console output is prefixed with "[Auto-Listen]" for easy filtering.
 *
 * @version 1.1.0
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
  '[role="menuitem"][aria-label="Listen to response"]',
  '[role="menuitem"][aria-label="Listen"]',
  '[role="menuitem"][aria-label="Read aloud"]',
  // Text-content fallback is handled separately in findMenuItemByText().
];

/** The button present *only while* Gemini is streaming a response. */
const STOP_BUTTON_SELECTORS = [
  'button[aria-label="Stop generating"]',
  'button[aria-label="Cancel"]',
  'button[aria-label="Stop"]',
];

/**
 * FIX 1: Keep as an ARRAY — do NOT .join() these into a single string.
 *
 * Previously: `RESPONSE_BLOCK_SELECTOR = [...].join(', ')` (one string)
 * Problem:    queryAllAny([RESPONSE_BLOCK_SELECTOR]) wrapped it in a 1-element
 *             array. querySelectorAll ran the entire comma-joined string as one
 *             CSS selector — if ANY sub-selector were invalid the whole call
 *             threw and the catch-and-skip fallback logic was never reached.
 * Fix:        Store as an array. queryAllAny() will try each selector
 *             independently, catching and skipping any invalid ones.
 */
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
// Gemini uses Shadow DOM (Web Components) extensively. Standard querySelector
// cannot pierce shadow boundaries, so we recursively walk all open shadow roots.

/**
 * Recursively query for the FIRST element matching `selector` by traversing
 * open shadow roots. Returns null if nothing matches.
 * @param {string} selector
 * @param {Element|Document|ShadowRoot} root
 * @returns {Element|null}
 */
function deepQuerySelector(selector, root = document) {
  try {
    const el = root.querySelector(selector);
    if (el) return el;
  } catch (_) { /* malformed selector */ }

  // Recurse into all open shadow roots found under `root`.
  const hosts = root.querySelectorAll('*');
  for (const host of hosts) {
    if (host.shadowRoot) {
      const found = deepQuerySelector(selector, host.shadowRoot);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Recursively query for ALL elements matching `selector` by traversing
 * open shadow roots.
 * @param {string} selector
 * @param {Element|Document|ShadowRoot} root
 * @returns {Element[]}
 */
function deepQuerySelectorAll(selector, root = document) {
  let results = [];
  try {
    results = Array.from(root.querySelectorAll(selector));
  } catch (_) { /* malformed selector */ }

  const hosts = root.querySelectorAll('*');
  for (const host of hosts) {
    if (host.shadowRoot) {
      results = results.concat(deepQuerySelectorAll(selector, host.shadowRoot));
    }
  }
  return results;
}

// ─── SELECTOR UTILITIES ──────────────────────────────────────────────────────

/**
 * Returns the first match for any selector in the array, trying each
 * individually so one malformed selector cannot abort the rest.
 * Now uses deepQuerySelector to pierce Shadow DOM boundaries.
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
 * Returns all matches for the first selector in the array that yields results,
 * trying each individually. Now uses deepQuerySelectorAll to pierce Shadow DOM.
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
  // FIX 1: pass the array directly — not a pre-joined string.
  const all = queryAllAny(RESPONSE_BLOCK_SELECTORS);
  return all.length > 0 ? all[all.length - 1] : null;
}

/**
 * FIX 2: Walk UP from the response block to find the ancestor "turn container"
 * that holds BOTH the response text and its sibling action buttons.
 *
 * Previously: buttons were searched INSIDE <model-response>, but they are
 * rendered as siblings in a parent container — querySelector inside the block
 * always returned null, so both Strategy 1 and Strategy 2 silently failed.
 *
 * We walk up until we find an ancestor that contains at least one of the
 * known action buttons, or until MAX_ANCESTOR_WALK steps are exhausted.
 *
 * @param {Element} responseBlock  The <model-response> element.
 * @returns {Element}  The turn container (or the responseBlock itself as a
 *                     last resort so callers never receive null).
 */
function getTurnContainer(responseBlock) {
  let node = responseBlock;

  for (let i = 0; i < MAX_ANCESTOR_WALK; i++) {
    if (!node.parentElement) break;
    node = node.parentElement;

    const hasListenBtn = queryAny(LISTEN_BUTTON_SELECTORS, node) !== null;
    const hasMoreBtn   = queryAny(MORE_BUTTON_SELECTORS, node) !== null;

    if (hasListenBtn || hasMoreBtn) {
      console.log(`[Auto-Listen] Turn container found after walking ${i + 1} level(s) up.`);
      return node;
    }
  }

  // Could not find a container with action buttons. Log a warning and return
  // the highest ancestor we reached so callers can log a useful failure.
  console.warn(
    '[Auto-Listen] Could not find turn container with action buttons within',
    MAX_ANCESTOR_WALK,
    'ancestor levels. Gemini DOM may have changed.'
  );
  return node;
}

/**
 * Collect text from an element including open Shadow DOM. Host innerText does
 * not include shadow-tree text, which is where Gemini renders the model reply.
 * @param {Node} node
 * @returns {string}
 */
function collectDeepText(node) {
  if (!node) return '';
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';

  let parts = '';
  if (node.nodeType === Node.ELEMENT_NODE && node.shadowRoot) {
    parts += collectDeepText(node.shadowRoot);
  }
  const children = node.childNodes || [];
  for (const child of children) {
    parts += ' ' + collectDeepText(child);
  }
  return parts;
}

/**
 * Counts words in a response block's visible text, including open Shadow DOM.
 * @param {Element} block  A <model-response> or equivalent.
 * @returns {number}
 */
function countWords(block) {
  const deepText = collectDeepText(block).trim();
  if (!deepText) return 0;
  return deepText.split(/\s+/).filter(Boolean).length;
}

/**
 * FIX 4 + Shadow DOM: Search for a "Listen" menu item scoped to the open
 * [role="menu"] element. Uses deep queries to pierce Shadow DOM.
 *
 * Falls back to a text-content scan within the menu if ARIA selectors miss.
 *
 * @returns {Element|null}
 */
function findListenMenuItem() {
  // Prefer the specific open menu if one is present (may be in Shadow DOM).
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
 * @param {Element} turnContainer  The ancestor element wrapping text + buttons.
 * @returns {boolean}
 */
function tryDirectListenButton(turnContainer) {
  const btn = queryAny(LISTEN_BUTTON_SELECTORS, turnContainer);
  if (!btn) return false;

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
  const moreBtn = queryAny(MORE_BUTTON_SELECTORS, turnContainer);
  if (!moreBtn) {
    console.log('[Auto-Listen] No "More" menu button found on turn container.');
    return false;
  }

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
    // FIX 4: findListenMenuItem() is now scoped to [role="menu"].
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
    // FIX 5: Dismiss the menu by clicking document.body, not dispatching
    // Escape on `document`. Angular listens on body/overlay, not document.
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
    // FIX 5: body click is more reliable than Escape on `document`.
    document.body.click();
  }
  return true;
}

/**
 * Core handler: tries to trigger Listen on the newest response block.
 *
 * Guard conditions (any one aborts the attempt):
 *  - Extension disabled in settings.
 *  - Still generating (stop-button visible).
 *  - Already processing (concurrent-run guard).
 *  - No response block found in DOM.
 *  - Block already processed (data-auto-listened attribute).
 *  - Response text shorter than minWords threshold.
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
    return;
  }

  isProcessing = true;
  console.log(`[Auto-Listen] Attempting auto-listen (~${wordCount} words).`);

  try {
    // FIX 2: walk up to the turn container that holds the action buttons.
    const turnContainer = getTurnContainer(responseBlock);

    // Strategy 1: click a directly visible Listen button.
    if (tryDirectListenButton(turnContainer)) {
      responseBlock.dataset.autoListened = 'true';
      return;
    }

    // Strategy 2: open the More menu and click Listen inside it.
    const success = await tryMenuListenItem(turnContainer);
    if (success) {
      responseBlock.dataset.autoListened = 'true';
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
 * Mark all currently visible response blocks as already-processed so we don't
 * auto-play them (they existed before this session or navigation event).
 *
 * FIX 3: This is now also called on SPA navigation (see watchForNavigation)
 * so that responses already on screen when the user switches conversations
 * are tagged before maybeAutoListen() can process them.
 */
function tagExistingBlocks() {
  // FIX 1: pass the array directly to queryAllAny.
  const existingBlocks = queryAllAny(RESPONSE_BLOCK_SELECTORS);
  existingBlocks.forEach(block => {
    block.dataset.autoListened = 'true';
  });
  console.log(`[Auto-Listen] Tagged ${existingBlocks.length} existing response block(s).`);
}

// ─── SPA NAVIGATION WATCHER ───────────────────────────────────────────────────

/**
 * FIX 3: Gemini is a SPA that uses history.pushState for navigation.
 * When the user switches conversations, the DOM is rebuilt and all
 * data-auto-listened markers vanish. Without re-tagging, maybeAutoListen()
 * would treat old responses in the new conversation as fresh ones and
 * auto-play them.
 *
 * We piggyback on the main MutationObserver: any DOM mutation that also
 * changes location.href is treated as a navigation event. A 500 ms debounce
 * gives the SPA time to fully render the new conversation before we tag.
 */
let navDebounceTimer = null;

function watchForNavigation() {
  // We detect URL changes inside the MutationObserver callback (in
  // startObserver) rather than patching history.pushState, because the
  // MutationObserver is already running and patches are fragile.
  // The check is cheap (string comparison) and runs on every mutation.
}

// ─── MUTATION OBSERVER ───────────────────────────────────────────────────────

function startObserver() {
  if (mainObserver) mainObserver.disconnect();

  mainObserver = new MutationObserver(() => {
    // FIX 3: detect SPA navigation on every mutation callback.
    if (location.href !== lastHref) {
      lastHref = location.href;
      console.log('[Auto-Listen] SPA navigation detected — retagging existing blocks.');
      // Debounce to let the new conversation DOM fully render first.
      clearTimeout(navDebounceTimer);
      navDebounceTimer = setTimeout(tagExistingBlocks, 800);
    }

    // Standard debounced check for generation completion.
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(maybeAutoListen, DEBOUNCE_MS);
  });

  mainObserver.observe(document.body, {
    childList: true,
    subtree: true,
    // characterData intentionally omitted — we don't want to fire on keystrokes.
  });

  console.log('[Auto-Listen] MutationObserver started.');
}

// ─── STOP-BUTTON SENTINEL ─────────────────────────────────────────────────────

/**
 * Poll for the stop-button → gone transition. Fires faster than the debounce
 * (POST_STOP_DELAY_MS vs DEBOUNCE_MS) for a snappier response.
 */
function startStopButtonSentinel() {
  if (stopSentinelHandle) clearInterval(stopSentinelHandle);

  stopSentinelHandle = setInterval(() => {
    const nowPresent = isGenerating();
    if (stopBtnPresent && !nowPresent) {
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
  tagExistingBlocks();   // FIX 3: tag pre-existing blocks before observing.
  startObserver();
  startStopButtonSentinel();
})();
