// ==UserScript==
// @name         WallFetch
// @namespace    https://github.com/itachi-re/wallfetch
// @version      1.0.0
// @description  Download original-resolution wallpapers from Wallhaven with metadata, persistent settings, download queue, and advanced customization.
// @author       itachi-re
// @license      MIT

// @homepageURL  https://github.com/itachi-re/wallfetch
// @supportURL   https://github.com/itachi-re/wallfetch/issues
// @downloadURL  https://github.com/itachi-re/wallfetch/raw/main/dist/WallFetch.user.js
// @updateURL    https://github.com/itachi-re/wallfetch/raw/main/dist/WallFetch.user.js

// @match        https://wallhaven.cc/*
// @match        https://*.wallhaven.cc/*

// @icon         https://wallhaven.cc/favicon.ico

// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @grant        GM_getValue
// @grant        GM_setValue

// @connect      wallhaven.cc
// @connect      w.wallhaven.cc

// @run-at       document-idle
// @noframes
// ==/UserScript==
/*
 * MIT License
 *
 * Copyright (c) 2026 itachi-re
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

(() => {
  'use strict';

  /* ==========================================================================
   * CONFIG
   * Central place for all user-tunable behaviour. Nothing else in the script
   * should contain magic numbers/strings that belong here.
   * ======================================================================== */
  const CONFIG = Object.freeze({
    // --- Download behaviour -------------------------------------------------
    saveAs: false, // true = browser "Save As" dialog, false = silent save to default downloads folder
    removeWallhavenPrefix: true, // strip the "wallhaven-" prefix from the original filename
    filenameTemplate: '{id}', // supported tokens: {id} {resolution} {category} {ext} {size}
    sanitizeFilenames: true, // strip characters that are invalid on common filesystems
    preventDuplicates: true, // warn (and require confirmation) before re-downloading the same wall this session

    // --- UI / UX -------------------------------------------------------------
    darkTheme: true, // match Wallhaven's dark UI palette
    showNotifications: true, // in-page toast notifications
    showProgress: true, // show a progress ring/bar while downloading
    toastDurationMs: 4200,
    enableContextMenu: true, // custom right-click menu on the wallpaper image
    enableFloatingFallback: true, // if the native action bar can't be located, show a floating button instead

    // --- Keyboard shortcuts ---------------------------------------------------
    keyboardShortcuts: true,
    shortcuts: {
      download: { key: 'd', ctrl: false, shift: false, alt: false }, // D
      downloadNoDialog: { key: 'd', ctrl: true, shift: false, alt: false }, // Ctrl+D
      copyUrl: { key: 'd', ctrl: false, shift: true, alt: false }, // Shift+D
      copyFilename: { key: 'd', ctrl: false, shift: false, alt: true }, // Alt+D
    },

    // --- Reliability ---------------------------------------------------------
    retryCount: 3,
    retryDelay: 1000, // ms, multiplied by attempt number (linear backoff)
    elementWaitTimeout: 8000, // ms to wait for DOM targets before falling back
    domObserverDebounce: 250, // ms

    // --- Debugging -------------------------------------------------------------
    debug: false,
  });

  const LOG_PREFIX = '[Wallhaven Original Downloader]';

  /**
   * Minimal internal logger so debug output can be toggled from one place.
   */
  const Logger = {
    debug(...args) {
      if (CONFIG.debug) console.debug(LOG_PREFIX, ...args);
    },
    info(...args) {
      console.info(LOG_PREFIX, ...args);
    },
    warn(...args) {
      console.warn(LOG_PREFIX, ...args);
    },
    error(...args) {
      console.error(LOG_PREFIX, ...args);
    },
  };

  /* ==========================================================================
   * UTILITIES
   * Small, pure, dependency-free helpers reused across modules.
   * ======================================================================== */
  const Utils = {
    /**
     * Wait for an element matching `selector` to exist under `root`.
     * Resolves with the element, or `null` if the timeout elapses.
     * Uses a single MutationObserver (no polling) and always disconnects.
     *
     * @param {string} selector
     * @param {{ root?: ParentNode, timeout?: number }} [options]
     * @returns {Promise<Element|null>}
     */
    waitForElement(selector, options = {}) {
      const root = options.root ?? document;
      const timeout = options.timeout ?? CONFIG.elementWaitTimeout;

      const existing = root.querySelector(selector);
      if (existing) return Promise.resolve(existing);

      return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          observer.disconnect();
          clearTimeout(timer);
          resolve(value);
        };

        const observer = new MutationObserver(() => {
          const found = root.querySelector(selector);
          if (found) finish(found);
        });

        observer.observe(root === document ? document.documentElement : root, {
          childList: true,
          subtree: true,
        });

        const timer = setTimeout(() => finish(null), timeout);
      });
    },

    /**
     * Debounce a function so it only runs `wait` ms after the last call.
     * @param {Function} fn
     * @param {number} wait
     */
    debounce(fn, wait) {
      let handle = null;
      return (...args) => {
        clearTimeout(handle);
        handle = setTimeout(() => fn(...args), wait);
      };
    },

    /**
     * Sleep helper for retry back-off.
     * @param {number} ms
     */
    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },

    /**
     * Find a sidebar "stat" value (e.g. Resolution, Size) by its label text.
     * Wallhaven renders stats as label/value pairs (dt/dd, or similarly
     * structured elements). We search generically by visible label text
     * instead of relying on specific class names, so the script keeps working
     * even if Wallhaven changes its markup/classes.
     *
     * @param {string} label - e.g. "Resolution" or "Size"
     * @returns {string|null}
     */
    findStatByLabel(label) {
      const needle = label.trim().toLowerCase();
      const candidateLabels = document.querySelectorAll(
        'dt, dl > *:nth-child(odd), .stat-label, [class*="label"]'
      );

      for (const el of candidateLabels) {
        const text = (el.textContent || '').trim().toLowerCase();
        if (text !== needle) continue;

        // Prefer an explicit <dd>, otherwise the next element sibling.
        let value = el.nextElementSibling;
        if (value && value.textContent) {
          return value.textContent.trim();
        }
      }
      return null;
    },

    /**
     * Best-effort detection of the wallpaper's category (general/anime/people).
     * Wallhaven highlights the active category icon in the sidebar; since the
     * exact class names are not guaranteed stable, several heuristics are
     * tried and the function degrades gracefully to `null`.
     * @returns {string|null}
     */
    detectCategory() {
      const activeSelectors = [
        '.category-icons .active',
        '.categories .active',
        '[data-category].active',
        '.showcase-stats .active',
      ];

      for (const selector of activeSelectors) {
        const el = document.querySelector(selector);
        if (el) {
          const text = (el.textContent || el.getAttribute('title') || el.getAttribute('aria-label') || '')
            .trim()
            .toLowerCase();
          if (text) return text.replace(/\s+/g, '-');
        }
      }

      // Fall back to scanning known category keywords in tag links.
      const tagLinks = document.querySelectorAll('#tags a, .tag-list a, a.tag');
      for (const link of tagLinks) {
        const href = link.getAttribute('href') || '';
        const match = href.match(/[?&]categories=([^&]+)/i);
        if (match) return match[1];
      }

      return null;
    },

    /**
     * Extract the wallpaper ID from a Wallhaven URL, filename, or the
     * current page location. Handles both "/w/9mx8kd" style page URLs and
     * "wallhaven-9mx8kd.png" style CDN filenames.
     * @param {string} input
     * @returns {string|null}
     */
    extractId(input) {
      if (!input) return null;
      const fileMatch = input.match(/wallhaven-([a-z0-9]+)\.(jpg|jpeg|png|webp)(?:\?.*)?$/i);
      if (fileMatch) return fileMatch[1];

      const pathMatch = input.match(/\/w\/([a-z0-9]+)/i);
      if (pathMatch) return pathMatch[1];

      return null;
    },

    /**
     * Extract the file extension (without the dot) from a URL, normalized
     * to lowercase. Supports jpg/jpeg/png/webp.
     * @param {string} url
     * @returns {string|null}
     */
    extractExtension(url) {
      const match = url.match(/\.(jpg|jpeg|png|webp)(?:\?.*)?$/i);
      return match ? match[1].toLowerCase() : null;
    },

    /**
     * Normalize a resolution string like "1920 x 1080" into "1920x1080".
     * @param {string|null} resolution
     * @returns {string}
     */
    normalizeResolution(resolution) {
      if (!resolution) return 'unknown';
      return resolution.replace(/\s*x\s*/i, 'x').trim();
    },

    /**
     * Remove characters that are illegal (or awkward) in filenames on
     * Windows/macOS/Linux, and collapse whitespace.
     * @param {string} name
     * @returns {string}
     */
    sanitizeFilename(name) {
      if (!CONFIG.sanitizeFilenames) return name;
      return name
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
        .replace(/\s+/g, '_')
        .replace(/_{2,}/g, '_')
        .trim();
    },

    /**
     * Render a filename from CONFIG.filenameTemplate, substituting tokens.
     * @param {{id:string, resolution:string, category:string, ext:string, size:string}} data
     * @returns {string}
     */
    renderFilename(data) {
      const tokens = {
        '{id}': data.id ?? 'unknown',
        '{resolution}': Utils.normalizeResolution(data.resolution),
        '{category}': data.category ?? 'wallpaper',
        '{ext}': data.ext ?? 'jpg',
        '{size}': data.size ?? 'unknown',
      };

      let base = CONFIG.filenameTemplate.replace(
        /\{id\}|\{resolution\}|\{category\}|\{ext\}|\{size\}/g,
        (match) => tokens[match] ?? match
      );

      if (CONFIG.removeWallhavenPrefix) {
        base = base.replace(/^wallhaven-/i, '');
      }

      const filename = `${base}.${data.ext ?? 'jpg'}`;
      return Utils.sanitizeFilename(filename);
    },

    /**
     * Copy text to the clipboard, preferring GM_setClipboard (works without
     * document focus / in more contexts) and falling back to the async
     * Clipboard API.
     * @param {string} text
     * @returns {Promise<boolean>}
     */
    async copyToClipboard(text) {
      try {
        if (typeof GM_setClipboard === 'function') {
          GM_setClipboard(text, 'text');
          return true;
        }
      } catch (err) {
        Logger.warn('GM_setClipboard failed, falling back to Clipboard API', err);
      }

      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (err) {
        Logger.error('Clipboard copy failed', err);
        return false;
      }
    },
  };

  /* ==========================================================================
   * WALLPAPER DATA
   * Resolves everything we know about the wallpaper currently on screen.
   * ======================================================================== */
  const WallpaperData = {
    /** @type {HTMLImageElement|null} */
    _imageEl: null,

    /**
     * Locate the full-resolution <img> element for the current page.
     * Wallhaven serves the ORIGINAL image directly as the src of the main
     * showcase image (the CDN "full" path) - there is no separate preview
     * swapped in for the detail page, so no extra network round-trip is
     * required to reach the original file.
     * @returns {Promise<HTMLImageElement|null>}
     */
    async findImageElement() {
      if (this._imageEl && document.contains(this._imageEl)) {
        return this._imageEl;
      }

      const selectors = [
        '#wallpaper',
        'img#wallpaper',
        'figure#showcase img',
        'main img[src*="w.wallhaven.cc/full/"]',
        'img[src*="w.wallhaven.cc/full/"]',
      ];

      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el && el.tagName === 'IMG' && /w\.wallhaven\.cc\/full\//i.test(el.src)) {
          this._imageEl = el;
          return el;
        }
      }

      // Element may not have rendered yet (lazy load / slow network).
      const found = await Utils.waitForElement(selectors.join(', '), {
        timeout: CONFIG.elementWaitTimeout,
      });
      if (found && found.tagName === 'IMG') {
        this._imageEl = found;
        return found;
      }
      return null;
    },

    /**
     * Gather all metadata needed to build a filename and perform a download.
     * Returns `null` if no original image could be located on this page.
     * @returns {Promise<null | {id:string, url:string, ext:string, resolution:string, category:string, size:string}>}
     */
    async resolve() {
      const img = await this.findImageElement();
      if (!img || !img.src) {
        Logger.warn('Could not locate the original wallpaper image on this page.');
        return null;
      }

      const url = img.src;
      const id = Utils.extractId(url) || Utils.extractId(location.href);
      const ext = Utils.extractExtension(url) || 'jpg';

      if (!id) {
        Logger.warn('Could not determine wallpaper ID.');
        return null;
      }

      const resolution = Utils.findStatByLabel('Resolution') || `${img.naturalWidth || 0}x${img.naturalHeight || 0}`;
      const size = Utils.findStatByLabel('Size') || 'unknown';
      const category = Utils.detectCategory() || 'wallpaper';

      return { id, url, ext, resolution, category, size };
    },

    /** Clear cached references, e.g. after SPA-style navigation. */
    reset() {
      this._imageEl = null;
    },
  };

  /* ==========================================================================
   * NOTIFICATIONS
   * Lightweight in-page toast system matching Wallhaven's dark theme.
   * ======================================================================== */
  const Notifications = {
    _container: null,

    _ensureContainer() {
      if (this._container && document.body.contains(this._container)) {
        return this._container;
      }
      const container = document.createElement('div');
      container.id = 'wod-toast-container';
      container.setAttribute('role', 'status');
      container.setAttribute('aria-live', 'polite');
      document.body.appendChild(container);
      this._container = container;
      return container;
    },

    /**
     * @param {string} message
     * @param {'info'|'success'|'error'|'warning'} type
     * @param {{ actionLabel?: string, onAction?: Function, duration?: number }} [options]
     */
    show(message, type = 'info', options = {}) {
      if (!CONFIG.showNotifications) return;

      const container = this._ensureContainer();
      const toast = document.createElement('div');
      toast.className = `wod-toast wod-toast--${type}`;

      const icon = document.createElement('span');
      icon.className = 'wod-toast__icon';
      icon.innerHTML = Icons[type] ?? Icons.info;

      const text = document.createElement('span');
      text.className = 'wod-toast__text';
      text.textContent = message;

      toast.append(icon, text);

      if (options.actionLabel && typeof options.onAction === 'function') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wod-toast__action';
        btn.textContent = options.actionLabel;
        btn.addEventListener('click', () => {
          options.onAction();
          dismiss();
        });
        toast.appendChild(btn);
      }

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'wod-toast__close';
      closeBtn.setAttribute('aria-label', 'Dismiss');
      closeBtn.textContent = '\u00d7';
      closeBtn.addEventListener('click', () => dismiss());
      toast.appendChild(closeBtn);

      container.appendChild(toast);
      requestAnimationFrame(() => toast.classList.add('wod-toast--visible'));

      let dismissed = false;
      const dismiss = () => {
        if (dismissed) return;
        dismissed = true;
        toast.classList.remove('wod-toast--visible');
        toast.classList.add('wod-toast--leaving');
        toast.addEventListener('transitionend', () => toast.remove(), { once: true });
      };

      const duration = options.duration ?? CONFIG.toastDurationMs;
      if (duration > 0) setTimeout(dismiss, duration);

      return { dismiss };
    },

    success(message, options) {
      return this.show(message, 'success', options);
    },
    error(message, options) {
      return this.show(message, 'error', options);
    },
    info(message, options) {
      return this.show(message, 'info', options);
    },
    warning(message, options) {
      return this.show(message, 'warning', options);
    },
  };

  /* ==========================================================================
   * ICONS (inline SVG, no external assets)
   * ======================================================================== */
  const Icons = {
    download:
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/>' +
      '<path d="M5 21h14"/></svg>',
    success:
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    error:
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5"/>' +
      '<path d="M12 16h.01"/></svg>',
    warning:
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4"/>' +
      '<path d="M12 17h.01"/></svg>',
    info:
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01"/>' +
      '<path d="M11 12h1v5h1"/></svg>',
    spinner:
      '<svg class="wod-spin" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"/></svg>',
  };

  /* ==========================================================================
   * STYLES
   * Injected once. Uses CSS variables so it can be re-themed easily and
   * matches Wallhaven's existing dark palette (#2E2E33 panels / #0088cc
   * accent-ish tones adapted to a neutral accent to stay visually native).
   * ======================================================================== */
  function injectStyles() {
    const css = `
      :root {
        --wod-bg: #24242a;
        --wod-bg-hover: #2f2f37;
        --wod-border: #3a3a42;
        --wod-text: #e3e3e6;
        --wod-muted: #9a9aa2;
        --wod-accent: #4fc3f7;
        --wod-success: #4caf82;
        --wod-error: #e0555f;
        --wod-warning: #e0a24f;
        --wod-radius: 6px;
      }

      .wod-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        height: 32px;
        min-width: 32px;
        padding: 0 10px;
        background: var(--wod-bg);
        color: var(--wod-text);
        border: 1px solid var(--wod-border);
        border-radius: var(--wod-radius);
        cursor: pointer;
        font-size: 12px;
        line-height: 1;
        transition: background-color 0.15s ease, transform 0.1s ease, box-shadow 0.15s ease;
        position: relative;
        user-select: none;
      }
      .wod-btn:hover:not(.wod-btn--disabled) {
        background: var(--wod-bg-hover);
        box-shadow: 0 0 0 1px var(--wod-accent) inset;
      }
      .wod-btn:active:not(.wod-btn--disabled) {
        transform: scale(0.96);
      }
      .wod-btn--disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .wod-btn--success {
        border-color: var(--wod-success);
        color: var(--wod-success);
      }
      .wod-btn--error {
        border-color: var(--wod-error);
        color: var(--wod-error);
      }
      .wod-btn__icon {
        display: inline-flex;
        line-height: 0;
      }

      .wod-spin {
        animation: wod-spin-rotate 0.8s linear infinite;
      }
      @keyframes wod-spin-rotate {
        to { transform: rotate(360deg); }
      }

      .wod-btn--success .wod-btn__icon {
        animation: wod-pop 0.35s ease;
      }
      .wod-btn--error .wod-btn__icon {
        animation: wod-shake 0.4s ease;
      }
      @keyframes wod-pop {
        0% { transform: scale(0.5); opacity: 0; }
        60% { transform: scale(1.15); opacity: 1; }
        100% { transform: scale(1); }
      }
      @keyframes wod-shake {
        0%, 100% { transform: translateX(0); }
        25% { transform: translateX(-3px); }
        75% { transform: translateX(3px); }
      }

      .wod-floating {
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: 9999;
        height: 44px;
        min-width: 44px;
        border-radius: 999px;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
      }

      #wod-toast-container {
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 10000;
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-width: 340px;
      }

      .wod-toast {
        display: flex;
        align-items: center;
        gap: 8px;
        background: var(--wod-bg);
        color: var(--wod-text);
        border: 1px solid var(--wod-border);
        border-radius: var(--wod-radius);
        padding: 10px 12px;
        font-size: 13px;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
        opacity: 0;
        transform: translateX(16px);
        transition: opacity 0.2s ease, transform 0.2s ease;
      }
      .wod-toast--visible {
        opacity: 1;
        transform: translateX(0);
      }
      .wod-toast--leaving {
        opacity: 0;
        transform: translateX(16px);
      }
      .wod-toast--success { border-color: var(--wod-success); color: var(--wod-success); }
      .wod-toast--error { border-color: var(--wod-error); color: var(--wod-error); }
      .wod-toast--warning { border-color: var(--wod-warning); color: var(--wod-warning); }
      .wod-toast--info { border-color: var(--wod-accent); color: var(--wod-text); }

      .wod-toast__icon { flex: 0 0 auto; display: inline-flex; }
      .wod-toast__text { flex: 1 1 auto; }
      .wod-toast__action, .wod-toast__close {
        background: transparent;
        border: none;
        color: inherit;
        cursor: pointer;
        font-size: 12px;
        padding: 2px 4px;
      }
      .wod-toast__action {
        text-decoration: underline;
        white-space: nowrap;
      }
      .wod-toast__close {
        font-size: 15px;
        opacity: 0.7;
      }
      .wod-toast__close:hover { opacity: 1; }

      .wod-context-menu {
        position: fixed;
        z-index: 10001;
        min-width: 190px;
        background: var(--wod-bg);
        border: 1px solid var(--wod-border);
        border-radius: var(--wod-radius);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
        padding: 4px;
        font-size: 13px;
        color: var(--wod-text);
      }
      .wod-context-menu__item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 10px;
        border-radius: 4px;
        cursor: pointer;
        white-space: nowrap;
      }
      .wod-context-menu__item:hover {
        background: var(--wod-bg-hover);
        color: var(--wod-accent);
      }
    `;

    if (typeof GM_addStyle === 'function') {
      GM_addStyle(css);
    } else {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);
    }
  }

  /* ==========================================================================
   * DOWNLOADER
   * Wraps GM_download (with a manual-save fallback) in a Promise, complete
   * with retry/back-off and progress reporting.
   * ======================================================================== */
  const Downloader = {
    /** IDs already downloaded this browser session (in-memory only). */
    _downloadedIds: new Set(),
    /** IDs currently mid-download, to prevent double-clicks. */
    _inFlight: new Set(),

    isGmDownloadAvailable() {
      return typeof GM_download === 'function';
    },

    /**
     * @param {{id:string,url:string,ext:string,resolution:string,category:string,size:string}} data
     * @param {{saveAs?: boolean, onProgress?: Function, force?: boolean}} [options]
     * @returns {Promise<{filename:string}>}
     */
    async download(data, options = {}) {
      if (this._inFlight.has(data.id)) {
        throw new Error('A download for this wallpaper is already in progress.');
      }

      if (CONFIG.preventDuplicates && this._downloadedIds.has(data.id) && !options.force) {
        const err = new Error('DUPLICATE');
        err.code = 'DUPLICATE';
        throw err;
      }

      this._inFlight.add(data.id);
      const filename = Utils.renderFilename(data);

      try {
        await this._downloadWithRetry(data.url, filename, options);
        this._downloadedIds.add(data.id);
        return { filename };
      } finally {
        this._inFlight.delete(data.id);
      }
    },

    /**
     * @param {string} url
     * @param {string} filename
     * @param {{saveAs?: boolean, onProgress?: Function}} options
     */
    async _downloadWithRetry(url, filename, options) {
      const maxAttempts = Math.max(1, CONFIG.retryCount);
      let lastError = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          await this._downloadOnce(url, filename, options);
          return;
        } catch (err) {
          lastError = err;
          Logger.warn(`Download attempt ${attempt}/${maxAttempts} failed:`, err);
          if (attempt < maxAttempts) {
            await Utils.sleep(CONFIG.retryDelay * attempt);
          }
        }
      }

      throw lastError ?? new Error('Unknown download failure.');
    },

    /**
     * @param {string} url
     * @param {string} filename
     * @param {{saveAs?: boolean, onProgress?: Function}} options
     */
    _downloadOnce(url, filename, options) {
      const saveAs = options.saveAs ?? CONFIG.saveAs;

      if (!this.isGmDownloadAvailable()) {
        // Graceful fallback for userscript managers without GM_download
        // support (e.g. some Greasemonkey configurations): open the
        // original image in a new tab so the user can save it manually.
        Logger.warn('GM_download is unavailable; opening original image for manual save.');
        if (typeof GM_openInTab === 'function') {
          GM_openInTab(url, { active: true, insert: true, setParent: true });
        } else {
          window.open(url, '_blank', 'noopener');
        }
        return Promise.resolve();
      }

      return new Promise((resolve, reject) => {
        let settled = false;
        const timeoutHandle = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error('Download timed out.'));
        }, 30000);

        try {
          GM_download({
            url,
            name: filename,
            saveAs,
            onload: () => {
              if (settled) return;
              settled = true;
              clearTimeout(timeoutHandle);
              resolve();
            },
            onerror: (err) => {
              if (settled) return;
              settled = true;
              clearTimeout(timeoutHandle);
              const reason = err && err.error ? err.error : 'unknown_error';
              reject(new Error(`GM_download failed: ${reason}`));
            },
            ontimeout: () => {
              if (settled) return;
              settled = true;
              clearTimeout(timeoutHandle);
              reject(new Error('GM_download timed out.'));
            },
            onprogress: (progress) => {
              if (typeof options.onProgress === 'function' && progress && progress.lengthComputable) {
                options.onProgress(progress.loaded / progress.total);
              }
            },
          });
        } catch (err) {
          clearTimeout(timeoutHandle);
          settled = true;
          reject(err);
        }
      });
    },
  };

  /* ==========================================================================
   * UI
   * Injects the download control into Wallhaven's existing action bar,
   * falling back to a floating button if the action bar cannot be located.
   * ======================================================================== */
  const UI = {
    _button: null,
    _progressRing: null,

    /**
     * Candidate selectors for Wallhaven's native action bar, ordered from
     * most to least specific. Kept as a list (rather than one fragile
     * selector) so markup tweaks on Wallhaven's end don't break injection.
     */
    ACTION_BAR_SELECTORS: [
      '#wallpaper-actions .actions',
      '#wallpaper-actions',
      '.showcase-sidebar .actions',
      '.sidebar-content .actions',
      '.showcase-stats + .actions',
    ],

    async mount() {
      this.unmount();

      let hostBar = null;
      for (const selector of this.ACTION_BAR_SELECTORS) {
        hostBar = document.querySelector(selector);
        if (hostBar) break;
      }
      if (!hostBar) {
        hostBar = await Utils.waitForElement(this.ACTION_BAR_SELECTORS.join(', '), {
          timeout: 3000,
        });
      }

      const button = this._buildButton();
      this._button = button;

      if (hostBar) {
        hostBar.appendChild(button);
        Logger.debug('Mounted download button into native action bar.');
      } else if (CONFIG.enableFloatingFallback) {
        button.classList.add('wod-floating');
        document.body.appendChild(button);
        Logger.debug('Native action bar not found; using floating fallback button.');
      } else {
        Logger.warn('Native action bar not found and floating fallback is disabled; UI not mounted.');
        this._button = null;
      }
    },

    unmount() {
      if (this._button && this._button.isConnected) {
        this._button.remove();
      }
      this._button = null;
    },

    _buildButton() {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'wod-btn';
      button.title = 'Download original wallpaper (D)';
      button.setAttribute('aria-label', 'Download original wallpaper');

      const iconSpan = document.createElement('span');
      iconSpan.className = 'wod-btn__icon';
      iconSpan.innerHTML = Icons.download;
      button.appendChild(iconSpan);

      const label = document.createElement('span');
      label.className = 'wod-btn__label';
      label.textContent = 'Original';
      button.appendChild(label);

      button.addEventListener('click', () => {
        void App.handleDownloadRequest({ saveAs: CONFIG.saveAs });
      });

      return button;
    },

    setState(state) {
      const button = this._button;
      if (!button) return;

      button.classList.remove('wod-btn--disabled', 'wod-btn--success', 'wod-btn--error');
      const icon = button.querySelector('.wod-btn__icon');

      switch (state) {
        case 'loading':
          button.classList.add('wod-btn--disabled');
          button.disabled = true;
          if (icon) icon.innerHTML = Icons.spinner;
          break;
        case 'success':
          button.disabled = false;
          button.classList.add('wod-btn--success');
          if (icon) icon.innerHTML = Icons.success;
          setTimeout(() => this.setState('idle'), 1600);
          break;
        case 'error':
          button.disabled = false;
          button.classList.add('wod-btn--error');
          if (icon) icon.innerHTML = Icons.error;
          setTimeout(() => this.setState('idle'), 2000);
          break;
        case 'idle':
        default:
          button.disabled = false;
          if (icon) icon.innerHTML = Icons.download;
          break;
      }
    },
  };

  /* ==========================================================================
   * CONTEXT MENU
   * A small custom right-click menu on the wallpaper image.
   * ======================================================================== */
  const ContextMenu = {
    _menuEl: null,

    attach(imageEl) {
      if (!CONFIG.enableContextMenu || !imageEl) return;
      imageEl.addEventListener('contextmenu', (event) => this._onContextMenu(event));
    },

    _onContextMenu(event) {
      event.preventDefault();
      this._close();

      const items = [
        { label: 'Download Original', action: () => App.handleDownloadRequest({ saveAs: CONFIG.saveAs }) },
        { label: 'Open Original', action: () => App.openOriginal() },
        { label: 'Copy Image URL', action: () => App.copyImageUrl() },
        { label: 'Copy Filename', action: () => App.copyFilename() },
      ];

      const menu = document.createElement('div');
      menu.className = 'wod-context-menu';
      for (const item of items) {
        const el = document.createElement('div');
        el.className = 'wod-context-menu__item';
        el.textContent = item.label;
        el.addEventListener('click', () => {
          this._close();
          void item.action();
        });
        menu.appendChild(el);
      }

      document.body.appendChild(menu);
      this._menuEl = menu;

      const { innerWidth, innerHeight } = window;
      const rect = menu.getBoundingClientRect();
      const x = Math.min(event.clientX, innerWidth - rect.width - 8);
      const y = Math.min(event.clientY, innerHeight - rect.height - 8);
      menu.style.left = `${Math.max(8, x)}px`;
      menu.style.top = `${Math.max(8, y)}px`;

      const closeOnOutsideClick = (e) => {
        if (!menu.contains(e.target)) {
          this._close();
          document.removeEventListener('click', closeOnOutsideClick, true);
          document.removeEventListener('keydown', closeOnEscape, true);
        }
      };
      const closeOnEscape = (e) => {
        if (e.key === 'Escape') {
          this._close();
          document.removeEventListener('click', closeOnOutsideClick, true);
          document.removeEventListener('keydown', closeOnEscape, true);
        }
      };
      setTimeout(() => {
        document.addEventListener('click', closeOnOutsideClick, true);
        document.addEventListener('keydown', closeOnEscape, true);
      }, 0);
    },

    _close() {
      if (this._menuEl && this._menuEl.isConnected) {
        this._menuEl.remove();
      }
      this._menuEl = null;
    },
  };

  /* ==========================================================================
   * KEYBOARD
   * Handles the D / Ctrl+D / Shift+D / Alt+D shortcuts, ignoring keystrokes
   * while the user is typing in a form field.
   * ======================================================================== */
  const Keyboard = {
    _handler: null,

    attach() {
      if (!CONFIG.keyboardShortcuts) return;
      this.detach();
      this._handler = (event) => this._onKeyDown(event);
      document.addEventListener('keydown', this._handler, true);
    },

    detach() {
      if (this._handler) {
        document.removeEventListener('keydown', this._handler, true);
        this._handler = null;
      }
    },

    _isTypingContext(event) {
      const target = event.target;
      if (!target) return false;
      const tag = target.tagName;
      return (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        target.isContentEditable === true
      );
    },

    _matches(event, shortcut) {
      return (
        event.key.toLowerCase() === shortcut.key &&
        event.ctrlKey === shortcut.ctrl &&
        event.shiftKey === shortcut.shift &&
        event.altKey === shortcut.alt &&
        !event.metaKey
      );
    },

    _onKeyDown(event) {
      if (this._isTypingContext(event)) return;

      const { shortcuts } = CONFIG;

      if (this._matches(event, shortcuts.downloadNoDialog)) {
        event.preventDefault();
        void App.handleDownloadRequest({ saveAs: false });
      } else if (this._matches(event, shortcuts.copyUrl)) {
        event.preventDefault();
        void App.copyImageUrl();
      } else if (this._matches(event, shortcuts.copyFilename)) {
        event.preventDefault();
        void App.copyFilename();
      } else if (this._matches(event, shortcuts.download)) {
        event.preventDefault();
        void App.handleDownloadRequest({ saveAs: CONFIG.saveAs });
      }
    },
  };

  /* ==========================================================================
   * PAGE OBSERVER
   * Wallhaven wallpaper pages are mostly server-rendered, but this observer
   * makes the script resilient to client-side navigation, lazy-loaded
   * images, and future SPA-style changes without polling.
   * ======================================================================== */
  const PageObserver = {
    _mutationObserver: null,
    _lastId: null,

    start() {
      this.stop();
      this._lastId = Utils.extractId(location.href);

      this._patchHistoryApi();
      window.addEventListener('popstate', this._onNavigate);
      window.addEventListener('wod:navigate', this._onNavigate);

      const debouncedCheck = Utils.debounce(() => this._checkForContentChange(), CONFIG.domObserverDebounce);
      this._mutationObserver = new MutationObserver(debouncedCheck);
      this._mutationObserver.observe(document.body, { childList: true, subtree: true });
    },

    stop() {
      if (this._mutationObserver) {
        this._mutationObserver.disconnect();
        this._mutationObserver = null;
      }
      window.removeEventListener('popstate', this._onNavigate);
      window.removeEventListener('wod:navigate', this._onNavigate);
    },

    _patchHistoryApi() {
      if (history.__wodPatched) return;
      const fire = () => window.dispatchEvent(new Event('wod:navigate'));

      for (const method of ['pushState', 'replaceState']) {
        const original = history[method];
        history[method] = function patched(...args) {
          const result = original.apply(this, args);
          fire();
          return result;
        };
      }
      history.__wodPatched = true;
    },

    _onNavigate: () => {
      PageObserver._checkForContentChange();
    },

    _checkForContentChange() {
      const currentId = Utils.extractId(location.href) || Utils.extractId(document.querySelector('img#wallpaper')?.src || '');
      if (currentId !== this._lastId) {
        this._lastId = currentId;
        Logger.debug('Detected navigation to a new wallpaper, reinitializing.', currentId);
        WallpaperData.reset();
        void App.initPage();
      }
    },
  };

  /* ==========================================================================
   * MAIN APPLICATION
   * Coordinates the modules above and exposes the actions used by the UI,
   * keyboard shortcuts, and context menu.
   * ======================================================================== */
  const App = {
    async init() {
      injectStyles();
      Keyboard.attach();
      PageObserver.start();
      this._registerMenuCommands();
      await this.initPage();
    },

    /** (Re-)initializes everything that depends on the current page's wallpaper. */
    async initPage() {
      UI.unmount();

      if (!/\/w\/[a-z0-9]+/i.test(location.pathname)) {
        Logger.debug('Not a wallpaper detail page; skipping UI mount.');
        return;
      }

      await UI.mount();

      const img = await WallpaperData.findImageElement();
      if (img) {
        ContextMenu.attach(img);
      }
    },

    _registerMenuCommands() {
      if (typeof GM_registerMenuCommand !== 'function') return;
      try {
        GM_registerMenuCommand('Download original wallpaper', () => {
          void this.handleDownloadRequest({ saveAs: CONFIG.saveAs });
        });
        GM_registerMenuCommand('Copy original image URL', () => void this.copyImageUrl());
        GM_registerMenuCommand('Copy filename', () => void this.copyFilename());
      } catch (err) {
        Logger.warn('Failed to register menu commands', err);
      }
    },

    /**
     * @param {{saveAs?: boolean, force?: boolean}} [options]
     */
    async handleDownloadRequest(options = {}) {
      UI.setState('loading');

      let data;
      try {
        data = await WallpaperData.resolve();
      } catch (err) {
        Logger.error('Failed to resolve wallpaper metadata', err);
        data = null;
      }

      if (!data) {
        UI.setState('error');
        Notifications.error('Could not find the original wallpaper image on this page.');
        return;
      }

      try {
        const result = await Downloader.download(data, options);
        UI.setState('success');
        Notifications.success(`Saved as ${result.filename}`);
      } catch (err) {
        if (err && err.code === 'DUPLICATE') {
          UI.setState('idle');
          Notifications.warning('Already downloaded this wallpaper this session.', {
            actionLabel: 'Download again',
            onAction: () => void this.handleDownloadRequest({ ...options, force: true }),
          });
          return;
        }

        Logger.error('Download failed', err);
        UI.setState('error');
        Notifications.error('Download failed. Click retry to try again.', {
          actionLabel: 'Retry',
          onAction: () => void this.handleDownloadRequest(options),
          duration: 6000,
        });
      }
    },

    async openOriginal() {
      const data = await WallpaperData.resolve();
      if (!data) {
        Notifications.error('Could not find the original wallpaper image on this page.');
        return;
      }
      if (typeof GM_openInTab === 'function') {
        GM_openInTab(data.url, { active: true, insert: true, setParent: true });
      } else {
        window.open(data.url, '_blank', 'noopener');
      }
    },

    async copyImageUrl() {
      const data = await WallpaperData.resolve();
      if (!data) {
        Notifications.error('Could not find the original wallpaper image on this page.');
        return;
      }
      const ok = await Utils.copyToClipboard(data.url);
      if (ok) Notifications.success('Image URL copied to clipboard.');
      else Notifications.error('Could not copy the image URL.');
    },

    async copyFilename() {
      const data = await WallpaperData.resolve();
      if (!data) {
        Notifications.error('Could not find the original wallpaper image on this page.');
        return;
      }
      const filename = Utils.renderFilename(data);
      const ok = await Utils.copyToClipboard(filename);
      if (ok) Notifications.success(`Filename copied: ${filename}`);
      else Notifications.error('Could not copy the filename.');
    },

    async copyTags() {
      const tagEls = document.querySelectorAll('#tags a, .tag-list a, a.tag');
      const tags = Array.from(tagEls)
        .map((el) => el.textContent.trim())
        .filter(Boolean);
      if (tags.length === 0) {
        Notifications.error('No tags found on this page.');
        return;
      }
      const ok = await Utils.copyToClipboard(tags.join(', '));
      if (ok) Notifications.success('Tags copied to clipboard.');
      else Notifications.error('Could not copy tags.');
    },
  };

  /* ==========================================================================
   * BOOTSTRAP
   * ======================================================================== */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void App.init());
  } else {
    void App.init();
  }
})();
