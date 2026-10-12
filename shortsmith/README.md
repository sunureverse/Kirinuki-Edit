# shortsmith

Turn a long recording into a vertical short: waveform-accurate cuts, preset-driven captions and motion graphics
drawn in React, GPU-encoded with ffmpeg. Built for streamer/VTuber highlight shorts, usable for any talking video.

- **ffmpeg** cuts, crops, applies window effects (zoom, push, shake, mono), composites and encodes
  (NVENC / Quick Sync / AMF / VideoToolbox, falling back to libx264).
- **React (Remotion)** draws only a transparent overlay: captions, title, images, chat cards and their animation.
  Identical overlay frames are captured once.
- **Cache everywhere**: pieces, overlay frames and 2-second output chunks. Editing one caption re-renders one chunk
  (about 10 s for a 30 s short on a laptop GPU).
- **Presets are JSON.** One file describes the whole look - layered outlines and shadows, gradients, per-word accents,
  speaker-to-style rules, inserts - and per video you only write `fx.json`. Existing ASS looks port 1:1.
- **Editing workflow** included (`skills/edit-short`) for the judgment parts: what to keep, caption text, where effects go.

## Requirements

- Node.js 18 or newer
- ffmpeg and ffprobe on `PATH`
- Chrome Headless Shell is downloaded by Remotion on first render (~110 MB)
- The fonts your preset names (`shortsmith doctor` lists missing ones with download links)

## Install

```bash
npm install -g shortsmith        # or: git clone ... && npm install && npm link
shortsmith doctor
```

For Codex editing, follow [`../AGENTS.md`](../AGENTS.md) and [the Codex guide](../docs/codex-editing.md).

## Quick start

```bash
shortsmith init my-short --source stream.mp4 --preset basic-shorts
# edit my-short/edit.json: crop, keep ranges (source seconds)
# write my-short/captions.csv (start,end,speaker,text) and my-short/fx.json
shortsmith build my-short
```

Pipeline, one command each: `cuts` -> `body` -> `scene` -> `render` (`build` runs them in order).

| file | written by | what |
|---|---|---|
| `edit.json` | you | source, preset, crop, keep ranges, file names; `layers` = extra video / image / audio clips on their own tracks (output seconds, box, opacity, colour, volume dB, fades; `keys` = box keyframes `{t, x, y, w, h}` in clip seconds, `ease` = smoothstep; `tin` = `{type: 'dissolve' | 'black' | 'white' | 'wipe' | 'slide', d}` from the clip that ends where this one starts on the same track) - composited under the captions and mixed in by `render` |
| `captions.csv` | you | caption rows, output clock by default |
| `fx.json` | you | caption kinds, labels, images, chat cards, zoom/push/shake/mono - placed by caption text |
| `cuts.json` | `cuts` | exact pieces from the waveform |
| `window.mkv`, `bg.mp4`, `body.json` | `body` | cut source at window size, background |
| `scene.json` | `scene` | everything React needs, preset resolved |

## Presets

Lookup order: explicit path, `presets/<id>` in the project folder or any parent, folders in `SHORTSMITH_PRESETS`,
then the bundled presets. Keep channel-specific presets (backgrounds, name plates, character art) in a private
`presets/` folder next to your projects - not in this repository.

A preset has `canvas`, `layout`, optional `brand`, `cut`, `audio`, `pacing`, `fonts`, `captions.kinds`, `title`,
`chat`, `effects` and `guidance`. See [`schema/preset.schema.json`](schema/preset.schema.json) and
[`presets/basic-shorts`](presets/basic-shorts/preset.json). `extends` inherits from another preset.

Caption `size` is the line box height in pixels (ascent + descent, the ASS convention). Font metrics are measured at
runtime; set `lineToEm` and `ascent` to pin them when matching an existing ASS look.

Audio is never filtered. Loudness is reached with one fixed gain (`audio.targetLufs`, capped by `maxTruePeakDb`).

## Dashboard preview

`npm run preview:build` produces `dist/preview.js` (global `ShortsmithPreview`). It plays a `scene.json` in the browser
with the same components the renderer uses, so caption edits show without rendering:

```js
const p = ShortsmithPreview.mount(el, { scene, url: (absPath) => '/file?path=' + encodeURIComponent(absPath) });
p.video.play();            // <video>-like: currentTime, duration, paused, play(), pause(), addEventListener
p.update(changedScene);    // redraw instantly
```

## Licenses

- Remotion is free for individuals and companies of up to 3 people; larger companies need a
  [Remotion company license](https://www.remotion.dev/license).
- Fonts are not bundled. Check each font's license before redistributing files.
- shortsmith is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only).
  If you run a modified version as a network service, you must offer its source to its users.
- Remotion's own license still applies to the Remotion packages this project depends on.
