// ==UserScript==
// @name         WallFetch
// @namespace    https://github.com/itachi-re/wallfetch
// @version      1.5.1
// @description  Download original-resolution wallpapers from Wallhaven with metadata, persistent settings, download queue, and advanced customization.
// @author       itachi-re
// @license      MIT

// @homepageURL https://github.com/itachi-re/wallfetch
// @supportURL  https://github.com/itachi-re/wallfetch/issues
// @updateURL   https://update.greasyfork.org/scripts/587780/WallFetch.meta.js
// @downloadURL https://update.greasyfork.org/scripts/587780/WallFetch.user.js

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
// @homepage      https://github.com/itachi-re/wallfetch
// @source        https://github.com/itachi-re/wallfetch
// @compatible    chrome
// @compatible    firefox
// @compatible    edge
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
 *
 * NOTE: Update @downloadURL / @updateURL above to point at wherever you
 * actually host this file (GitHub raw, GreasyFork, etc.) before publishing.
 */

(() => {
  'use strict';

  const LOG_PREFIX = '[Wallhaven Enhanced Downloader+]';

  /**
   * Minimal internal logger so debug output can be toggled from one place.
   */
  const Logger = {
    debug(...args) {
      if (Config.STATIC.debug) console.debug(LOG_PREFIX, ...args);
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
   * CONFIG
   * Two tiers: STATIC (constants that rarely change and aren't exposed in the
   * settings UI) and PERSISTED_DEFAULTS (user-configurable values that are
   * loaded from / saved to GM storage by the Settings module below).
   * ======================================================================== */
  const Config = Object.freeze({
    STATIC: Object.freeze({
      darkTheme: true,
      showProgress: true,
      toastDurationMs: 4200,
      elementWaitTimeout: 8000,
      domObserverDebounce: 250,
      retryDelay: 1000, // ms, multiplied by attempt number (linear backoff)
      enableFloatingFallback: true,
      sanitizeFilenames: true,
      debug: false,
      shortcuts: Object.freeze({
        download: { key: 'd', ctrl: false, shift: false, alt: false }, // D
        downloadNoDialog: { key: 'd', ctrl: true, shift: false, alt: false }, // Ctrl+D
        copyUrl: { key: 'd', ctrl: false, shift: true, alt: false }, // Shift+D
        copyFilename: { key: 'd', ctrl: false, shift: false, alt: true }, // Alt+D
      }),
    }),

    /** User-configurable values, persisted via GM_getValue/GM_setValue. */
    PERSISTED_DEFAULTS: Object.freeze({
      saveAs: false,
      filenameTemplate: '{id}',
      showNotifications: true,
      preventDuplicates: true,
      keyboardShortcuts: true,
      enableContextMenu: true,
      retryCount: 3,
      removeWallhavenPrefix: true,
      apiKey: '', // optional Wallhaven API key, needed to read NSFW metadata
    }),

    STORAGE_PREFIX: 'wod_',
    HISTORY_KEY: 'wod_download_history',
    MAX_HISTORY_ENTRIES: 300,
  });

  /** User-friendly text for classified download/API errors. */
  const ERROR_MESSAGES = Object.freeze({
    FORBIDDEN: 'Access denied (403) — the file may be protected or you may be rate-limited.',
    NOT_FOUND: 'Original image not found (404) — it may have been removed.',
    RATE_LIMITED: 'Rate limited by Wallhaven (429) — please wait a moment and retry.',
    CHALLENGE_PAGE: 'Received a verification page instead of the image (possible Cloudflare challenge).',
    INVALID_CONTENT_TYPE: 'The server did not return an image file; refusing to save it.',
    EMPTY_RESPONSE: 'The downloaded file was empty; refusing to save it.',
    NETWORK_ERROR: 'A network error occurred while downloading.',
    TIMEOUT: 'The download timed out.',
    HTTP_ERROR: 'The server returned an unexpected response.',
    GM_DOWNLOAD_FAILED: 'Your userscript manager could not save the file.',
    ALREADY_QUEUED: 'This wallpaper is already queued for download.',
    PERMISSION_DENIED: 'Download permission was denied by the browser or extension.',
  });

  /**
   * Build an Error carrying a machine-readable `code` for classification.
   * @param {string} code
   * @param {string} message
   */
  function classifiedError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  /* ==========================================================================
   * GMC (GreaseMonkey Compatibility shim)
   * Every GM_* API is called through here so the script degrades gracefully
   * across Tampermonkey, Violentmonkey, FireMonkey, and Greasemonkey's
   * promise-based GM.* namespace, without scattering feature-detection
   * throughout the rest of the code.
   * ======================================================================== */
  const GMC = {
    hasDownload() {
      return typeof GM_download === 'function';
    },
    download(details) {
      if (typeof GM_download === 'function') return GM_download(details);
      throw classifiedError('GM_DOWNLOAD_FAILED', 'GM_download is not available in this userscript manager.');
    },
    xmlHttpRequest(details) {
      if (typeof GM_xmlhttpRequest === 'function') return GM_xmlhttpRequest(details);
      if (typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function') return GM.xmlHttpRequest(details);
      throw classifiedError('NETWORK_ERROR', 'GM_xmlhttpRequest is not available in this userscript manager.');
    },
    setClipboard(text, type) {
      if (typeof GM_setClipboard === 'function') return GM_setClipboard(text, type);
      if (typeof GM !== 'undefined' && typeof GM.setClipboard === 'function') return GM.setClipboard(text, type);
      return null;
    },
    addStyle(css) {
      if (typeof GM_addStyle === 'function') return GM_addStyle(css);
      if (typeof GM !== 'undefined' && typeof GM.addStyle === 'function') return GM.addStyle(css);
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);
      return style;
    },
    registerMenuCommand(label, fn) {
      if (typeof GM_registerMenuCommand === 'function') return GM_registerMenuCommand(label, fn);
      if (typeof GM !== 'undefined' && typeof GM.registerMenuCommand === 'function') return GM.registerMenuCommand(label, fn);
      return null;
    },
    openInTab(url, options) {
      if (typeof GM_openInTab === 'function') return GM_openInTab(url, options);
      if (typeof GM !== 'undefined' && typeof GM.openInTab === 'function') return GM.openInTab(url, options);
      window.open(url, '_blank', 'noopener');
      return null;
    },
    async getValue(key, defaultValue) {
      try {
        if (typeof GM_getValue === 'function') return GM_getValue(key, defaultValue);
        if (typeof GM !== 'undefined' && typeof GM.getValue === 'function') return await GM.getValue(key, defaultValue);
      } catch (err) {
        Logger.warn(`GM getValue failed for "${key}"`, err);
      }
      return defaultValue;
    },
    async setValue(key, value) {
      try {
        if (typeof GM_setValue === 'function') return GM_setValue(key, value);
        if (typeof GM !== 'undefined' && typeof GM.setValue === 'function') return await GM.setValue(key, value);
      } catch (err) {
        Logger.warn(`GM setValue failed for "${key}"`, err);
      }
      return undefined;
    },
  };

  /* ==========================================================================
   * SETTINGS
   * Loads user-configurable values from GM storage at startup, exposes a
   * synchronous `get()` for the rest of the app, and persists changes made
   * through the Settings UI. Falls back to Config.PERSISTED_DEFAULTS for any
   * key that has never been saved.
   * ======================================================================== */
  const Settings = {
    values: { ...Config.PERSISTED_DEFAULTS },
    _loaded: false,

    async init() {
      const keys = Object.keys(Config.PERSISTED_DEFAULTS);
      const loaded = await Promise.all(
        keys.map((key) => GMC.getValue(Config.STORAGE_PREFIX + key, Config.PERSISTED_DEFAULTS[key]))
      );
      keys.forEach((key, index) => {
        this.values[key] = loaded[index];
      });
      this._loaded = true;
      Logger.debug('Settings loaded', this.values);
    },

    /** @param {string} key */
    get(key) {
      return Object.prototype.hasOwnProperty.call(this.values, key)
        ? this.values[key]
        : Config.PERSISTED_DEFAULTS[key];
    },

    /**
     * @param {string} key
     * @param {*} value
     */
    async set(key, value) {
      this.values[key] = value;
      await GMC.setValue(Config.STORAGE_PREFIX + key, value);
    },

    async resetAll() {
      for (const key of Object.keys(Config.PERSISTED_DEFAULTS)) {
        this.values[key] = Config.PERSISTED_DEFAULTS[key];
        // eslint-disable-next-line no-await-in-loop
        await GMC.setValue(Config.STORAGE_PREFIX + key, Config.PERSISTED_DEFAULTS[key]);
      }
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
      const timeout = options.timeout ?? Config.STATIC.elementWaitTimeout;

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
     * Format a byte count into a human-readable string (e.g. "1.16 MB").
     * @param {number|null|undefined} bytes
     * @returns {string}
     */
    formatBytes(bytes) {
      if (!bytes || bytes <= 0) return 'unknown';
      const units = ['B', 'KB', 'MB', 'GB'];
      let value = bytes;
      let unitIndex = 0;
      while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
      }
      return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
    },

    /**
     * Find a sidebar "stat" value (e.g. Resolution, Size, Views) by its label
     * text. Used only as a fallback when the Wallhaven API is unreachable.
     * Wallhaven renders stats as label/value pairs; searching generically by
     * visible label text (instead of relying on class names) keeps this
     * working even if markup/classes change.
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

        const value = el.nextElementSibling;
        if (value && value.textContent) {
          return value.textContent.trim();
        }
      }
      return null;
    },

    /**
     * Best-effort detection of the wallpaper's category (general/anime/people)
     * from the HTML. Only used when the API is unreachable.
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

      const tagLinks = document.querySelectorAll('#tags a, .tag-list a, a.tag');
      for (const link of tagLinks) {
        const href = link.getAttribute('href') || '';
        const match = href.match(/[?&]categories=([^&]+)/i);
        if (match) return match[1];
      }

      return null;
    },

    /**
     * Best-effort detection of purity (sfw/sketchy/nsfw) from the HTML.
     * Only used when the API is unreachable.
     * @returns {string|null}
     */
    detectPurity() {
      const fromStat = Utils.findStatByLabel('Purity');
      if (fromStat) return fromStat.toLowerCase();

      const activeSelectors = ['.purity-icons .active', '[data-purity].active'];
      for (const selector of activeSelectors) {
        const el = document.querySelector(selector);
        if (el) {
          const text = (el.textContent || el.getAttribute('title') || '').trim().toLowerCase();
          if (text) return text;
        }
      }
      return null;
    },

    /**
     * Best-effort detection of the uploader's username from the HTML.
     * Only used when the API is unreachable.
     * @returns {string|null}
     */
    detectUploader() {
      const link = document.querySelector('a[href^="/user/"]');
      return link ? link.textContent.trim() : null;
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
      if (!Config.STATIC.sanitizeFilenames) return name;
      return name
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
        .replace(/\s+/g, '_')
        .replace(/_{2,}/g, '_')
        .trim();
    },

    /**
     * Render a filename from the configured template, substituting tokens.
     * Supported tokens: {id} {resolution} {width} {height} {ratio}
     * {category} {ext} {extension} {size} {filesize} {views} {favorites}
     * {purity} {uploader} {colors} {date}
     *
     * @param {import('./WallpaperData').WallpaperMeta} data
     * @returns {string}
     */
    renderFilename(data) {
      const ext = data.ext ?? 'jpg';
      const tokens = {
        '{id}': data.id ?? 'unknown',
        '{resolution}': Utils.normalizeResolution(data.resolution),
        '{width}': data.width ?? 'unknown',
        '{height}': data.height ?? 'unknown',
        '{ratio}': data.ratio ?? 'unknown',
        '{category}': data.category ?? 'wallpaper',
        '{ext}': ext,
        '{extension}': ext,
        '{size}': data.size ?? 'unknown',
        '{filesize}': data.filesize != null ? Utils.formatBytes(data.filesize) : data.size ?? 'unknown',
        '{views}': data.views ?? 'unknown',
        '{favorites}': data.favorites ?? 'unknown',
        '{purity}': data.purity ?? 'unknown',
        '{uploader}': data.uploader ?? 'unknown',
        '{colors}': data.colors ?? 'unknown',
        '{date}': data.date ?? 'unknown',
      };

      const tokenPattern = new RegExp(Object.keys(tokens).map((t) => t.replace(/[{}]/g, '\\$&')).join('|'), 'g');

      let base = Settings.get('filenameTemplate').replace(tokenPattern, (match) => `${tokens[match]}` ?? match);

      if (Settings.get('removeWallhavenPrefix')) {
        base = base.replace(/^wallhaven-/i, '');
      }

      return Utils.sanitizeFilename(`${base}.${ext}`);
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
        const result = GMC.setClipboard(text, 'text');
        if (result !== null) return true;
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
   * API CLIENT
   * Talks to the official Wallhaven API (https://wallhaven.cc/api/v1/w/{id})
   * to fetch rich, reliable metadata in a single request. HTML scraping is
   * only used as a fallback if this fails (auth-gated NSFW walls without an
   * API key, network issues, API downtime, etc.).
   * ======================================================================== */
  const ApiClient = {
    BASE_URL: 'https://wallhaven.cc/api/v1/w/',

    /**
     * @param {string} id
     * @returns {Promise<object>} the API's `data` object
     */
    fetchWallpaper(id) {
      const apiKey = Settings.get('apiKey');
      const url = this.BASE_URL + encodeURIComponent(id) + (apiKey ? `?apikey=${encodeURIComponent(apiKey)}` : '');

      return new Promise((resolve, reject) => {
        let request;
        try {
          request = GMC.xmlHttpRequest({
            method: 'GET',
            url,
            timeout: 10000,
            responseType: 'text',
            headers: { Accept: 'application/json' },
            onload: (resp) => {
              if (resp.status === 401 || resp.status === 403) {
                return reject(classifiedError('FORBIDDEN', 'Wallhaven API access denied (NSFW walls require an API key).'));
              }
              if (resp.status === 404) {
                return reject(classifiedError('NOT_FOUND', 'Wallhaven API reported this wallpaper does not exist.'));
              }
              if (resp.status === 429) {
                return reject(classifiedError('RATE_LIMITED', 'Wallhaven API rate limit reached.'));
              }
              if (resp.status !== 200) {
                return reject(classifiedError('HTTP_ERROR', `Wallhaven API returned HTTP ${resp.status}.`));
              }
              try {
                const json = JSON.parse(resp.responseText);
                if (!json || !json.data) {
                  return reject(new Error('Malformed Wallhaven API response.'));
                }
                resolve(json.data);
              } catch (err) {
                reject(err);
              }
            },
            onerror: () => reject(classifiedError('NETWORK_ERROR', 'Network error contacting the Wallhaven API.')),
            ontimeout: () => reject(classifiedError('TIMEOUT', 'Wallhaven API request timed out.')),
          });
        } catch (err) {
          reject(err);
        }
        return request;
      });
    },
  };

  /* ==========================================================================
   * WALLPAPER DATA
   * Resolves everything we know about the wallpaper currently on screen,
   * preferring the Wallhaven API and falling back to HTML parsing. Results
   * are cached per wallpaper ID until navigation invalidates the cache.
   * ======================================================================== */
  const WallpaperData = {
    /** @type {HTMLImageElement|null} */
    _imageEl: null,
    /** @type {object|null} */
    _cache: null,

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

      const found = await Utils.waitForElement(selectors.join(', '), {
        timeout: Config.STATIC.elementWaitTimeout,
      });
      if (found && found.tagName === 'IMG') {
        this._imageEl = found;
        return found;
      }
      return null;
    },

    /**
     * Gather all metadata needed to build a filename and perform a download.
     * Uses the Wallhaven API when possible, and caches the result per ID so
     * repeated actions (download, copy URL, copy filename, copy tags, open
     * original) don't repeat the same lookup.
     *
     * @param {{ forceRefresh?: boolean }} [options]
     * @returns {Promise<null | object>}
     */
    async resolve(options = {}) {
      const currentPageId = Utils.extractId(location.href);

      if (!options.forceRefresh && this._cache && this._cache.id === currentPageId) {
        return this._cache;
      }

      const img = await this.findImageElement();
      if (!img || !img.src) {
        Logger.warn('Could not locate the original wallpaper image on this page.');
        return null;
      }

      const url = img.src;
      const id = Utils.extractId(url) || currentPageId;
      const ext = Utils.extractExtension(url) || 'jpg';

      if (!id) {
        Logger.warn('Could not determine wallpaper ID.');
        return null;
      }

      let apiData = null;
      try {
        apiData = await ApiClient.fetchWallpaper(id);
      } catch (err) {
        Logger.warn('Wallhaven API lookup failed, falling back to HTML parsing.', err);
      }

      const data = apiData ? this._fromApi(apiData, { url, ext }) : this._fromHtml({ url, ext, id, img });
      this._cache = data;
      return data;
    },

    /**
     * @param {object} api - the Wallhaven API's `data` payload
     * @param {{url:string, ext:string}} fallback
     */
    _fromApi(api, fallback) {
      const width = api.dimension_x ?? null;
      const height = api.dimension_y ?? null;
      const imageUrl = api.path || fallback.url;

      return {
        id: api.id ?? Utils.extractId(imageUrl),
        url: imageUrl,
        ext: Utils.extractExtension(imageUrl) || fallback.ext,
        resolution: api.resolution || (width && height ? `${width}x${height}` : 'unknown'),
        width: width ?? 'unknown',
        height: height ?? 'unknown',
        ratio: api.ratio ? String(api.ratio) : width && height ? (width / height).toFixed(2) : 'unknown',
        category: api.category || 'wallpaper',
        purity: api.purity || 'unknown',
        uploader: api.uploader && api.uploader.username ? api.uploader.username : 'unknown',
        views: api.views ?? 'unknown',
        favorites: api.favorites ?? 'unknown',
        size: api.file_size ? Utils.formatBytes(api.file_size) : 'unknown',
        filesize: typeof api.file_size === 'number' ? api.file_size : null,
        colors: Array.isArray(api.colors) ? api.colors.join(',') : 'unknown',
        date: api.created_at ? String(api.created_at).split(' ')[0] : 'unknown',
        tags: Array.isArray(api.tags) ? api.tags.map((t) => t.name) : null,
        source: 'api',
      };
    },

    /**
     * @param {{url:string, ext:string, id:string, img:HTMLImageElement}} params
     */
    _fromHtml({ url, ext, id, img }) {
      const resolution = Utils.findStatByLabel('Resolution') || `${img.naturalWidth || 0}x${img.naturalHeight || 0}`;
      const [width, height] = Utils.normalizeResolution(resolution)
        .split('x')
        .map((n) => parseInt(n, 10) || 0);
      const sizeLabel = Utils.findStatByLabel('Size');

      return {
        id,
        url,
        ext,
        resolution,
        width: width || 'unknown',
        height: height || 'unknown',
        ratio: width && height ? (width / height).toFixed(2) : 'unknown',
        category: Utils.detectCategory() || 'wallpaper',
        purity: Utils.detectPurity() || 'unknown',
        uploader: Utils.detectUploader() || 'unknown',
        views: Utils.findStatByLabel('Views') || 'unknown',
        favorites: Utils.findStatByLabel('Favorites') || 'unknown',
        size: sizeLabel || 'unknown',
        filesize: null,
        colors: 'unknown',
        date: Utils.findStatByLabel('Uploaded') || 'unknown',
        tags: null,
        source: 'html',
      };
    },

    /** Clear cached references, e.g. after SPA-style navigation. */
    reset() {
      this._imageEl = null;
      this._cache = null;
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
     * @returns {{dismiss: Function, setText: Function}|undefined}
     */
    show(message, type = 'info', options = {}) {
      if (!Settings.get('showNotifications')) return undefined;

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

      const duration = options.duration ?? Config.STATIC.toastDurationMs;
      if (duration > 0) setTimeout(dismiss, duration);

      return {
        dismiss,
        setText: (newMessage) => {
          text.textContent = newMessage;
        },
      };
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
    gear:
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/>' +
      '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 ' +
      '1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83' +
      'l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82' +
      'l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51' +
      ' 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4' +
      'h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  };

  /* ==========================================================================
   * STYLES
   * Injected once. Uses CSS variables so it can be re-themed easily and
   * matches Wallhaven's existing dark palette.
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
      .wod-btn__ring {
        position: absolute;
        inset: -3px;
        border-radius: 9px;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.15s ease;
        padding: 2px;
        background: conic-gradient(var(--wod-accent) calc(var(--wod-progress, 0) * 360deg), transparent 0);
        -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
        mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
        -webkit-mask-composite: xor;
        mask-composite: exclude;
      }
      .wod-btn--loading .wod-btn__ring {
        opacity: 1;
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

      .wod-floating-group {
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: 9999;
        display: flex;
        gap: 8px;
      }
      .wod-floating-group .wod-btn {
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

      .wod-modal-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.55);
        z-index: 10002;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
      }
      .wod-modal {
        width: 100%;
        max-width: 440px;
        max-height: 86vh;
        overflow-y: auto;
        background: var(--wod-bg);
        border: 1px solid var(--wod-border);
        border-radius: 10px;
        color: var(--wod-text);
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.55);
      }
      .wod-modal__header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 16px;
        border-bottom: 1px solid var(--wod-border);
      }
      .wod-modal__header h2 {
        font-size: 15px;
        margin: 0;
      }
      .wod-modal__close {
        background: transparent;
        border: none;
        color: var(--wod-muted);
        font-size: 20px;
        cursor: pointer;
        line-height: 1;
      }
      .wod-modal__close:hover { color: var(--wod-text); }
      .wod-modal__body {
        padding: 14px 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .wod-field {
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-size: 13px;
      }
      .wod-field--checkbox {
        flex-direction: row;
        align-items: center;
        gap: 8px;
      }
      .wod-field input[type="text"],
      .wod-field input[type="number"],
      .wod-field input[type="password"] {
        background: #1b1b20;
        border: 1px solid var(--wod-border);
        border-radius: 4px;
        color: var(--wod-text);
        padding: 6px 8px;
        font-size: 13px;
      }
      .wod-field input:focus {
        outline: none;
        border-color: var(--wod-accent);
      }
      .wod-field__hint {
        font-size: 11px;
        color: var(--wod-muted);
        margin: -6px 0 0;
        line-height: 1.5;
      }
      .wod-modal__footer {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding: 14px 16px;
        border-top: 1px solid var(--wod-border);
      }
      .wod-btn--primary {
        background: var(--wod-accent);
        color: #0b1a1f;
        border-color: var(--wod-accent);
        font-weight: 600;
      }
      .wod-btn--primary:hover {
        filter: brightness(1.08);
      }
    `;

    GMC.addStyle(css);
  }

  /* ==========================================================================
   * DOWNLOADER
   * Fetches the original image via GM_xmlhttpRequest as a validated Blob
   * (HTTP status, content-type, content-length, and non-empty checks) before
   * ever touching disk, then saves the Blob via GM_download - falling back
   * to a universal anchor-click Blob download when GM_download is
   * unavailable. Retries transient failures with linear back-off and skips
   * retrying permanent failures (404, 403, invalid content, etc).
   * ======================================================================== */
  const PERMANENT_ERROR_CODES = new Set([
    'NOT_FOUND',
    'FORBIDDEN',
    'CHALLENGE_PAGE',
    'INVALID_CONTENT_TYPE',
    'EMPTY_RESPONSE',
  ]);

  const Downloader = {
    /** In-memory mirror of persisted download history (session + past runs). */
    _history: [],
    _downloadedIds: new Set(),

    /** Load persisted download history from GM storage. Call once at startup. */
    async loadHistory() {
      const stored = await GMC.getValue(Config.HISTORY_KEY, []);
      this._history = Array.isArray(stored) ? stored : [];
      this._downloadedIds = new Set(this._history.map((entry) => entry.id));
    },

    async _persistHistory() {
      const trimmed = this._history.slice(-Config.MAX_HISTORY_ENTRIES);
      this._history = trimmed;
      await GMC.setValue(Config.HISTORY_KEY, trimmed);
    },

    async _recordDownload(id, filename) {
      this._history.push({ id, filename, timestamp: Date.now() });
      this._downloadedIds.add(id);
      await this._persistHistory();
    },

    async clearHistory() {
      this._history = [];
      this._downloadedIds.clear();
      await GMC.setValue(Config.HISTORY_KEY, []);
    },

    /**
     * @param {{id:string,url:string,ext:string}} data
     * @param {{saveAs?: boolean, force?: boolean, onProgress?: Function}} [options]
     * @returns {Promise<{filename:string}>}
     */
    async download(data, options = {}) {
      if (Settings.get('preventDuplicates') && this._downloadedIds.has(data.id) && !options.force) {
        throw classifiedError('DUPLICATE', 'Already downloaded this wallpaper this session.');
      }

      const filename = Utils.renderFilename(data);
      await this._downloadWithRetry(data.url, filename, options);
      await this._recordDownload(data.id, filename);
      return { filename };
    },

    /**
     * @param {string} url
     * @param {string} filename
     * @param {{saveAs?: boolean, onProgress?: Function}} options
     */
    async _downloadWithRetry(url, filename, options) {
      const maxAttempts = Math.max(1, Settings.get('retryCount'));
      let lastError = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await this._downloadOnce(url, filename, options);
          return;
        } catch (err) {
          lastError = err;
          Logger.warn(`Download attempt ${attempt}/${maxAttempts} failed [${err.code || 'UNKNOWN'}]`, err);
          if (PERMANENT_ERROR_CODES.has(err.code) || attempt >= maxAttempts) break;
          // eslint-disable-next-line no-await-in-loop
          await Utils.sleep(Config.STATIC.retryDelay * attempt);
        }
      }

      throw lastError ?? new Error('Unknown download failure.');
    },

    /**
     * @param {string} url
     * @param {string} filename
     * @param {{saveAs?: boolean, onProgress?: Function}} options
     */
    async _downloadOnce(url, filename, options) {
      const saveAs = options.saveAs ?? Settings.get('saveAs');
      const blob = await this._fetchValidatedBlob(url, options);
      await this._saveBlob(blob, filename, saveAs);
    },

    /**
     * GM_xmlhttpRequest-based fetch of the original image with full
     * validation before the bytes are ever handed off to be saved:
     *  - HTTP 200 required (403/404/429 classified explicitly)
     *  - Content-Type must be image/* (rejects HTML error/challenge pages)
     *  - Non-zero byte count required
     *  - Content-Length (if present) cross-checked against the actual Blob
     *
     * @param {string} url
     * @param {{onProgress?: Function}} options
     * @returns {Promise<Blob>}
     */
    _fetchValidatedBlob(url, options) {
      return new Promise((resolve, reject) => {
        try {
          GMC.xmlHttpRequest({
            method: 'GET',
            url,
            responseType: 'blob',
            timeout: 30000,
            headers: { Accept: 'image/*' },
            onprogress: (evt) => {
              if (typeof options.onProgress === 'function' && evt && evt.lengthComputable) {
                options.onProgress(evt.loaded / evt.total);
              }
            },
            onload: (resp) => {
              const status = resp.status;

              if (status === 403) {
                return reject(classifiedError('FORBIDDEN', ERROR_MESSAGES.FORBIDDEN));
              }
              if (status === 404) {
                return reject(classifiedError('NOT_FOUND', ERROR_MESSAGES.NOT_FOUND));
              }
              if (status === 429) {
                return reject(classifiedError('RATE_LIMITED', ERROR_MESSAGES.RATE_LIMITED));
              }
              if (status !== 200) {
                return reject(classifiedError('HTTP_ERROR', `Unexpected server response (HTTP ${status}).`));
              }

              const headers = resp.responseHeaders || '';
              const contentTypeMatch = headers.match(/^content-type:\s*([^\r\n]+)/im);
              const contentType = contentTypeMatch ? contentTypeMatch[1].split(';')[0].trim().toLowerCase() : '';
              const contentLengthMatch = headers.match(/^content-length:\s*(\d+)/im);
              const declaredLength = contentLengthMatch ? parseInt(contentLengthMatch[1], 10) : null;

              const blob = resp.response;

              if (declaredLength === 0 || !blob || blob.size === 0) {
                return reject(classifiedError('EMPTY_RESPONSE', ERROR_MESSAGES.EMPTY_RESPONSE));
              }
              if (contentType.startsWith('text/html')) {
                return reject(classifiedError('CHALLENGE_PAGE', ERROR_MESSAGES.CHALLENGE_PAGE));
              }
              if (contentType && !contentType.startsWith('image/')) {
                return reject(
                  classifiedError('INVALID_CONTENT_TYPE', `Unexpected content type "${contentType}"; refusing to save.`)
                );
              }
              if (declaredLength && blob.size !== declaredLength) {
                Logger.warn(`Content-Length mismatch for ${url}: expected ${declaredLength}, got ${blob.size}.`);
              }

              resolve(blob);
            },
            onerror: () => reject(classifiedError('NETWORK_ERROR', ERROR_MESSAGES.NETWORK_ERROR)),
            ontimeout: () => reject(classifiedError('TIMEOUT', ERROR_MESSAGES.TIMEOUT)),
          });
        } catch (err) {
          reject(err);
        }
      });
    },

    /**
     * Save an already-validated Blob to disk. Prefers GM_download (which can
     * honour the "Save As" dialog setting); falls back to a plain
     * anchor-click Blob download when GM_download isn't available at all
     * (e.g. some Greasemonkey configurations), which requires no special
     * permission and works purely in page context.
     *
     * @param {Blob} blob
     * @param {string} filename
     * @param {boolean} saveAs
     */
    _saveBlob(blob, filename, saveAs) {
      const objectUrl = URL.createObjectURL(blob);
      const revoke = () => setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);

      if (!GMC.hasDownload()) {
        Logger.warn('GM_download is unavailable; using anchor-based Blob download fallback.');
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        revoke();
        return Promise.resolve();
      }

      return new Promise((resolve, reject) => {
        let settled = false;
        const timeoutHandle = setTimeout(() => {
          if (settled) return;
          settled = true;
          revoke();
          reject(classifiedError('TIMEOUT', 'Saving the file timed out.'));
        }, 30000);

        try {
          GMC.download({
            url: objectUrl,
            name: filename,
            saveAs,
            onload: () => {
              if (settled) return;
              settled = true;
              clearTimeout(timeoutHandle);
              revoke();
              resolve();
            },
            onerror: (err) => {
              if (settled) return;
              settled = true;
              clearTimeout(timeoutHandle);
              revoke();
              const reason = err && err.error ? String(err.error) : 'unknown_error';
              const code = reason === 'permission_denied' ? 'PERMISSION_DENIED' : 'GM_DOWNLOAD_FAILED';
              reject(classifiedError(code, `GM_download failed: ${reason}`));
            },
            ontimeout: () => {
              if (settled) return;
              settled = true;
              clearTimeout(timeoutHandle);
              revoke();
              reject(classifiedError('TIMEOUT', 'GM_download timed out.'));
            },
          });
        } catch (err) {
          clearTimeout(timeoutHandle);
          settled = true;
          revoke();
          reject(err);
        }
      });
    },
  };

  /* ==========================================================================
   * DOWNLOAD QUEUE
   * Serializes downloads so only one runs at a time (rather than racing
   * multiple concurrent GM_xmlhttpRequest/GM_download calls), and rejects
   * attempts to queue the same wallpaper twice while it's already pending.
   * ======================================================================== */
  const DownloadQueue = {
    _items: [],
    _active: false,
    _queuedIds: new Set(),

    get size() {
      return this._items.length;
    },

    /**
     * @param {object} data
     * @param {object} options
     * @returns {Promise<{filename:string}>}
     */
    enqueue(data, options) {
      if (this._queuedIds.has(data.id)) {
        return Promise.reject(classifiedError('ALREADY_QUEUED', ERROR_MESSAGES.ALREADY_QUEUED));
      }

      this._queuedIds.add(data.id);
      return new Promise((resolve, reject) => {
        this._items.push({ data, options, resolve, reject });
        void this._pump();
      });
    },

    async _pump() {
      if (this._active) return;
      this._active = true;

      while (this._items.length > 0) {
        const { data, options, resolve, reject } = this._items.shift();
        try {
          // eslint-disable-next-line no-await-in-loop
          const result = await Downloader.download(data, options);
          resolve(result);
        } catch (err) {
          reject(err);
        } finally {
          this._queuedIds.delete(data.id);
        }
      }

      this._active = false;
    },
  };

  /* ==========================================================================
   * UI
   * Injects the download control (and a settings gear) into Wallhaven's
   * existing action bar, falling back to a floating button group if the
   * action bar cannot be located.
   * ======================================================================== */
  const UI = {
    _downloadButton: null,
    _settingsButton: null,
    _hostBar: null,

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
        hostBar = await Utils.waitForElement(this.ACTION_BAR_SELECTORS.join(', '), { timeout: 3000 });
      }
      this._hostBar = hostBar;

      const downloadButton = this._buildDownloadButton();
      const settingsButton = this._buildSettingsButton();
      this._downloadButton = downloadButton;
      this._settingsButton = settingsButton;

      if (hostBar) {
        hostBar.append(downloadButton, settingsButton);
        Logger.debug('Mounted controls into native action bar.');
      } else if (Config.STATIC.enableFloatingFallback) {
        const group = document.createElement('div');
        group.className = 'wod-floating-group';
        group.append(downloadButton, settingsButton);
        document.body.appendChild(group);
        this._floatingGroup = group;
        Logger.debug('Native action bar not found; using floating fallback controls.');
      } else {
        Logger.warn('Native action bar not found and floating fallback is disabled; UI not mounted.');
        this._downloadButton = null;
        this._settingsButton = null;
      }
    },

    unmount() {
      if (this._floatingGroup && this._floatingGroup.isConnected) {
        this._floatingGroup.remove();
      }
      this._floatingGroup = null;
      if (this._downloadButton && this._downloadButton.isConnected) this._downloadButton.remove();
      if (this._settingsButton && this._settingsButton.isConnected) this._settingsButton.remove();
      this._downloadButton = null;
      this._settingsButton = null;
    },

    _buildDownloadButton() {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'wod-btn';
      button.title = 'Download original wallpaper (D)';
      button.setAttribute('aria-label', 'Download original wallpaper');

      const ring = document.createElement('span');
      ring.className = 'wod-btn__ring';
      button.appendChild(ring);

      const iconSpan = document.createElement('span');
      iconSpan.className = 'wod-btn__icon';
      iconSpan.innerHTML = Icons.download;
      button.appendChild(iconSpan);

      const label = document.createElement('span');
      label.className = 'wod-btn__label';
      label.textContent = 'Original';
      button.appendChild(label);

      button.addEventListener('click', () => {
        void App.handleDownloadRequest({ saveAs: Settings.get('saveAs') });
      });

      return button;
    },

    _buildSettingsButton() {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'wod-btn';
      button.title = 'Downloader settings';
      button.setAttribute('aria-label', 'Open downloader settings');

      const iconSpan = document.createElement('span');
      iconSpan.className = 'wod-btn__icon';
      iconSpan.innerHTML = Icons.gear;
      button.appendChild(iconSpan);

      button.addEventListener('click', () => SettingsUI.open());
      return button;
    },

    setState(state) {
      const button = this._downloadButton;
      if (!button) return;

      button.classList.remove('wod-btn--disabled', 'wod-btn--success', 'wod-btn--error', 'wod-btn--loading');
      const icon = button.querySelector('.wod-btn__icon');

      switch (state) {
        case 'loading':
          button.classList.add('wod-btn--disabled', 'wod-btn--loading');
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

    /** @param {number} fraction 0..1 */
    setProgress(fraction) {
      const button = this._downloadButton;
      if (!button) return;
      const clamped = Math.max(0, Math.min(1, fraction));
      button.style.setProperty('--wod-progress', String(clamped));
    },
  };

  /* ==========================================================================
   * SETTINGS UI
   * A small in-page modal (no page reload) for editing every persisted
   * setting, plus a "clear history" action.
   * ======================================================================== */
  const SettingsUI = {
    _overlay: null,
    _escHandler: null,

    open() {
      if (this._overlay) return;

      const overlay = document.createElement('div');
      overlay.className = 'wod-modal-overlay';

      const modal = document.createElement('div');
      modal.className = 'wod-modal';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-label', 'Wallhaven downloader settings');

      modal.innerHTML = `
        <div class="wod-modal__header">
          <h2>Downloader Settings</h2>
          <button type="button" class="wod-modal__close" aria-label="Close">&times;</button>
        </div>
        <div class="wod-modal__body">
          <label class="wod-field">
            <span>Filename template</span>
            <input type="text" name="filenameTemplate" />
          </label>
          <p class="wod-field__hint">
            Tokens: {id} {resolution} {width} {height} {ratio} {category} {ext} {extension}
            {size} {filesize} {views} {favorites} {purity} {uploader} {colors} {date}
          </p>
          <label class="wod-field wod-field--checkbox">
            <input type="checkbox" name="saveAs" />
            <span>Show "Save As" dialog on download</span>
          </label>
          <label class="wod-field wod-field--checkbox">
            <input type="checkbox" name="removeWallhavenPrefix" />
            <span>Remove "wallhaven-" prefix</span>
          </label>
          <label class="wod-field wod-field--checkbox">
            <input type="checkbox" name="showNotifications" />
            <span>Show toast notifications</span>
          </label>
          <label class="wod-field wod-field--checkbox">
            <input type="checkbox" name="keyboardShortcuts" />
            <span>Enable keyboard shortcuts (D / Ctrl+D / Shift+D / Alt+D)</span>
          </label>
          <label class="wod-field wod-field--checkbox">
            <input type="checkbox" name="enableContextMenu" />
            <span>Enable right-click context menu</span>
          </label>
          <label class="wod-field wod-field--checkbox">
            <input type="checkbox" name="preventDuplicates" />
            <span>Warn before re-downloading the same wallpaper</span>
          </label>
          <label class="wod-field">
            <span>Retry attempts on failure</span>
            <input type="number" name="retryCount" min="1" max="10" />
          </label>
          <label class="wod-field">
            <span>Wallhaven API key (optional, needed for NSFW metadata)</span>
            <input type="password" name="apiKey" autocomplete="off" />
          </label>
        </div>
        <div class="wod-modal__footer">
          <button type="button" class="wod-btn" data-action="clear-history">Clear history</button>
          <button type="button" class="wod-btn" data-action="reset">Reset defaults</button>
          <button type="button" class="wod-btn wod-btn--primary" data-action="save">Save</button>
        </div>
      `;

      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      this._overlay = overlay;

      this._populate(modal);
      this._bind(modal, overlay);
    },

    _populate(modal) {
      modal.querySelector('[name="filenameTemplate"]').value = Settings.get('filenameTemplate');
      modal.querySelector('[name="saveAs"]').checked = Settings.get('saveAs');
      modal.querySelector('[name="removeWallhavenPrefix"]').checked = Settings.get('removeWallhavenPrefix');
      modal.querySelector('[name="showNotifications"]').checked = Settings.get('showNotifications');
      modal.querySelector('[name="keyboardShortcuts"]').checked = Settings.get('keyboardShortcuts');
      modal.querySelector('[name="enableContextMenu"]').checked = Settings.get('enableContextMenu');
      modal.querySelector('[name="preventDuplicates"]').checked = Settings.get('preventDuplicates');
      modal.querySelector('[name="retryCount"]').value = Settings.get('retryCount');
      modal.querySelector('[name="apiKey"]').value = Settings.get('apiKey');
    },

    _bind(modal, overlay) {
      const close = () => this.close();

      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) close();
      });
      modal.querySelector('.wod-modal__close').addEventListener('click', close);

      this._escHandler = (event) => {
        if (event.key === 'Escape') close();
      };
      document.addEventListener('keydown', this._escHandler);

      modal.querySelector('[data-action="save"]').addEventListener('click', async () => {
        await Settings.set('filenameTemplate', modal.querySelector('[name="filenameTemplate"]').value.trim() || '{id}');
        await Settings.set('saveAs', modal.querySelector('[name="saveAs"]').checked);
        await Settings.set('removeWallhavenPrefix', modal.querySelector('[name="removeWallhavenPrefix"]').checked);
        await Settings.set('showNotifications', modal.querySelector('[name="showNotifications"]').checked);
        await Settings.set('keyboardShortcuts', modal.querySelector('[name="keyboardShortcuts"]').checked);
        await Settings.set('enableContextMenu', modal.querySelector('[name="enableContextMenu"]').checked);
        await Settings.set('preventDuplicates', modal.querySelector('[name="preventDuplicates"]').checked);

        const retryValue = parseInt(modal.querySelector('[name="retryCount"]').value, 10);
        await Settings.set('retryCount', Number.isFinite(retryValue) && retryValue > 0 ? retryValue : 3);
        await Settings.set('apiKey', modal.querySelector('[name="apiKey"]').value.trim());

        Notifications.success('Settings saved.');
        close();
      });

      modal.querySelector('[data-action="reset"]').addEventListener('click', async () => {
        await Settings.resetAll();
        this._populate(modal);
        Notifications.info('Settings reset to defaults.');
      });

      modal.querySelector('[data-action="clear-history"]').addEventListener('click', async () => {
        await Downloader.clearHistory();
        Notifications.info('Download history cleared.');
      });
    },

    close() {
      if (this._overlay) {
        this._overlay.remove();
        this._overlay = null;
      }
      if (this._escHandler) {
        document.removeEventListener('keydown', this._escHandler);
        this._escHandler = null;
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
      if (!imageEl) return;
      imageEl.addEventListener('contextmenu', (event) => this._onContextMenu(event));
    },

    _onContextMenu(event) {
      if (!Settings.get('enableContextMenu')) return;
      event.preventDefault();
      this._close();

      const items = [
        { label: 'Download Original', action: () => App.handleDownloadRequest({ saveAs: Settings.get('saveAs') }) },
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
   * while the user is typing in a form field. The enabled/disabled state is
   * re-checked on every keystroke against live settings, so toggling the
   * "keyboard shortcuts" setting takes effect immediately without needing to
   * re-attach the listener.
   * ======================================================================== */
  const Keyboard = {
    _handler: null,

    attach() {
      if (this._handler) return;
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
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
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
      if (!Settings.get('keyboardShortcuts')) return;
      if (this._isTypingContext(event)) return;

      const { shortcuts } = Config.STATIC;

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
        void App.handleDownloadRequest({ saveAs: Settings.get('saveAs') });
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

      const debouncedCheck = Utils.debounce(() => this._checkForContentChange(), Config.STATIC.domObserverDebounce);
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
      const currentId =
        Utils.extractId(location.href) || Utils.extractId(document.querySelector('img#wallpaper')?.src || '');
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
      await Settings.init();
      await Downloader.loadHistory();
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
      GMC.registerMenuCommand('Download original wallpaper', () => {
        void this.handleDownloadRequest({ saveAs: Settings.get('saveAs') });
      });
      GMC.registerMenuCommand('Copy original image URL', () => void this.copyImageUrl());
      GMC.registerMenuCommand('Copy filename', () => void this.copyFilename());
      GMC.registerMenuCommand('Downloader settings…', () => SettingsUI.open());
      GMC.registerMenuCommand('Clear download history', () => {
        void Downloader.clearHistory().then(() => Notifications.info('Download history cleared.'));
      });
    },

    /**
     * @param {{saveAs?: boolean, force?: boolean}} [options]
     */
    async handleDownloadRequest(options = {}) {
      UI.setState('loading');
      UI.setProgress(0);

      const progressToast = Config.STATIC.showProgress
        ? Notifications.show('Downloading… 0%', 'info', { duration: 0 })
        : undefined;

      const onProgress = (fraction) => {
        UI.setProgress(fraction);
        if (progressToast) progressToast.setText(`Downloading… ${Math.round(fraction * 100)}%`);
      };

      let data;
      try {
        data = await WallpaperData.resolve();
      } catch (err) {
        Logger.error('Failed to resolve wallpaper metadata', err);
        data = null;
      }

      if (!data) {
        if (progressToast) progressToast.dismiss();
        UI.setState('error');
        Notifications.error('Could not find the original wallpaper image on this page.');
        return;
      }

      try {
        const result = await DownloadQueue.enqueue(data, { ...options, onProgress });
        if (progressToast) progressToast.dismiss();
        UI.setState('success');
        Notifications.success(`Saved as ${result.filename}`);
      } catch (err) {
        if (progressToast) progressToast.dismiss();

        if (err && err.code === 'DUPLICATE') {
          UI.setState('idle');
          Notifications.warning('Already downloaded this wallpaper this session.', {
            actionLabel: 'Download again',
            onAction: () => void this.handleDownloadRequest({ ...options, force: true }),
          });
          return;
        }

        if (err && err.code === 'ALREADY_QUEUED') {
          UI.setState('idle');
          Notifications.info(ERROR_MESSAGES.ALREADY_QUEUED);
          return;
        }

        Logger.error('Download failed', err);
        UI.setState('error');
        const message = (err && ERROR_MESSAGES[err.code]) || (err && err.message) || 'Download failed.';
        Notifications.error(message, {
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
      GMC.openInTab(data.url, { active: true, insert: true, setParent: true });
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
      const data = await WallpaperData.resolve();
      let tags = data && Array.isArray(data.tags) ? data.tags : null;

      if (!tags) {
        const tagEls = document.querySelectorAll('#tags a, .tag-list a, a.tag');
        tags = Array.from(tagEls)
          .map((el) => el.textContent.trim())
          .filter(Boolean);
      }

      if (!tags || tags.length === 0) {
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
