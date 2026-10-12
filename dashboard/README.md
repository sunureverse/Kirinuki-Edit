# Dashboard - developer notes

A static web app plus a small Python server (`server.py`) for managing edits. No build step, no npm.
**It never calls a model API.** It uploads source media, writes job files and prompts, and shows a request the user can paste into a Codex chat with access to the same checkout. See [Codex editing](../docs/codex-editing.md).

The user guide (Korean, every screen and shortcut) is [docs/대시보드_가이드.md](../docs/대시보드_가이드.md).
This file covers the code: files, server API, data model and the rules that keep the browser and the
episode folders in sync.

## Running

```bash
python dashboard/server.py --port 8899 --open
```

| Flag | Default | Meaning |
|---|---|---|
| `--port` | 8899 | HTTP port |
| `--projects` | `projects/` | project store, one folder per project |
| `--jobs` | `jobs/` | where AI jobs are written |
| `--open` | off | open a browser tab |
| `--keep-alive` | off | do not exit when the last page closes |

The server lives as long as a page is open: pages ping every 3 s and send a goodbye on close. With no
page left it exits (about 2 s after a tab closes, about 14 s if the browser dies). It reattaches on its
own if it starts after the page. Opened as plain static files (`python -m http.server`), the dashboard
still works, but projects live in localStorage and jobs go to the clipboard.

## Files

```
dashboard/
  index.html            icon sprite + layout of both tabs and the project manager
  server.py             HTTP server: files, media, projects, styles, jobs, render
  css/base.css          tokens (neutral grey, --on = orange), panels, buttons, drop zones, modal
  css/ai.css            AI edit tab
  css/feedback.css      viewer, notes, caption lists (shared by both tabs)
  css/useredit.css      user edit tab (timeline, inspector, effects, render pane)
  css/projects.css      project chip, menu, manager cards
  css/editor.css        old editor layout (still loaded; shared bits only)
  js/core.js            state, time / file helpers, toasts, modal (onCancel), save / load
  js/server.js          server detection, ping, job hand-off
  js/split.js           panel gutters (drag = resize, double-click = default)
  js/dnd.js             drag and drop of files / folders, drop zones (same file dropped again replaces)
  js/csv.js             caption CSV parse / write
  js/fonts.js           installed fonts and libass size factors
  js/ai.js              AI edit tab: style analyse / apply, languages, aspect, job JSON + prompt
  js/feedback.js        viewer: preview player, notes, unbaked plan (planScene), caption data
  js/useredit.js        user edit tab: timeline, inspector, sources / effects, words, render pane
  js/projects.js        projects: create, open, save, autosave, manager
  js/app.js             boot, tabs, shortcuts, disk freshness check
  js/vendor/shortsmith-preview.js   bundled React preview (built from shortsmith/preview)
  styles/               analysed style JSON (shared by all projects)
  _legacy/              old editor (timeline.js, inspector.js, editor.js) - not loaded
```

Rebuild the preview bundle after editing `shortsmith/src` or `shortsmith/preview`:

```bash
cd shortsmith
NODE_PATH=<main checkout>/shortsmith/node_modules node <main checkout>/shortsmith/node_modules/esbuild/bin/esbuild preview/entry.tsx --bundle --minify --format=iife --global-name=ShortsmithPreview --outfile=dist/preview.js '--define:process.env.NODE_ENV="production"'
cp dist/preview.js ../dashboard/js/vendor/shortsmith-preview.js
```

## Server API

GET

| Path | Returns |
|---|---|
| `/api/status` | server info (clients, jobs dir, projects dir) |
| `/api/projects` | project list (from `meta.json`) |
| `/api/project?id=` | one `project.json` |
| `/api/project/thumb?id=` | card thumbnail |
| `/api/styles` | `styles/*.json` |
| `/api/file?path=` | a local file (range requests, used for video) |
| `/api/media/browse` · `/list` | folder browsing for the source pane |
| `/api/media/thumbs` · `/wave` · `/poster` · `/info` `?path=` | thumbnail grid, waveform, poster, probe (cached in `%TEMP%/kirinuki_media`) |
| `/api/fonts` | installed font names |
| `/api/dirs` | folder picker for render settings |
| `/api/render/status?id=` | render progress and log |
| `/api/translations` | existing translation CSVs (legacy pipeline) |

POST

| Path | Does |
|---|---|
| `/api/ping` · `/api/bye` | page lifetime |
| `/api/project/save` | save a project (review is merged - see below) |
| `/api/project/delete` | move to `projects/_trash` |
| `/api/style/save` · `/api/style/delete` | style files |
| `/api/media/upload?project=&name=` | file dropped from Explorer -> `projects/<id>/media/` (same name and size = reuse) |
| `/api/job` | write `jobs/<time>_<kind>_<unique>.json` and `.md`, return a Codex handoff request; requires a saved project |
| `/api/render` | start a render |

## Projects

```
projects/<id>/project.json   full dashboard state
projects/<id>/meta.json      summary for the list
projects/<id>/thumb.jpg      card thumbnail
projects/<id>/media/         files dropped from Explorer
projects/_trash/             deleted projects
```

Ctrl+S saves. Any change marks the project dirty and autosaves after 20 s of quiet.
On page load `app.js` (`freshenFromDisk`) compares the folder's `savedAt` with the browser's copy. If the
folder is newer (Codex exported a new edit), the project is read from disk. If they are equal, `diskAt` is still set. Skipping that
made every later save think the folder was newer, so autosave silently stopped after a page reload.

**`save_project` merges `review` key by key.** Pipeline output (`kept`, `transcript`, `captions`,
`video`, `scene`, `clips`) is owned by the files: a stale tab would otherwise roll the project back.
Only user keys are taken from the browser:

`prompt notes drop restore ripple restoreCaps userClips srcFolders userLayers userGroups userCaps capTracks srcFiles`

plus per-word drop / restore flags and caption edits (matched by original text and speaker, not by start
time - matching by time let one label edit overwrite a neighbouring caption).
**A new review key must be added to that list,** then checked in `project.json` after a save.

## Review data (user edit tab)

| Key | Shape | Meaning |
|---|---|---|
| `userClips` | `[{s, e, at, vol, color, tin, tf, g, vhide, ahide, fx}]` | V1 / A1 clips: source range placed at timeline time `at` |
| `userLayers` | `[{id, kind, path, track, at, s, e, box, opacity, vol, fin, fout, color, keys, ease, tin, crop, w0, h0, link}]` | V2.. / A2.. clips |
| `userGroups` | `{g: name}` | clip groups |
| `userCaps` | `[{id, at, d, text, speaker, kind, tf}]` | captions added in the tab (output time) |
| `capTracks` | `{caption text or 'uc'+id: track}` | caption track on the video side |
| `srcFolders` · `srcFiles` | paths | source pane folders and imported files |
| `source` · `srcSize` | path, `{w, h}` | original video (written by `export_shortsmith.py`) |

`project.render.opts` holds render settings (`codec soft q size fps abr lufs`). `project.ai.aspect` is the
aspect picked in style apply.

Timeline rules worth knowing before editing `useredit.js`:

- **Ripple** shifts only what follows the edit and keeps every other gap (`gapsOf` / `pack(G)`).
  Layers and `userCaps` move with it (`shiftRest`). Undo stores the state from before the drag.
- Moving a V1 clip up turns it into a source layer (`toLayer`). With link on, V1 and A1 keep a gap.
  With link off, only the picture moves (`vhide`). The reverse is `toMain`. `toAudio` moves only the
  sound (`ahide`).
- While dragging, `draw()` skips the inspector and the words pane; the ruler and waveforms are reused,
  and mouse moves are coalesced to one per frame (`onMoveQ`).

## Preview and render must agree

- **Unbaked preview:** `feedback.js planScene()` builds the plan from `userClips` (or word drop / restore)
  and plays the source copy (`src_preview.mp4`). `tools/apply_review.py` computes the same keep ranges
  and caption times. Change one, change the other.
- Captions keep their source anchor. Source layers (a V1 clip moved up) count as kept ranges for
  captions only (`PC` in both files).
- Window effects live in `shortsmith/lib/render.mjs` and `src/parts/Window.tsx`. Transitions are listed
  once in `shortsmith/lib/trans.mjs`. Colour maths is `shortsmith/lib/color.mjs`.

## Render button

`/api/render` on a shortsmith episode (`edit.json`) runs, with no AI:

1. `tools/apply_review.py <episode> <project.json>` - dashboard cuts, captions, effects, layers and
   render options into the episode folder (`.bak` copies kept)
2. `shortsmith cuts` if `edit.json` changed, then `shortsmith build`
3. `tools/export_shortsmith.py <episode> <id> --keep-feedback` - write the result back to the project

Episodes that predate shortsmith still go through the legacy steps (`import_project.py`,
`build_edit.py`, `apply_captions*.py`) in `render_job`.

## AI jobs

The AI edit tab writes uniquely named JSON and Markdown files in `jobs/`. The job carries the
instruction text, notes (with source time and position), subtitle languages, aspect, assets and the AI
policy. Notes drawn before the first edit are on the dropped source file, so their time is source time.
The handoff includes `agent: codex`, a saved `project` ID, `projectFile`, and `mediaPaths` mappings from browser-relative names to uploaded absolute paths. The UI saves the project before submission and uploads the task's input/asset groups sequentially. Saved metadata is not an automatic agent invocation; the user must send the displayed request to Codex. Browser-only mode embeds job JSON in the request and asks the user to attach media separately.

## Fonts

`/api/fonts` reads font name tables. The page keeps only names the browser resolves, because a wrong
name silently falls back to a default font in the browser while libass still finds it. Sizes are scaled
by `upem / (winAscent + winDescent)` per font, since libass sizes by font height and CSS by em.
