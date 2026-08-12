# tv-mode — Requirements

**Epic:** castcrate
**Created:** 2026-08-12
**Motivation:** Once `watch-later` ships, the Library becomes CastCrate's home — a growing poster-grid of pre-downloaded titles ready to play with zero buffer. But today the whole UI is designed for phone/laptop touch + mouse: buttons are small, no visible focus outlines, no keyboard nav. If you sit on the couch, point the TV's browser at CastCrate, and try to drive it with the Chromecast remote, it works technically but feels bad — you're clicking around a phone UI from 3 metres away with a 5-button remote.

The user's TV is a **Chromecast HD with Google TV** (2022 device, "Master Llama"). Google TV ships with **Chrome**, which means CastCrate's existing web app already runs on the TV without any new distribution surface — no native app, no Cast Receiver Application ID, no app store. The only thing missing is a UX skin that respects a 10-foot viewing distance and remote-only input.

Also: any HDMI stick with a real browser (Google TV, Fire TV Silk, an Apple TV with sideloaded browser) gets this for free. Not Chromecast-specific.

## Overview

Add a **"TV mode"** skin to the existing web UI — focus-nav for arrow keys + OK, poster-grid layout as the primary browsing surface, larger targets, high-contrast couch-readable typography, and keyboard shortcuts that align with Google TV remote's dedicated Media buttons (Play/Pause/Back). Opt-in via a `?tv=1` query param for v1 (auto-detect via user-agent in a follow-up). Every existing view (Search, Library, Settings, Player, Cast controls) gets a TV-mode variant; underlying data and backend are 100% reused — no new endpoints, no new deps, no new distribution mechanism.

The design goal is not "reinvent the UI" — it's "the same UI, laid out for a couch." The user should be able to browse Library, launch playback, and control cast from the couch with just the Chromecast remote in hand.

## Requirements

- **Opt-in via `?tv=1` URL query param** (v1). Auto-detect via `navigator.userAgent` matching Google TV / Android TV / Fire TV strings is deferred to a follow-up — v1 is explicit so we can test without misclassifying anyone.
- **Layout adjustments** (all triggered by the `tv` mode flag; existing mobile/desktop layouts unchanged):
  - Larger base typography (base font-size bumped ~30-50%), higher contrast, greater whitespace between rows/cards.
  - Poster grid becomes the primary browsing surface — Library view opens in poster-grid mode by default (already the completed section's layout, generalise to whole view).
  - Search results render as a horizontal poster row per source (Netflix-style rails), not vertical list.
  - Buttons get bigger touch targets (~64px min height), visible focus outlines (2-3px, high-contrast colour that matches theme).
- **Keyboard / remote navigation**:
  - Arrow keys navigate focusable elements (posters, rows, buttons).
  - Enter / Space activates focused element (matches remote's OK button — Google TV's remote OK sends Enter to Chrome).
  - Backspace / Escape navigates back one level (matches remote's Back button — Chrome maps it to browser-back or configurable).
  - Roving tabindex pattern (only one element in a group has `tabindex=0`; arrow keys shift focus + tabindex) — standard TV-UI accessibility pattern.
  - Focus is always visible; no silent focus loss.
  - Media keys work natively on `<video>` elements (Google TV's remote's Play/Pause maps to `MediaSession` API which the existing HTML5 video handles).
- **Player + cast controls in TV mode**:
  - Player overlay controls scale up + auto-hide (~3s idle, same as existing behaviour); remote wakes them.
  - Cast picker shows as a focus-nav'd list, not a hover-dropdown.
  - Subtitle picker + audio track picker similarly focus-nav'd.
  - Volume + seek controlled by remote's Media keys and left/right arrow keys during playback.
- **Library-first landing**: `?tv=1` opens directly on the Library view (not search), because pre-downloaded content is the zero-buffer surface — the whole reason for TV mode.
- **Zero regressions on non-TV layouts**: mobile + desktop rendering unchanged. All TV-mode styles are additive and gated on the mode flag.
- **No new backend endpoints** — TV mode reuses `/api/library`, `/api/search/torrents`, `/api/cast/*`, `/api/torrent/*` exactly as-is.
- **No new dependencies** — arrow-key focus management can be done in ~50 lines of custom hook logic (React refs + keydown listeners), no need for a focus-management library.
- **Deep-linkable**: `?tv=1` is preserved across navigation; a link like `http://castcrate.local:3000/?tv=1` sent to the TV opens Library in TV mode directly, no click-through.
- Runbook / user guide addition: brief note in the deploy docs on how to open CastCrate on Google TV's Chrome + bookmark the `?tv=1` URL.

## Dependencies

- **External:** None. Runs on any browser with modern focus + keyboard events (Chrome ≥ 90, all modern TV browsers).
- **Repo:** touches `apps/web/src/lib/` (new `tvMode.ts` — mode detection + focus utilities), `apps/web/src/App.tsx` (mode flag propagation + landing route), `apps/web/src/components/*` (each view gains TV-mode-aware styling; new `TvFocus` wrapper component or similar), `apps/web/src/styles/` (a new `tv.css` or Tailwind config extension for tv:*-prefixed classes if we use a Tailwind variant), and `docs/features/castcrate/tv-mode/` (feature docs).
- **Existing features to coordinate with**:
  - `watch-later` — Library is the TV-mode landing surface. Poster grid design should account for TV-mode consumption.
  - `player-controls` — the Netflix-style browser controls we built already have keyboard shortcuts; TV mode extends them to remote-friendly arrow-nav + focus outlines.
  - `player-buffer-ux` — buffering overlay should render at TV-scale text sizes when in TV mode.
  - `cast-controls`, `chromecast` — the cast picker + control surface needs focus-nav.
  - `subtitles` — subtitle picker needs focus-nav.
  - `library-settings`, `discovery`, `omdb-search`, `tv-shows`, `tmdb-metadata` (planned) — search results view needs the Netflix-rails layout in TV mode.

## Out of Scope

- Native Android TV app. Big undertaking; the web-mode variant covers the same devices with zero distribution overhead. Revisit only if the web variant proves inadequate.
- Custom Chromecast Cast Receiver app. Requires a paid Google Cast developer account, a public URL for the receiver HTML, and doesn't help on Google TV (which already has Chrome). Not the right tool for this use case.
- Voice search / voice commands. Google TV's remote has a voice button but that's routed to Google Assistant globally; not something CastCrate can integrate with from a web app.
- User-agent-based auto-detection. v1 is opt-in via `?tv=1`. Auto-detect is a small follow-up if `?tv=1` proves annoying to type on a remote (bookmark solves it).
- Multi-user profiles / per-user Library. Single-user matches CastCrate's overall scope.
- TV-specific "recently added" or "recommended for you" rows on the landing view. v1 = the existing Library layout, focus-nav'd + bigger. Content curation is a follow-up.
- Screen-saver / ambient mode when idle on the TV. Google TV handles this globally; not our concern.
- Chromecast Cast-from-TV-mode → Chromecast (which is the same device). If the user is browsing on Master Llama and casts to Master Llama, the flow is trivially "just play locally in the browser." No new mode; the existing cast flow works.

---

*Consumed by `/plan-feature castcrate/tv-mode`. See `implementation.md` for the planning notes drafted alongside these requirements; run `/plan-feature` when ready for the full solution-architect pass.*
