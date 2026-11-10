# Zen Reader - Agent Playbook

This document is the implementation contract for coding agents working on this repository.

## Product Goal

Build a desktop EPUB reader with a classic CHM-style layout:

- Left pane: TOC tree
- Right pane: chapter content
- Fast chapter navigation
- Local-only data

## Locked Decisions

- App framework: Wails v2
- Frontend: React + TypeScript
- Persistence: JSON (no DB for MVP)
- Release target: macOS first
- Scope: single-book mode (no library manager yet)

## Critical Reading Behavior (Do Not Break)

1. TOC click loads only the selected chapter/section.
2. Continuous scroll is allowed only inside the currently displayed chapter.
3. Never concatenate the full book into one long scrolling document.

For epub.js, enforce:

- `method: "default"`
- `flow: "scrolled-doc"`

Do not use continuous manager for MVP.

## Architecture

### Go (Wails backend)

- Open native file dialog for `.epub`
- Read EPUB bytes for frontend consumption
- Session file I/O (load/save/clear)
- Keep methods small and bind via Wails `Bind`

### React (frontend)

- CHM-style split layout
- TOC tree rendering and selection
- epub.js lifecycle (book/rendition setup, teardown)
- Chapter navigation (TOC + prev/next)
- Location capture + restore
- In-chapter search

## Session Model (JSON)

Store in app support directory as `session.json`.

Recommended fields:

```json
{
  "bookPath": "",
  "bookHash": "",
  "chapterHref": "",
  "cfi": "",
  "updatedAt": ""
}
```

Rules:

- Prefer restoring by `cfi`
- Fallback restore by `chapterHref`
- Debounce writes (recommended 600ms)
- Write atomically (temp file then rename)

## Initial File/Module Targets

- `main.go` - app bootstrap and Wails options
- `app.go` - bound methods and runtime-facing API
- `frontend/src/layout/` - split view + panes
- `frontend/src/reader/` - epub.js orchestration
- `frontend/src/state/` - UI/session state
- `frontend/src/types/` - TOC/session types

## Milestones

1. Scaffold Wails app (`react-ts`) and boot successfully.
2. Implement split UI shell and top controls.
3. Open EPUB and render selected chapter only.
4. TOC navigation + prev/next + shortcuts.
5. Persist and restore session (CFI first).
6. In-chapter search and error handling polish.

## Definition of Done

- TOC click replaces reader content with selected section only.
- No auto-loading of next spine section while scrolling.
- Restart restores prior location for last opened book.
- Invalid EPUB surfaces clear error without crash.
- Keyboard and toolbar chapter navigation both work.

## Safety and UX Notes

- `allowScriptedContent` is `true` because WebKit blocks our click handlers in a script-less sandbox; book scripts and inline `on*` handlers are stripped by `sanitizeChapterDocument` (spine content hook). Never remove that sanitizer.
- Normalize TOC hrefs and fragment targets before display.
- Handle both EPUB2 (NCX) and EPUB3 nav through epub.js APIs.
- Keep UI responsive on large chapters.

## Non-Goals (MVP)

- Multi-book library manager
- Cloud sync
- Book annotations database
- Cross-platform packaging polish (Windows/Linux later)
