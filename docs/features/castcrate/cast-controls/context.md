# cast-controls — Context

**Last updated:** 2026-05-09
**Status:** Implemented (retrospective doc)
**Builds on:** Phase 3 (chromecast)

## Status

- Refined Now Playing panel: seek + skip + play/pause + volume + mute + stop
- Browser fullscreen for in-browser playback ('F' shortcut)
- Search type filter (All / Movies / TV)
- 1s polling for cast state — no WebSocket yet
- No new tests

## Key files

- `apps/web/src/components/CastControls.tsx` — refined panel
- `apps/web/src/components/Player.tsx` — fullscreen button + listener
- `apps/web/src/App.tsx` — typeFilter + FilterPill
- `apps/web/src/lib/api.ts` — passes type
- `apps/server/src/services/cast.ts` — mute/unmute dispatch, status volume/muted fields
- `apps/server/src/routes/cast.ts` — VALID_ACTIONS extended
- `apps/server/src/routes/movies.ts` — single-pass when type set
- `packages/shared/src/index.ts` — CastSessionStatus, CastAction

## Decisions

- **No custom fullscreen UI.** Use the browser's native HUD. Less code, fewer bugs.
- **No vendor prefixes.** Modern browsers only. Add later if embedding is needed.
- **Fire-and-forget controls + polling reflection.** Simpler than optimistic UI; acceptable lag for one user.
- **Type filter is cache-key driven.** TanStack Query handles re-fetch automatically; no manual invalidation.
- **Mute/unmute as discrete actions.** Cleaner than overloading "volume" with magic values; cleaner client-side icon switching.

## Gotchas

- **1s seek/volume lag.** Slider snaps back until poll arrives. Optimistic updates would help.
- **'F' shortcut excludes inputs only.** Textareas, contenteditable not excluded.
- **iOS fullscreen forces native chrome.** Our overlay disappears.
- **No vendor prefixes** — assume modern browsers.
- **Phase 7 only adds UI/dispatch tweaks.** Don't reorganise cast.ts/discovery.ts here; Phase 3 owns the mDNS + session model.

## Epic Review Findings (2026-08-09)

- 🔗 **Cast session has no heartbeat** — spans chromecast ↔ cast-controls ↔ player-buffer-ux. (See epic-overview.md → Tech Debt / Findings for full detail.)
- 🔗 **Subtitle picker no-op during cast** — spans subtitles ↔ cast-controls ↔ player-buffer-ux. (See epic-overview.md → Tech Debt / Findings for full detail.)
- 🔗 **Transcoder has no fallback if ffmpeg dies mid-stream** — spans transcoding ↔ player-buffer-ux ↔ cast-controls. (See epic-overview.md → Tech Debt / Findings for full detail.)
- 🔗 **`type` filter is load-bearing in the OMDb cache key but undocumented** — spans omdb ↔ cast-controls ↔ discovery. (See epic-overview.md → Tech Debt / Findings for full detail.)
- 💳 **No optimistic UI on seek/volume; keyboard shortcuts missing; type-filter pills vanish under 3 chars** — sliders snap-back on drag; Space/Arrow/M do nothing; changing filter at 2 chars silently clears it. Optimistic reconcile; keyboard listeners; always render pills (disabled when < 3 chars). Also: interleave behavior for `type=all` is undocumented (add JSDoc + test). (See epic-overview.md → Tech Debt / Findings.)

_Recorded by /review-epic castcrate on 2026-08-09._
