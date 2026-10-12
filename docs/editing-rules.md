# Working rules for this folder

Video editing for Korean stream clips (shorts and longform from VOD). The work log is the local file `PROGRESS.md` (not published).
**Talk to the user in Korean** (progress, reports, questions). Internal docs (this file, `PROGRESS.md`,
tool READMEs) are in English. User-facing docs (`README.md`, `docs/대시보드_가이드.md`) stay in Korean.

## Transcription: one pass by default, no re-runs

**The first edit always runs one transcription without asking** (user, 2026-09-13: "always transcribe once
by default on the first edit, ask only for extra transcriptions"). Run it with `ALLOW_AI=1`.

**Transcribe at word level** (user, 2026-09-29: "use word-level timestamps from now on"):
`ALLOW_AI=1 python tools/transcribe_words.py <episode>` -> `word_level_words.json`, wired into `edit.json` as `"transcript"`.
Whisper word times swallow pauses and stretch (퍼리 취향: "거" lasted 2.7 s), so they are not used as is: speech runs are
split at short pauses and the characters are spread at an even rate (median gap to caption start 0.96 -> 0.52 s).
**Do not enable VAD** - on a quiet source it dropped soft speech entirely (90 -> 71 words). If a transcript already
exists, run only stage 2 with `--from <json>` (no AI).
For the dashboard: `python tools/export_shortsmith.py <episode> <id> --transcript-only` (leaves caption edits alone).

**After that, never run Whisper again.** If a transcript exists (`word_level_*.json`), use it.
Re-transcription costs the most time and tokens.

If another pass seems necessary, **say why first and ask.** State in one line what you want to check and
whether anything other than transcription could answer it.
`transcribe.py`, `transcribe2.py` and `verify_final.py` are blocked by `ai_budget.py`.
With permission, run them with `ALLOW_AI=1`.

**Questions the level meter answers without transcription:**
when speech starts and ends, whether a cut clipped a word, whether captions match the audio, where the
gaps are and how long. `plan_cuts.py` and `probe.py` do this.


## No filters on audio

**Nothing is applied to audio until the user asks.** That includes denoise (afftdn), high-pass, limiter
and loudnorm. Only **plain gain (`volume=NdB`)** is used to make quiet sources audible.

The final loudness (-16 LUFS) is also set with **one fixed gain**, not loudnorm, because loudnorm
compresses dynamics while it levels. `apply_captions.py` measures with ebur128 and raises by
`min(-16 - I, -1.5 - TP)`.

**Why:** in 마법의 날 (2026-09-07) the 봉누도불참 chain was inherited although the source had changed.
Measured, `afftdn` was cutting 3-6 kHz by 8.4 dB and 6-8 kHz by 11.4 dB **during speech** - where sibilance
and air live. `alimiter` was not catching overs; it squashed and raised the average by 0.7 dB. The user
said the unfiltered version was much better.

**Filters are decided per source, never inherited from a previous project.** If one really seems needed,
measure the per-band dB difference, show an A/B, and ask before applying it.

The band limit on `src_level.wav` for cut detection is the exception - that track is **only for measuring**
and never reaches the final video.

## Re-edit scope - how much to look at again

| Feedback | Look again at | Re-render |
|---|---|---|
| Caption word / translation fix | that line only | only pieces under that caption |
| "This cut is wrong" (spot given) | waveform ±2 s around it | that piece and the next |
| "Too much gap here" (spot given) | waveform of that span | that piece |
| Framing / zoom | that scene | pieces of that scene |
| **Same kind of complaint a second time** | **doubt the method itself; redo everything** | all |
| Style / length / tone for the whole video | everything | all |

The last two rows require a full pass. Even then, **say in one line why everything must be redone and ask
first** (`incremental-rework` memory). "I fixed only a part and the same complaint came back" is the most
common reason.

A full re-analysis is still **not re-transcription.** Re-scanning the whole waveform of a 105 s source takes
0.6 s and no tokens (`plan_cuts.py`). "Look at everything again" means re-scan the waveform, not run Whisper.
What is expensive is **dumping results into the conversation** and **re-rendering**, not the analysis.

## New episodes use the shortsmith CLI (2026-09-17)

`shortsmith/` is the public package (CLI + React render + Claude Code skill). Put `edit.json` in the episode folder:

    node shortsmith/bin/shortsmith.mjs build <episode>     # cuts -> body -> scene -> render
    ... doctor --preset <id> · presets · cuts · body · scene · render · still <dir> <sec> <png> · map

- **Per episode you write only `edit.json` (keep ranges, crop) and `fx.json`.** Never write ffmpeg filter strings,
  ASS or React per episode. If a look is missing, add it to the preset.
- **Presets are English JSON** (proper nouns may stay Korean). Private presets live in `presets/`
  (gitignored); public presets live in `shortsmith/presets/`. The old Korean style files are kept in
  `dashboard/styles/_legacy_ko/`. Measured values get `basis: "measured ..."`, guesses `"guess ..."`.
  **Presets never record where or from which video something was measured** (no measuredFrom, portedFrom, video or
  project names, YouTube URLs - user 2026-10-02). `basis` says only what was measured, e.g. "measured on one
  reference". Sources go into PROGRESS.md and tool comments.
- All five private presets render with React (2026-09-17). Old episodes were ported and compared pixel by pixel
  with their old finals (solo, multi, donation, longform). Caption positions within 1-2 px. The port scripts were not kept (one-off).
  Presets with `renderer: "legacy-ass"` are rejected by the CLI.
- Cut computation is `shortsmith/lib/cuts.mjs` (port of the old audio.py; same 8 ranges as before on 봉누도2귀신).
- React draws only the transparent overlay (rendering the video too costs 12 s per frame). The window effect maths
  in `lib/render.mjs` and `src/parts/Window.tsx` must stay identical.
- Speed (봉누도2귀신, 28.75 s, measured): full build about 50 s, one caption fix 10 s. Rebundling after a `src/`
  change takes 40-80 s.
- **Two buttons in the feedback flow (2026-09-18):** "Edit" = AI (save + `jobs/<time>_재편집.md`). "Render" = no AI -
  the server runs `tools/apply_review.py` (dashboard captions -> captions.csv, rewrites fx.json references to edited
  lines, and **applies restores and drops to the `edit.json` keep ranges with the same maths as the preview**
  (2026-09-29, previous version kept as edit.json.bak)) -> (`shortsmith cuts` if keep changed) -> `shortsmith build` ->
  `tools/export_shortsmith.py --keep-feedback` (keeps the prompt and notes).
  **So captions.csv may contain user edits - re-running the episode's caption script (make_captions.py etc.) during an
  AI edit wipes them.** Compare with captions.csv before running it.
- **Tracks and layer clips (2026-10-02, fourth round):** in the user edit timeline, video is above the centre line
  (Vn .. V2, V1 = original) and audio below (A1 = original, A2 .. An); each area scrolls vertically with the wheel.
  Captions sit on video tracks (see the fifth round below). Files dropped from the source pane become layer clips
  (video linked with its sound, image, sound) - `review.userLayers` -> `apply_review.py` writes `edit.json` `layers`
  (output time, absolute src path) -> `scene.layers` -> preview `src/parts/Layers.tsx` (Remotion Video, Img, Audio);
  render `lib/render.mjs` composites with ffmpeg above the window and below the React overlay (`layerGraph`), and
  `finish` mixes them with amix (own dB and fades, no normalisation).
  Inspector: position and size % (relative to the size fitted to the window), opacity, brightness, contrast,
  saturation (render uses eq + colorchannelmixer, close to the CSS), sound dB, mute, fade in / out. Original clips (A1)
  also have sound dB (`userClips.vol` -> keep `gainDb`).
  **Ripple moves layer clips and added captions too** (2026-10-03; before that they stayed where they were dropped and
  drifted against V1). If the AI changes the cuts, layer positions can still drift. Export loads `edit.json` layers
  back into `review.userLayers` (the files are canonical).
  After changing the preview bundle, rebuild with `NODE_PATH=<main checkout>/shortsmith/node_modules node <esbuild> preview/entry.tsx ...`
  and copy it to `dashboard/js/vendor` (worktrees have no node_modules, and E: does not support junctions).
- **Original colour and transitions (2026-10-02, fifth):** the V1 clip inspector has colour (brightness, contrast,
  saturation) and "transition (from previous clip)" - dissolve, through black, through white, wipe, slide - and
  duration. `userClips {color, tin:{type, d}}` -> `apply_review.py` puts `color` on every keep piece of the clip and
  `tin` on its first piece -> `cuts.mjs` passes them on -> `body.mjs`: colour is a piece filter (`colorVf`: eq +
  colorchannelmixer); a transition is a short piece of length d centred on the cut (handles = source outside both
  clips, ffmpeg xfade, `cache/tr_*.mkv`, `body.json` transitions) -> `render.mjs transGraph` lays it over the window
  (before zoom and shake). Durations and caption times do not change. Short handles (start / end of source) shorten
  the transition. On episodes with a camera path (dance, 2026-10-03) both handles of a transition piece are drawn with
  the camera path at that source time (`body.mjs camVf` = same cameraSpans and `pathVf` as the pieces). The audio
  crossfade stays at 0.15 s. The preview uses the same maths in `PlanWindow` (`src/parts/Window.tsx`) - with
  transitions it plays from the source copy even after baking (`window_preview` has no transitions). Export carries
  piece `color` and `tin` into `review.clips` so they survive a reopen.
- **Motion and viewer dragging (2026-10-03):** select a layer clip (video or image) with the playhead inside it and a
  box appears in the viewer - drag the middle to move, a corner to scale with fixed aspect (opposite corner fixed, Alt
  = centre fixed). With snap (N) on it snaps to the screen, window edges and centres. Inspector "motion (keyframes)":
  ◇ add key, ◆ delete key, ◀ ▶ previous / next key, smooth, clear motion. Once a key exists, every position or size
  change adds a key at the playhead (like Resolve).
  `userLayers[].keys [{t, x, y, w, h}]` (t = seconds inside the clip) and `ease` go into `edit.json` layers unchanged.
  Preview: `Layers.tsx boxAt`. Render: `render.mjs` scales once to the largest box, pads with transparency, then uses
  `perspective` (eval=frame, in / fps) for per-frame position and size - **overlay cannot take an image whose size
  changes** (scale eval=frame locks to the first frame size, tested 2026-10-03). Blade or Ctrl+B splits keys at the
  cut box; trimming the head shifts the keys too. Ctrl+B cuts only the selected layer clip if one is selected
  (otherwise V1).
  **Transitions between layer clips:** if the previous clip on the same track ends exactly where this one starts, the
  inspector offers the same five transitions and a duration (`userLayers[].tin {type, d}`). Dissolve, wipe and slide
  are centred on the cut and use the parts of both files outside the clips (in render, wipe and slide use transparent
  clips with ffmpeg xfade wipeleft / slideleft - only inside the box; slide pushes the previous clip out too).
  Through black / white do not use anything beyond the cut: the last h of the previous clip and the first h of the
  next fade to that colour (`fade color=`; **in rgba this turns transparent - convert to yuva444p first**).
  (For the three crossing types h = d/2; if a file is too short it gets shorter - the inspector says so; images always
  work.) Render `render.mjs withTrans` and preview `Layers.tsx withTrans` share the maths (previous clip extended by h,
  next clip starts h early with a 2h fade-in on top).
- **Timeline and inspector, fourth round (2026-10-03):** blade = C (not B), I / O = range (outside dimmed, Alt+X clears,
  Delete with nothing selected removes that range from V1).
  Wheel = vertical scroll of that area (video / audio), Ctrl = horizontal, Alt = zoom. Dragging empty space = box
  select. Link icon = linked (video and its sound are selected and moved together).
  Right-click = make group (name), ungroup, rename - clip `g` + `review.userGroups` (saved by server.py). Inspector
  values apply to the same kind (original / image / sound) in the same group (mates).
  Inspector: video / audio tabs, slider + number (X and Y numbers are read-only), three colour tabs (brightness /
  contrast / saturation; RGBW = lift, gamma, gain each with R G B W; curve graph), reset.
  Colour maths is **one file, `shortsmith/lib/color.mjs`** (render `body.mjs` and `render.mjs` use
  curves=interp=pchip with 33 points; the preview uses the same table as an SVG feComponentTransfer; types in
  `color.d.mts`).
  Transform: original clip `tf {x, y, z, r}` = move, zoom and rotate on top of the AI crop (`body.mjs tfCropVf`
  crops again from the source - full quality, black outside; camera episodes use `tfPostVf`). Original clips can be
  dragged as a box in the viewer too. Layer clips have `rot`; captions and label cards have `tf` (`captions.csv` column
  `tf` = "x y z r"; `Caption.tsx` renders it in both render and preview).
  **`server.py` matches caption edits by text (orig) and speaker** - matching only by start time let a label edit
  overwrite the caption next to it when both started at the same time.
- **Moving between tracks (2026-10-03):** drag a V1 clip onto V2.. or right-click "to upper track (V2)" = a layer video
  of the same source range and the same framing (AI crop window aspect + transform tf -> box and rot; colour and group
  follow) (`userLayers` kind video, path = `review.source`, `crop {x, y, w, h}` in source px, `w0 h0`). If that track
  is busy it goes to the next free one above. **Link on = the sound moves to A2.. too (dB includes the piece gain), V1 and
  A1 keep a gap**; link off = the sound stays on A1 and only the V1 picture is blanked (`userClips vhide` -> keep
  `vhide` -> `body.mjs` drawbox black, preview `PlanRange` transparent). Dropping a source layer video back on V1
  (drag or right-click) restores a blanked clip or becomes an original clip in the free space (overlaps within two
  frames snap to the neighbour). `review.source` and `srcSize` are written by `export_shortsmith.py` - old projects
  need a fresh export before clips can be moved.
  Render: `render.mjs` applies the layer `crop` before scale. Preview: `Layers.tsx` widens the video at the same ratio
  and shifts it inside the box.
  Captions under a clip moved up stay (they follow the source range to the layer; `PC` in `apply_review.py` and
  `feedback.js planScene`).
- **Effects tab (2026-10-03):** the left pane has two tabs, sources / effects. Three groups - screen effects (zoom,
  push in / out, shake, blur, mono, flash, vignette, horizontal flip - original clips on V1 only), colour (presets that
  replace the clip `color`; original and layer clips) and transitions (0.5 s). **No sound effects** (no audio filters).
  Drop onto a clip (onto a selected clip = every selected clip; groups always together) or click to apply to the
  selection. Screen effects are `userClips[].fx [{type, z | z0 z1 | amp | sigma | d k | angle}]` -> `apply_review.py`
  writes them to fx.json `"fx"` with `"user": true` and numeric times (clip edit time) (user entries are rewritten
  each time; AI effects stay) -> `scene.fx` -> render and preview use the normal window effects.
  The unbaked preview (`planScene`) drops user entries and re-adds them at the current clip positions. Export puts user
  effects back on the pieces they cover (`review.clips[].fx`). Inspector video tab "effects" = value slider and remove.
- **Render settings and aspect (2026-10-03):** user edit > render tab = file (work folder, output, base language) /
  video (codec H.264 or H.265, encoder auto or software, quality 12-32 (default 20), resolution = preset canvas aspect
  with short side 720 / 1080 / 1440 / 2160 - portrait only offers portrait sizes, frame rate) / audio (AAC bitrate,
  target LUFS = one fixed gain, no limiter - the peak ceiling can stop it short); the render button is at the bottom.
  `project.json render.opts` -> `apply_review.py` writes `edit.json` `output` -> `scene.output` -> `render.mjs
  outVideo`: pieces (cache) stay as they are; only when something differs from the pieces is the joined picture
  encoded once more at the end (`encoder.mjs outputEncoder`, tries hardware first, hevc gets the hvc1 tag). With
  defaults it stays `-c:v copy`.
  AI edit > style apply has an aspect picker (style default, 9:16, 16:9, 1:1, 4:5; `ai.aspect`) - written to the job as
  an "aspect" line.
- **The AI edit tab absorbed the old feedback tab (2026-10-03; user: "remove the log pane, merge the feedback tab into
  the AI edit tab -> allow instructions on the video in the first edit too; tab name AI 편집"):**
  two tabs, AI edit and user edit. AI edit = style apply / analyse | video (note, region, line, arrow) + instructions
  (`review.prompt`, subtitle languages, AI policy) + note list. The log pane, the extra prompt pane and the unused
  "extra sources" pane were removed (extra sources and the old caption pane markup are hidden in `.fb-legacy` -
  feedback.js still references them). `showView('user')` goes to 'ai'.
  **Before the first edit (no final, no scene) it plays the first video dropped in "edit target"** (a browser file; it
  must be dropped again after a reload) and notes are drawn on it - note time = source time.
  The style-apply job carries the instructions, notes (source time, position as 0-1 of the frame) and aspect, and says
  "do not render (first edit included) - preview only with preview_update.py; framing and zoom as values the user can
  change through the original clip transform".
  The re-edit button (old "Edit") appears only once a scene exists. An episode never rendered has no body, so the
  preview background was empty - `shortsmith preview` now makes only `bg_preview.mp4` (540 wide, 30 fps).
  A freshly drawn note that is cancelled (cancel, X, Esc) is removed.
- **Timeline, fifth round (2026-10-03):** everything about using the screens is in `docs/대시보드_가이드.md` (the UI
  carries no explanatory text - user: "delete every add-on explanation, write single words"; every reset button is
  named "초기화").
  Tracks are shown only as far as used (original only = V1 and A1); while dragging, one empty track appears above
  (audio: below) and the area auto-scrolls at the edge. The ST track is gone - **captions sit on video tracks**
  (`review.capTracks` = text -> track; otherwise the first free track from V2; drag to move).
  Caption button = `review.userCaps [{id, at, d, text, speaker, kind, tf}]` (output time) -> `apply_review.py` writes
  captions.csv rows (and `edit.json` captions for an episode that had none) -> after export they are ordinary captions.
  In the final video captions always sit above layer clips (track order is not render order).
  Dragging A1 sound to A2.. makes a layer sound and sets `ahide` on the original clip (keep `ahide` -> `body.mjs`
  volume=0, preview vol 0). Dropping a layer sound on A1 restores it. With link on, picture and sound move together.
  Undo keeps the selection and covers caption tracks and new captions, also right after a slider (app.js `isTyping`
  ignores range inputs). A transition marker selects only the transition; dragging either end changes its length
  (centre fixed).
  Transition types live in one place, `shortsmith/lib/trans.mjs` (wipe and slide in four directions, circle; xfade
  directions measured with red -> blue test clips) - read by `body.mjs`, `render.mjs`, `Window.tsx` and `Layers.tsx`.
  Three more screen effects: flash (at clip start, eq brightness eval=frame), vignette, hflip (`render.mjs fxGraph`,
  `Window.tsx`). Files dropped from Explorer go through `/api/media/upload` into `projects/<id>/media` and
  `review.srcFiles` ("가져온 파일").
  **Autosave stopped after a reload:** when the folder time equalled the browser's, app.js returned without setting
  `diskAt`, so every save was skipped as "folder is newer".
- **Ripple keeps gaps (2026-10-03):** trimming, deleting or inserting with ripple on shifts only what follows the edit
  (`gapsOf` / `pack(G)` / `shiftRest` in `useredit.js`). It used to close every gap on the timeline, which also closed
  the gap left by a clip moved up to V2, so the layer ended up over a different scene.
- **Render once, at the end (2026-10-02; user: "don't render every time - render once at the end and use the preview
  until then", "rendering takes long and costs more tokens").**
  First edits and AI feedback rounds **do not run `shortsmith build`.** Order: 1) `python tools/apply_review.py
  <episode> projects/<id>/project.json` (moves the user's dashboard cuts and captions into the episode folder - without
  it, the export in step 3 wipes the user edit tab cuts) 2) edit edit.json / captions.csv / fx.json
  3) `python tools/preview_update.py <episode> <id>` (= `shortsmith preview`, cuts + scene only, no video, about 1 s,
  + export_shortsmith.py). Skipping 1 makes 3 stop (it compares with the signature in applied_review.json; `--force`
  if the changes may be discarded).
  If scene.json is newer than the final, `review.unbaked` makes the feedback and user edit previews play the source
  copy with the current cuts ("not rendered" badge). The user renders the final from user edit > render.
  The four checks in "after rendering" below run once a final exists (after the last render). Before that, only check
  what source time can answer, like probe.py.
  Changing a caption's **source start / end** in the user edit inspector also changes the cut (earlier = restore,
  later = drop; the line is anchored at `os2 · oe2` source time - read by both `planScene` and `apply_review.py`).
  "Remove this line from the cut" (select a caption, Delete) removes its source range from the cut.
- The feedback preview uses light copies (`window_preview` 30 fps 720 wide, `bg_preview` 540 wide) - playing the 60 fps
  render masters freezes the browser.
- The preview is `dashboard/js/vendor/shortsmith-preview.js` (`cd shortsmith && npm run preview:build`, then copy).
- **Unbaked preview (2026-09-29):** when restores or drops exist, the preview plays the kept ranges from the source
  copy (`src_preview.mp4`, full frame 1280 wide 30 fps) (`scene.plan`, `PlanWindow` in `src/parts/Window.tsx`).
  The copy is made by `tools/src_preview.py <episode> [id]` - called automatically at the end of
  `export_shortsmith.py` (not rebuilt if the source is unchanged; 21 s for this episode). Piece crop and gain follow
  cuts.json (gain is baked up to the largest piece gain and lowered with `<Video volume>` - browser volume cannot exceed
  1). Difference from the render: no crossfade.
- **Ripple on / off (2026-09-30):** switch next to "source / edit" in the feedback view (`review.ripple`, default on).
  On = as before (dropped space is pulled in, restored time pushes later content). Off = later times do not move -
  dropped space becomes a gap and restored speech overwrites its neighbour. Gaps are keep `{ "gap": sec }` ->
  cuts.json `{gap:true, s:0, e:sec}` -> black window and silent piece (body.mjs). The keep computation in
  `feedback.js plan()` and `apply_review.py` is identical (300 random cases: ripple on = old maths, JS = Python).
  With ripple on, moving a caption end in the edit view also moves the following captions on that row (ripple trim).
- **User edit tab (2026-10-02, next to the feedback view, modelled on the DaVinci Resolve edit page):**
  `dashboard/js/useredit.js` and `css/useredit.css`. A clip = source range [s, e] placed at edit time `at`; the list is
  `review.userClips` (in the server.py save list). It starts from the current cut (the plan including feedback
  restores and drops). The render button (`apply_review.py`) uses userClips as the keep ranges when present and moves
  caption and effect times through source time (same path as ripple on; captions of removed clips are dropped).
  Episodes without captions still get their cuts rendered.
  The feedback preview also uses userClips as its plan (word drops and restores then have no effect - the badge says
  so). The preview is `D.Feedback.sceneFor(P)` (unbaked preview).
  Actions: select (does not move the playhead), drag ends (ripple on = pull following, off = gap), drag to move (ripple
  on = insert, off = only into free space), blade (C), Ctrl+B, Delete, Ctrl+Z, snap (N), Ctrl+wheel zoom, Shift+Z fit,
  up / down arrows = edit points. Dance episodes also show the camera path in the unbaked preview (2026-10-03,
  `src_preview.py` puts the keys in `srcPreview.camera` and `Window.tsx camBox` uses the same maths as body.mjs).
  **The right pane has three tabs (2026-10-02): inspector (clip, caption line - text, speaker, design, start, end; also
  label card text) / transcript (clicking a word cuts it out of the clip list or restores it - drops extend to the
  middle of the surrounding pauses, restores add 0.10 / 0.15 s) / render (render button, work folder, output, base
  language, progress).**
  Old episodes whose word times are off: word runs that are kept but outside (or half outside) the AI pieces are
  measured as if moved inside the nearest piece end (keep is canonical).
  The old feedback-tab caption list markup is still referenced by feedback.js and is hidden in `.fb-legacy` (remove the
  `fillSubs` side of feedback.js first if deleting it).
  **Third round (2026-10-02): one video for both tabs** - when the user edit tab is shown it borrows the feedback screen
  (`.fb-stage-wrap`) as its viewer and returns it on leave (same notes, caption edits and playhead).
  Left pane = source folders (`review.srcFolders`, server `/api/media/browse · list · poster`), V1 thumbnails
  (`/api/media/thumbs`, a 0.5 s grid jpg), A1 waveform (`review.wave` or `/api/media/wave`) - cached in the server temp
  folder `kirinuki_media`. Three resize gutters (`split.js .ue-grid`). The whole dashboard uses this tab's neutral grey
  (base.css tokens, on = orange `--on`).
- **Dashboard saves filter `review` by key** (`server.py save_project` - so an old tab cannot roll back pipeline
  output). A new review key must be added to that list, and checked in project.json after a save (2026-09-30: the word
  drop table, `e2`, `kind` and ripple were being dropped).
- The dashboard style list matches presets by `name`. When renaming, keep the old name in `aliases` - if no match is
  found the first style is picked and autosaved (happened once on 봉누도2 귀신 and was reverted).
- **Any new per-frame animated effect must be added to `overlaySig` in `lib/render.mjs`.** Frames with the same key
  reuse one overlay PNG - in 손질 (2026-09-25) spin was missing, so rotation froze in the final only (stills were fine).
- **Cuts only fall in pauses between speech runs.** Run boundaries found with the band-limited track
  (`src_level.wav`) threshold read soft syllables as pauses - draw a separate full-band speech map (-52/-60, 0.30 s)
  and cut between its runs. Re-measure run lengths in the final to confirm they are intact (프젝아 모캡 2026-09-27:
  "반팔이랑" was half cut although the caption check passed - the caption matched the audio that was left).
- **Dance shorts (2026-10-01): preset `Dance(C:S) Solo Shorts` (presets/damui-dance-cs-shorts, the whole screen is
  the window).** `python tools/dance_camera.py <episode> [--sheet]` writes the camera to `edit.json camera.keys` -
  isnet-anime (~/.u2net) extracts the body box (every 0.2 s, cached in the episode's char_masks.npz, about 3 min per
  30 s); optical flow fills the gaps so the body is measured every 1/30 s. The camera never moves before the body (user:
  "it must not move early or late"). **Numbers are measured from the user's two answer pairs** (two pairs of
  original -> hand-edited clips: the frame box was found again in the source per frame with SIFT and compared with the body; 2026-10-01
  third: "you have the answers, analyse again"). The answers keep **scale and vertical position nearly fixed** (same
  value 87-91% and 84-86% of the time), body vertical centre = frame centre, median body height 0.78-0.87 of the frame.
  Only big jumps make it follow upwards while keeping a 0.04 top margin including hands, and only when the body
  overflows does it widen with a 1-2 s ramp. Horizontal follows the centre of mass with zero lag. Our camera kept
  rising and falling with the body and changing scale - "movement and zoom are all wrong".
  Stopping dead when vertical touches the margin line -> switching to body speed made it "judder whenever she jumps or
  crouches even slightly" - it now joins with a quadratic curve before the line (knee) and is lightly filtered.
  The scale is 5% wider than the answers (FILL0 0.82) so small crouches and hops stay inside the margin (vertical kinks
  in the compilation 51 -> 5).
  Silhouettes are extracted with `fps=5:round=up` (the default takes the last frame of each slot, so silhouettes were
  0.083 s in the future). Silhouettes are 480x270 whatever the source aspect, so x and y scale separately (on non-16:9
  sources the feet were cut off). Frames where a notification graphic was taken for the body are re-done cropped around
  the previous body (`check_masks`).
  The first version (hold, then move) was dropped as "far too unnatural / track continuously around the character's
  centre".
  **Motion -> camera, or motion == camera. Camera -> motion is strictly forbidden** (user). Zoom out only when the body
  exceeds the current frame, at the reference speed, slowly, **down to character : margin 8:2 at most** (the character
  fills at least 80% of the frame; inside a back-and-forth span the swept width counts as the character). In
  back-and-forth spans (alternating kicks) it widens to the width swept so far and does not tighten until the span ends;
  after that ("27~28 or early 29 is the normal case") it tightens again.
  No look-ahead (forward-backward smoothing, previewing a whole span's width) - every time, the camera moved early.
  Camera pieces are cut by frame count (cutting with 3-decimal -t gave 1797 frames for 18 pieces - picture lagged sound
  by 50 ms). Numbers come from the user's reference clip (see the notes next to the tool constants).
  For a source with several dancers side by side, track one: `edit.json camera.region: [x0, x1]` (fraction of source
  width) - silhouettes are taken only in that band; choose the band so no other character enters it, measured with
  dark pixels etc. (가시나0 2026-10-02: only 하늘머리, [0.1, 0.45]).
  If the body touches a source edge (feet at the bottom edge), put the frame on that edge and pull the opposite margin
  down to a one-sided share - otherwise the whole bottom margin share goes above the head (가시나0: top 0.155, bottom
  0.004 -> "way too much margin", h 918 -> 843).
  `region` detects on the whole frame and picks the blob mostly inside the band (cropping to the band missed arms
  reaching out of it). Body horizontal extent uses the k-th point from the edge, not a percentile - a thin arm is less
  than 1%.
  **C:D is the second version (2026-10-02, mode "flow", `dance_beats.plan_flow`): no cuts, no punch-in zooms, no fixed
  close-ups - the scale always glides.** The first version (beat cut-ins, push, pulse) scored 3/10: "too mechanical /
  zoom in and out too artificial / zooms in too much when the move matters". The reference VzGBBlqDzqA has no cut in
  the first 12 s (checked at 5 fps). Per bar, ranked by motion: wide (body 0.88; 0.74 was "too much margin on the wide
  shot") down to above the thighs; the target changes on the bar's first beat; two springs (push 4 beats, pull 2) + a
  ±5% breath every 4 bars.
  **Camera kinks ("juddering") come from hard clamps after the filter** - hand inclusion, feet inclusion, source edges
  and hand-width scale all go into the target before the filter; after it only an acceleration limit remains (C:S A_XS
  3, C:D FLOW_A 2 h/s², follow snap=False). Head and raised hands use the highest point of the last 0.6 s (no following
  nods down). Kink check: more than 0.15 h/s change within 0.1 s.
  For challenges (~챌린지), look at several challenge videos and add punch-ins as `camera.punch: [{s, e, z}]` (upper-body
  cut in and out).
  keep is `{ "s", "e", "raw": true }` so waveform cuts do not cut the music. `body.mjs` splits pieces at each key time:
  holds use crop; consecutive moving keys are rendered as one piece of up to 3 s with a perspective path (sub-pixel
  position per frame). The unbaked preview shows the camera too (`srcPreview.camera` -> `plan.camera`, 2026-10-03 -
  before that it did not).
  **Run shortsmith from the shortsmith folder** - Remotion downloads Chrome (521 MB) into the working directory.
- E: does not support hard links (`fs.linkSync` EISDIR).
- **Kdenlive export (2026-10-02, first version, not used in the current flow):** `python tools/export_kdenlive.py
  <episode>` -> `<episode>/kdenlive/<episode>.kdenlive` (+ `.kdenlive.ass` captions), run after `shortsmith build`.
  The dashboard does not call it and user edit tab changes (layers, colour, transitions, effects, new captions) are
  not carried. It carries source pieces (extendable), background, window crop, piece gain, overall fixed gain and
  Kdenlive captions (text edits included, an ASS style per kind). Missing: title, images, chat, effects, camera.
  **Kdenlive traps (measured):** without a profile name (`vertical_hd_60`) it renders 720x576 25 fps; Kdenlive fills
  use_profile=1 on the crop effect and reads the values in project size (source px values zoom in only in Kdenlive);
  the sequence tractor id is the uuid itself; never add kdenlive_id to the caption filter;
  **`kdenlive --render` always crashes on a project with captions** (also on projects Kdenlive saved itself - 26.08.1
  bug) - test renders without captions, open captions in melt or the UI.
  melt cannot open Korean file names (use an English copy).
- **For a new source, check the audio start_time first** (`ffprobe -show_entries stream=codec_type,start_time`). OBS
  recordings have 0, but 2시.mp4 (Quick Share) had 0.450 - extracting the wav as is makes every transcript and level
  time early by that much, so sentence ends get cut and captions come early. Align the analysis wav to the video clock
  with `adelay=<ms>:all=1` (the sample count `S` is in the input sample rate and easy to get wrong). body.mjs warns.

## Cuts and caption grouping (프젝아 모캡 2026-09-27, rules that took ten rounds)

One episode needed nine re-edits. Almost all of them came from **misjudging where a word is audible** and from
**cuts splitting a caption line**. From the next episode on, do this from the start.

1. **One caption line = one scene.** Cut only where the caption changes. A cut through the middle of a line makes the
   viewer read the rest **as belonging to the next scene** (the user said this five rounds in a row). Even with a 1 s
   pause inside a line, one scene reads as one unit - **grouping is read by scene, not by pause.**
2. **Cut only between speech runs.** Draw runs on the full-band speech map (-52/-60, 0.30 s). Run boundaries from the
   band-limited track (`src_level.wav`) threshold read soft syllables as pauses and cut words in half.
3. **Unvoiced fricatives (ㅅ, ㅆ, 슈, ㅎ) do not show on the level.** Also look where the 3-7 kHz to 200-1500 Hz ratio rises
   above 0 dB. The 슈 of "슈트를" sat at -64 dB, was read as a pause, the caption was put 1 s early, and five rounds were
   spent looking in the wrong place.
4. **Do not trust Whisper word times around pauses** (up to 1.6 s off here). Line times come from spreading characters
   over the speech runs (`tools/edit_audit/align.py`).
5. **Mocap and full-body sources jump even when only 0.2 s is removed.** If something must go, use `cutmatch.py` to pick
   the spot where the picture jumps least, measured as the **maximum difference over an 8x8 grid** (a frame average
   misses one arm moving).
6. **After rendering, run four checks and finally grab frames and look** (`tools/edit_audit/README.md`):
   verify_runs (speech cut?), scenes (cut through a line?), pauses (groups match pauses?), check (caption over a gap or
   mid-word?).
   **Measure caption text with fit.py** (2026-09-30, all presets): whether a line fits without shrinking the font
   (same yardstick as the renderer - checked against browser canvas values) and whether a sentence split into two lines
   is lopsided like 8:2. Before writing, measure with `fit.py <episode> "text"`.
   **Never say "fixed" based on numbers alone.**
7. **Do not read the user's words narrowly.** A quoted word may be **the name of a caption line**, not a word ("'이게'
   moves to the next scene"), and "scene" means a cut. When unsure, ask - two rounds were lost to a misreading.
8. **Ask early when a word's position is disputed.** For spots the waveform cannot settle (a run missing from the
   transcript, telling fricatives apart), one question to the user is cheaper than five rounds.

## Rendering uses a piece cache (old pipeline)

`piece_cache.py` renders each piece separately and re-renders only what changed.

    build_edit.py       render pieces (layer 1) and join them into body.mkv
    apply_captions.py   burn captions per piece (layer 2) and join into the final

A full render of the main episode takes 1 min 48 s; with the cache, 3 s. Fixing one caption re-renders only the pieces
under it (usually 1-2). Joining is `-c copy`, no re-encode. Cache entries unused for 7 days are deleted automatically.

Moving a cut shifts every later caption's final time, so the later pieces are re-rendered too - unavoidable.

## Saving tokens

First edits and single feedback rounds used to cost about the same number of tokens. Causes and fixes:

1. **Do not dump raw tables into the conversation** (100 lines of waveform, a full transcript dump).
   Ask `probe.py` for just the spot you need - it prints sound, cuts, picture, captions and transcript in under ten lines
   (`python probe.py 26 29`, final time with `-o`). The waveform is cached in `level.json`, so later calls take 0.2 s.
2. **Do not rewrite whole files.** A new 200-line script costs 200 lines of tokens. Change only what changes.
3. **Images only when a judgement depends on them.** One contact sheet costs more than a waveform table. Grab one only
   when "what is visible here" is the real question.
4. **Scripts print conclusions.** Check scripts print "N problems" and those N only; passes collapse into one line.
5. **Write decisions into code comments and `PROGRESS.md`** so the next round does not need the explanation again -
   the conversation disappears, files stay.

## Separate what was measured from what was guessed

When writing comments and `PROGRESS.md`, **state the basis.** "Measured 53.98 s" and "probably a viewer nickname" carry
different weight, but side by side in a comment both read as fact in the next round.

**Why:** a guess written into a comment as if it were fact was read as fact in the next rounds and ranked above the
user's own feedback; correcting it took three rounds.

**How to apply:** mark guesses with "(guess)" or "not verified". When it conflicts with user feedback the guess loses,
even if a reason was written down.
