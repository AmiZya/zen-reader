<p align="center">
  <img src="build/appicon.png" width="128" alt="Zen Reader icon" />
</p>

<h1 align="center">Zen Reader</h1>

<p align="center">
  A quiet, offline EPUB reader with a classic CHM-style layout: a table of contents on the left and one chapter at a time on the right.
</p>

---

## Why Zen Reader?

Most EPUB readers either paginate everything or show the whole book as one endless scroll. Zen Reader does something simpler, the way old Windows help files (`.chm`) did:

- **Contents tree on the left.** Click a chapter to open it.
- **One chapter at a time on the right.** You scroll within that chapter only. The app never joins the whole book into one page.
- **Local only.** No accounts, no cloud, no tracking.

## Features

- 📚 **CHM-style split view** with a resizable contents tree. The current chapter is highlighted and its branch expands automatically.
- 📖 **Chapter-only rendering**: each chapter opens on its own and scrolls on its own.
- 🔎 **In-chapter search** with highlighted matches and next/previous navigation (`⌘F`).
- 🎨 **Reader settings**: font size, line height, margins, and Paper / Sepia / Night themes.
- 🔴 **Classic red links**, with darker visited links, just like CHM.
- 💾 **Session restore**: reopens the last book where you left off (saved by CFI, with the chapter as a fallback).
- 🧩 **Handles messy EPUBs**: fallback TOC built from the spine, flexible path matching between TOC links and chapter files, and image loading straight from the EPUB archive.
- 🖥️ **Native desktop app** built with [Wails](https://wails.io) (Go + React). It's small and fast, and doesn't use Electron.

## Download

Get the latest build from the [**Releases**](../../releases) page:

| Platform | File |
| --- | --- |
| macOS (Apple Silicon + Intel) | `ZenReader-<version>-macos-universal.zip` |
| Windows (x64) | `ZenReader-<version>-windows-amd64.zip` |
| Linux (x64) | `ZenReader-<version>-linux-amd64.tar.gz` |

Each release also includes a `SHA256SUMS.txt` file so you can verify your download.

### macOS: first launch

The builds aren't notarized yet, so Gatekeeper may say the app "is damaged" or "can't be opened". After unzipping, run:

```bash
xattr -cr "/Applications/Zen Reader.app"
```

Or right-click the app, choose **Open**, then click **Open** again.

### Linux requirements

You need GTK 3 and WebKitGTK 4.1:

```bash
# Debian / Ubuntu
sudo apt install libgtk-3-0 libwebkit2gtk-4.1-0
```

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘F` / `Ctrl+F` | Focus chapter search |
| `Enter` (in search) | Run search |
| `⌥←` / `Alt+←` | Previous chapter |
| `⌥→` / `Alt+→` | Next chapter |
| `Esc` | Close reader settings |

## Building from source

### Prerequisites

- [Go](https://go.dev/dl/) 1.23+
- [Node.js](https://nodejs.org/) 20+
- Wails CLI v2.12:
  ```bash
  go install github.com/wailsapp/wails/v2/cmd/wails@v2.12.0
  ```
- Platform dependencies: see `wails doctor` and the [Wails installation guide](https://wails.io/docs/gettingstarted/installation).

### Develop

```bash
wails dev
```

This starts the app with hot reload for the React frontend.

### Build

```bash
# macOS (universal binary)
wails build -platform darwin/universal

# Windows
wails build -platform windows/amd64

# Linux (Ubuntu 24.04+ / WebKitGTK 4.1)
wails build -platform linux/amd64 -tags webkit2_41
```

The output goes to `build/bin/`. On macOS, a post-build hook renames the bundle to `Zen Reader.app`.

> **Tip:** if you see a Go toolchain mismatch such as `compile: version "go1.22.x" does not match go tool version ...`, your shell is exporting a stale `GOROOT`. Run the command with `env -u GOROOT wails build`.

## Releasing

Releases are automated with GitHub Actions (`.github/workflows/release.yml`):

1. Bump `info.productVersion` in `wails.json`.
2. Tag and push:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
3. The workflow builds macOS (universal), Windows, and Linux, packages the binaries, generates checksums, and publishes a GitHub Release with auto-generated notes.

Tags with a hyphen (for example `v0.2.0-beta.1`) are published as pre-releases. You can also start the workflow by hand from the **Actions** tab, with or without a release tag.

## Project structure

```
.
├── main.go                 # Wails bootstrap, asset handler, macOS About panel
├── app.go                  # Go API: file dialog, EPUB serving, session persistence
├── wails.json              # Project & packaging metadata
├── build/                  # Icons, Info.plist templates, Windows manifests
├── frontend/
│   └── src/
│       ├── App.tsx         # Reader: epub.js lifecycle, TOC, search, settings
│       └── App.css         # CHM-style UI
└── .github/workflows/
    └── release.yml         # CI build & release
```

### How it works

- **Backend (Go).** The EPUB file is never sent over the JS bridge. The backend registers the file under a random token and streams it through the Wails asset handler at `/__epub/<token>.epub`. That keeps large books fast to open.
- **Frontend (React + [epub.js](https://github.com/futurepress/epub.js)).** Rendering uses `method: "default"` and `flow: "scrolled-doc"`, so exactly one spine section is shown at a time.
- **Session.** The session is stored as JSON in your user config directory (`~/Library/Application Support/zen-reader/session.json` on macOS). It's written atomically (temp file + rename) and debounced.

## Known limitations

- Single-book mode only. There's no library manager yet.
- Scripts embedded in books are stripped before rendering, for safety.
- The macOS builds aren't signed or notarized.

## Roadmap

- [ ] Option to respect the book's own colors instead of normalizing them
- [ ] Library view and recent books
- [ ] Signed and notarized macOS builds

## Credits

Developed by **Amine Zyad**.

Built with [Wails](https://wails.io), [React](https://react.dev), and [epub.js](https://github.com/futurepress/epub.js).
