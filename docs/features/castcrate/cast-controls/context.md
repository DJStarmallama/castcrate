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
