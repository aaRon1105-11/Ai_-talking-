# Gemini Auto-Listen — Chrome Extension · v1.1.0

Automatically triggers the built-in **Listen** (text-to-speech) feature on [gemini.google.com](https://gemini.google.com) when a new response finishes generating, mimicking the auto-play behaviour on mobile.

---

## Features

| Feature | Detail |
|---|---|
| Auto-play | Clicks "Listen" on each new response automatically |
| Short-response skip | Configurable minimum word count (default: 5) |
| Enable/Disable toggle | Instantly toggles behaviour via popup, no reload needed |
| Idempotency | Each response is only auto-played once per session |
| Multiple fallback strategies | Works even if Gemini rearranges its action bar (see below) |

---

## Installation (Load Unpacked)

> **Requires Chrome 88 or later.** The extension uses Manifest V3.

1. **Download** or clone this repository so you have the `gemini-auto-listen/` folder locally.

2. Open Chrome and navigate to:
   ```
   chrome://extensions/
   ```

3. Enable **Developer mode** via the toggle in the top-right corner.

4. Click **Load unpacked** (top-left).

5. Select the `gemini-auto-listen/` folder.

6. The extension icon will appear in your toolbar. Click it to configure settings.

7. Navigate to [gemini.google.com](https://gemini.google.com) and send a prompt — audio should start automatically when the response finishes.

> **Tip:** After loading, open DevTools on gemini.google.com (`F12`) and filter the Console by `[Auto-Listen]` to see exactly what the extension is doing on each response.

---

## Files

```
gemini-auto-listen/
├── manifest.json   — Extension config (Manifest V3, minimal permissions)
├── content.js      — Core detection & auto-click logic (runs on gemini.google.com)
├── popup.html      — Settings popup structure
├── popup.css       — Popup styles
├── popup.js        — Popup logic (reads/writes chrome.storage.local)
└── README.md       — This file
```

---

## How Detection Works

Gemini's DOM uses obfuscated class names that change frequently. The extension relies on **ARIA attributes** and **stable DOM roles**, which are much more durable. Three strategies run in cascade:

### Strategy 1 (Primary) — Stop-Button Sentinel + Direct Listen Button
A background interval polls every 300 ms for the `[aria-label="Stop generating"]` button. The moment it disappears (generation is complete), the extension waits a short settling delay and then queries for a `button[aria-label="Listen to response"]` (or similar) directly in the latest response's action bar and clicks it.

### Strategy 2 (Fallback) — Listen Inside "More Options" Menu
If the Listen button is hidden behind a three-dot / kebab menu, the extension:
1. Finds `button[aria-label="More options"]` (or similar) on the latest response block.
2. Clicks it to open the menu.
3. Scans for `[role="menuitem"]` elements whose aria-label or text contains "listen" or "read aloud" — with up to 5 retries spaced 200 ms apart.
4. Clicks the item. If anything goes wrong, it calls `document.body.click()` to close the menu without side effects.

### Strategy 3 (Implicit Debounce)
The `MutationObserver` that watches for new children in `document.body` also debounces at 600 ms. If the stop-button sentinel misses a transition (rare), the observer will still eventually fire `maybeAutoListen()`.

---

## Updating Selectors After a Gemini UI Change

Google occasionally updates Gemini's UI. If auto-listen stops working:

1. Open [gemini.google.com](https://gemini.google.com) in Chrome.
2. Send a prompt. When the response finishes, open **DevTools → Elements**.
3. Hover over or inspect the **Listen**, **More options**, and **Stop generating** buttons.
4. Look for a stable `aria-label` or `role` attribute on each.
5. Open [`content.js`](content.js) and update the relevant constant at the top of the file:

| Constant | What it targets |
|---|---|
| `LISTEN_BUTTON_SELECTORS` | The TTS button visible directly in the action bar |
| `MORE_BUTTON_SELECTORS` | The three-dot/kebab "More" button |
| `LISTEN_MENU_ITEM_SELECTORS` | The "Listen" option inside the More menu |
| `STOP_BUTTON_SELECTORS` | The button shown while streaming is in progress |
| `RESPONSE_BLOCK_SELECTORS` | The wrapper element for each AI turn. **Must stay an array** — never `.join()` it. |

**Add new selectors to the START of each array** — old selectors remain as fallbacks.

6. If the Listen/More buttons are not found, also check how many DOM levels separate `<model-response>` from its action bar. Increase `MAX_ANCESTOR_WALK` in `content.js` if needed (currently `8`).

7. Go to `chrome://extensions/` and click the **↺ Reload** icon on the extension card.

> **Debug tip:** Open DevTools console on gemini.google.com, filter by `[Auto-Listen]`, and watch the log output to see exactly which strategy fired (or failed).

---

## Permissions

| Permission | Why it's needed |
|---|---|
| `storage` | Persists your on/off toggle and minimum-word-count setting across browser sessions |
| `host_permissions: gemini.google.com` | Allows the content script to read and interact with the Gemini page DOM |

No other permissions are requested. The extension does not send any data anywhere.

---

## Known Limitations

- **Gemini UI changes**: Selector drift is inevitable. See the update guide above.
- **Multiple windows**: Detection is per-tab; opening Gemini in multiple tabs works independently.
- **Very long responses**: The word-count threshold applies to the *entire* response block's `innerText`, which includes any code blocks or tables.

---

## Changelog

### v1.1.0
- **Fix 1**: `RESPONSE_BLOCK_SELECTORS` kept as an array (was wrongly `.join`'d into a single string), restoring the per-selector fallback loop in `queryAllAny()`.
- **Fix 2**: After locating `<model-response>`, walk UP the DOM to the ancestor turn container that holds both response text and its sibling action buttons. Previously, buttons were queried *inside* `<model-response>` where they don't live, so Strategy 1 and 2 silently failed every time.
- **Fix 3**: A URL-change check inside the MutationObserver callback re-tags existing blocks on SPA navigation (conversation switch), preventing old responses from auto-playing in newly loaded chats.
- **Fix 4**: Menu item search is now scoped to the open `[role="menu"]` element rather than the full document.
- **Fix 5**: Menu dismissal now uses `document.body.click()` — more reliable than dispatching `Escape` on `document` for Angular's overlay listeners.

### v1.0.0
- Initial release.

---

## License

MIT — use and modify freely.
