# tv-mode — Implementation Plan (skeleton)

**Epic:** castcrate
**Created:** 2026-08-12
**Status:** Skeleton — first-pass architectural sketch. Run `/plan-feature castcrate/tv-mode` when ready for the full solution-architect pass.

## Approach

Web-only "10-foot UI" skin over the existing React app. Mode flag driven by `?tv=1` URL query param (v1). When active, layouts switch to poster-grid + Netflix-style rails, typography scales up ~35%, buttons gain visible focus outlines + larger targets, and a roving-tabindex focus manager wires arrow keys / OK / Back to element navigation. No new endpoints, no new deps, no native app, no Cast Receiver — the whole feature is one CSS-and-focus-management pass over the existing UI.

## Key Decisions

- **Web-only, no native app.** Google TV's built-in Chrome runs our existing React app; the only thing missing is a couch-friendly skin. Native Android TV app is 10x the effort for the same devices — revisit only if the web variant is inadequate.
- **`?tv=1` query param, not user-agent auto-detect (v1).** Explicit opt-in avoids misclassifying real browsers (Samsung Smart TV Chrome, someone's Windows Chrome with weird UA), and makes the mode trivial to test on any device (open `http://castcrate.local:3000/?tv=1` on a laptop). Auto-detect is a small follow-up if `?tv=1` proves annoying (bookmark solves it in practice).
- **Roving tabindex focus manager, no library.** ~50 lines of custom hook logic (`useTvFocus(groupRef, itemCount)`) — sets `tabindex=0` on the active element and `tabindex=-1` on the rest, handles ArrowLeft/Right/Up/Down + Home/End keydown to shift focus. TV UI focus libraries (react-tv, spatial-navigation) are overkill for our surface size.
- **Landing view = Library (not Search).** In TV mode the primary value is instant, zero-buffer playback of pre-downloaded content — that's the whole reason we built `watch-later`. Search is still available (nav button) but Library is the default landing route.
- **Tailwind variant + mode class on `<body>`.** Add a `tv:` variant to `tailwind.config.js` (via `plugin(({ addVariant }) => addVariant('tv', ':where(.tv-mode) &'))`) so components can write `<div class="text-base tv:text-2xl">` and the variant only applies when body has `tv-mode` class. Clean, colocated with existing styles, zero new files for most components.
- **Additive-only styling.** Every existing `className` stays; TV variants extend. Mobile + desktop unchanged. Zero-regression contract on the non-TV code path.
- **Netflix-rails for search results.** Vertical list → horizontal poster row per source. Arrow keys navigate within a row, Down/Up switch rows. Matches user expectations (Netflix / YouTube / Google TV native rows).
- **Media session for remote's Play/Pause/Volume.** Google TV remote's Media keys map to HTML `MediaSession` API events on the `<video>` element — we get remote support "for free" if we register the video correctly. Already works with the existing `<Player>`; no change needed. Verify in Phase 3.
- **No new backend surface.** The whole feature is frontend. Backend stays exactly as-is.

## Files affected (rough sketch)

Web (new):
- **NEW** `apps/web/src/lib/tvMode.ts` — mode detection (`isTvMode()` reads `?tv=1`), mode context provider (`<TvModeProvider>`), and the `useTvFocus()` roving-tabindex hook.
- **NEW** `apps/web/src/components/tv/TvFocus.tsx` — small wrapper that installs the tabindex + keydown listeners on a container element. Composed with any focusable grid/list.
- **NEW** `apps/web/src/styles/tv.css` (if Tailwind variant isn't enough) — global TV-mode overrides (base font size, contrast). Alternative: put these in the Tailwind config as `tv:` variants of existing utilities.

Web (edited):
- **UPDATE** `apps/web/src/App.tsx` — mount `<TvModeProvider>`, add `tv-mode` class on body when active, route landing to Library when TV mode + no other query params.
- **UPDATE** `apps/web/src/components/Library.tsx` / `WatchLaterLibrary.tsx` — wrap poster grid in `<TvFocus>`; add `tv:` variants to card sizes, spacing, typography.
- **UPDATE** `apps/web/src/components/Search.tsx` (or wherever search results render) — switch to Netflix-rails layout under `tv-mode`; horizontal scrollable row per source; each row `<TvFocus>`.
- **UPDATE** `apps/web/src/components/Settings.tsx` — form controls become focus-nav'd; larger targets in `tv-mode`.
- **UPDATE** `apps/web/src/components/Player.tsx` — control overlay auto-hide + wake-on-remote-key; scale up typography + button sizes in `tv-mode`. MediaSession registration verified.
- **UPDATE** `apps/web/src/components/CastControls.tsx` + `CastBar.tsx` — device picker + transport controls focus-nav'd.
- **UPDATE** `apps/web/src/components/SubtitlePicker.tsx` — focus-nav'd list.
- **UPDATE** `apps/web/src/components/TopNav` (inline in App.tsx) — persistent nav becomes focus-nav'd; Library button gets keyboard shortcut.
- **UPDATE** `apps/web/tailwind.config.js` — add `tv:` variant plugin.

Docs:
- **UPDATE** `docs/features/castcrate/media-mac-deploy/tasks.md` — brief post-DoD note: "For TV browsing, open `http://castcrate.local:3000/?tv=1` in Google TV's Chrome and bookmark it. Use arrow keys + OK to navigate."

## Rough phase sketch (for `/plan-feature` to flesh out)

1. **`tvMode.ts` foundation** — mode detection, provider, `useTvFocus` hook, Tailwind `tv:` variant. Unit-testable with jsdom.
2. **Landing + nav** — `?tv=1` opens Library by default; nav is focus-nav'd; Library ↔ Search ↔ Settings all reachable via remote.
3. **Library view in TV mode** — poster grid scales up + focus-navs; OK opens Play; Left/Right on remote controls cycles pin/delete quick-actions.
4. **Search results as Netflix-rails** — horizontal per-source rows; landing rail = last search or "trending" (if we have it via TMDB).
5. **Player + cast + subtitles in TV mode** — controls scale, focus-nav, MediaSession verified end-to-end on Master Llama.
6. **Manual verification on the real box** — open in Google TV Chrome, navigate Library, cast a title from Library, all with the remote. Log any friction back into the feature docs.

## Definition of Done (draft — refine in `/plan-feature`)

- `?tv=1` on the URL activates TV mode; page renders with larger typography, poster grid, visible focus outlines.
- From `http://castcrate.local:3000/?tv=1` on the TV's Chrome, using only the Chromecast remote:
  - Library view loads on first paint
  - Arrow keys move focus between poster tiles + between rows
  - OK opens the focused Library item's Play flow
  - Playback starts on the TV browser (or casts to itself — same device, edge case; treat as "just play locally")
  - Remote's Play/Pause pauses / resumes the video
  - Back button navigates one level up
- Search from the couch works: navigate to Search, type a title (via remote's keyboard input — Google TV shows an on-screen keyboard, that's out of our control), pick a result, cast to another device if desired.
- `pnpm --filter @castcrate/web typecheck` clean; no regressions on mobile / desktop layouts (spot-check with a viewport-emulator).

## Quality Bar

- **Zero regressions on non-TV surfaces.** Mobile + desktop layouts render byte-identical to pre-feature.
- **Focus is always visible in TV mode.** No silent focus loss. `:focus-visible` styles are aggressive and unmissable at 3m.
- **Arrow-key navigation feels immediate.** No lag between keydown and focus shift. No accidental scroll.
- **MediaSession works with the remote's Media keys.** Verified on real hardware in Phase 6.
- **Feature is fully additive.** Delete `tv-mode.css` / remove `?tv=1` handling and everything else keeps working.
