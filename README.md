# WallFetch

[![Greasy Fork](https://img.shields.io/greasyfork/v/587780)](https://greasyfork.org/en/scripts/587780-wallfetch)
[![Greasy Fork Downloads](https://img.shields.io/greasyfork/dt/587780)](https://greasyfork.org/en/scripts/587780-wallfetch)
[![License](https://img.shields.io/github/license/itachi-re/wallfetch)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/itachi-re/wallfetch)](https://github.com/itachi-re/wallfetch)
[![GitHub Issues](https://img.shields.io/github/issues/itachi-re/wallfetch)](https://github.com/itachi-re/wallfetch/issues)
[![Last Commit](https://img.shields.io/github/last-commit/itachi-re/wallfetch)](https://github.com/itachi-re/wallfetch/commits/main)

A userscript that adds one-click original-resolution downloads to Wallhaven.

Wallhaven's own download button gives you the resized preview. WallFetch grabs the original file instead, names it something sane, and gets out of your way.

---

## Features

- **Original-resolution downloads** — pulls the source image, not the compressed preview, with the correct file extension
- **Custom filename templates** — build filenames out of wallpaper ID, resolution, category, purity, and more
- **Wallhaven API integration** — pulls accurate metadata for naming and info display instead of scraping the page
- **Persistent settings** — your preferences survive across sessions, stored locally
- **Duplicate detection** — skips re-downloading wallpapers you already have
- **Error handling** — retries failed downloads instead of just giving up

Planned, not yet built — see [Roadmap](#roadmap).

---

## Installation

You'll need a userscript manager:

- [ScriptCat](https://scriptcat.org/) (primary)
- [Violentmonkey](https://violentmonkey.github.io/)
- [Tampermonkey](https://www.tampermonkey.net/)
- Greasemonkey / FireMonkey also work

Then install the script from either source:

**Greasy Fork (recommended)** — handles update checks automatically:

```
https://greasyfork.org/en/scripts/587780-wallfetch
```

**Raw GitHub** — always the latest commit, no update checks:

```
https://raw.githubusercontent.com/itachi-re/wallfetch/main/wallfetch.user.js
```

Your userscript manager should pick either link up automatically and prompt you to install.

Works on any Chromium-based browser and Firefox, plus derivatives (Brave, Vivaldi, LibreWolf, Zen, etc.) — anywhere your userscript manager runs.

---

## Usage

Go to [wallhaven.cc](https://wallhaven.cc). A download button shows up on wallpaper pages. Click it, get the original file.

---

## Filename Templates

Set a template in the settings panel to control how downloaded files are named.

| Variable | Description |
|---|---|
| `{id}` | Wallpaper ID |
| `{resolution}` | Full resolution, e.g. `1920x1080` |
| `{width}` | Image width |
| `{height}` | Image height |
| `{category}` | Category (general / anime / people) |
| `{purity}` | Purity (sfw / sketchy / nsfw) |
| `{favorites}` | Favorite count |
| `{views}` | View count |
| `{uploader}` | Uploader's username |
| `{date}` | Upload date |
| `{ext}` | File extension |

Examples:

```
{id}
{id}_{resolution}
{id}_{category}_{purity}
```

---

## Compatibility

Tested with:

- **ScriptCat** (primary)
- **Violentmonkey**
- **Tampermonkey**

Works reliably across all three — standard GM API usage throughout, no manager-specific hacks.

---

## Privacy

WallFetch doesn't collect, transmit, or sell any personal data. All settings and configuration are stored locally within your userscript manager — nothing leaves your browser.

---

## Roadmap

- [ ] Download queue with progress tracking
- [ ] Download history
- [ ] Batch downloads
- [ ] Favorites / collection downloader
- [ ] Search-page bulk downloads
- [ ] Settings import/export
- [ ] Keyboard shortcuts

---

## Contributing

Fork it, branch off, make your change, open a PR. Keep it simple.

If you're filing a bug, include your browser, userscript manager, script version, and steps to reproduce. [Open an issue](https://github.com/itachi-re/wallfetch/issues) on GitHub.

---

## License

MIT — see [LICENSE](LICENSE).

## Disclaimer

WallFetch isn't affiliated with or endorsed by Wallhaven. Respect their Terms of Service and the licensing terms of individual wallpapers.
