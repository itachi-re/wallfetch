# Changelog

All notable changes to WallFetch are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/).

---

## [1.5.1] - 2026-07-20

### Changed
- Switched update/download URLs to Greasy Fork (`update.greasyfork.org`) instead of the raw GitHub `dist/` path, so installs now get proper auto-update checks

---

## [1.5.0] - 2026-07-20

### Added
- **Download queue** — wallpapers can be enqueued instead of downloading one at a time; the queue rejects a wallpaper that's already pending instead of double-downloading it
- **Persistent download history** — the last 300 downloads are saved via `GM_setValue`/`GM_getValue` and survive across sessions, not just the current tab
- **Settings panel** — a proper in-page modal for configuring filename templates, retry count, and notification preferences, replacing hand-edited config values
- **Classified error handling** — errors are now categorized (e.g. rate-limited, permanent failure, already-queued) instead of surfacing as generic failures
- **Retry with backoff** — failed downloads retry automatically with a linear backoff delay, up to a configurable attempt count

### Changed
- Internal error messages centralized into a single `ERROR_MESSAGES` table for consistency across the UI and console logging

---

## [1.0.0] - 2026-07-20

### Added
- Initial release: one-click original-resolution wallpaper downloads on Wallhaven
- In-page toast notifications for download success/failure
- Right-click / userscript menu commands: download original, copy image URL, copy filename
- Session-level duplicate-download detection via a patched History API listener
- MIT License

---

[1.5.1]: https://github.com/itachi-re/wallfetch/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/itachi-re/wallfetch/compare/v1.0.0...v1.5.0
[1.0.0]: https://github.com/itachi-re/wallfetch/releases/tag/v1.0.0
