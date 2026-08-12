/**
 * Shared error classes for the TorrentDay adapter.
 *
 * Extracted from `torrentday.ts` so that `torrentday-fetch.ts` can throw
 * `TorrentDayAuthError` from the subprocess-exit-code branch without creating
 * a circular import (`torrentday.ts` → `torrentday-fetch.ts` → `torrentday.ts`).
 *
 * The public API of `torrentday.ts` re-exports these from here for backward
 * compatibility with existing callers.
 */

export class TorrentDayAuthError extends Error {
  constructor(message = "TorrentDay auth failed — refresh cookies") {
    super(message);
    this.name = "TorrentDayAuthError";
  }
}

export class TorrentDayDisabledError extends Error {
  constructor(message = "TorrentDay is disabled or credentials are not configured") {
    super(message);
    this.name = "TorrentDayDisabledError";
  }
}
