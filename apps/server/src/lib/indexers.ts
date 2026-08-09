import type { TorrentResult, TriedEntry } from "@castcrate/shared";

// ---------------------------------------------------------------------------
// Query shapes
// ---------------------------------------------------------------------------
//
// One shape per `kind`. Adapters only receive the query they were asked for —
// `runFallback()` picks the right method by kind, so movie adapters never
// see episode fields (and vice versa). Keeping these separate avoids the
// "which fields are populated?" branching that lived in the routes before.

export interface MovieQuery {
  title: string;
  year?: number;
  /** Some adapters (Stremio) key off IMDb; others (YTS, Knaben, TD) ignore it. */
  imdbId?: string;
}

export interface EpisodeQuery {
  imdbId: string;
  season: number;
  episode: number;
  /** Some adapters (Knaben, TD) can only search when the series title is known. */
  title?: string;
}

export interface SeasonPackQuery {
  imdbId: string;
  season: number;
  title?: string;
}

export type IndexerKind = "movie" | "episode" | "seasonPack";

// ---------------------------------------------------------------------------
// AdapterContext — currently empty, kept as a type seam so we can thread
// per-request state (logger, AbortSignal, deadline) later without a signature
// churn. Adapters that don't need it can ignore the arg.
// ---------------------------------------------------------------------------

export type AdapterContext = {
  // Reserved. Add fields here rather than adding args to search methods.
};

// ---------------------------------------------------------------------------
// AdapterError — the mixed wire shape today's client parses. `string` covers
// simple throws (e.g. `yts: <msg>`); the object form covers structured
// per-upstream errors (Stremio's per-addon failures, TorrentDay's auth
// distinction).
// ---------------------------------------------------------------------------

export type AdapterError =
  | string
  | { source: string; code: string; addonId?: string; addonName?: string };

// ---------------------------------------------------------------------------
// IndexerAdapter — one per source (yts, eztv, knaben, torrentday, stremio).
// The `enabled(ctx)` gate lets each adapter self-check its own settings
// (per-source flag, credentials, addon list) — this used to be inlined at the
// route.
// ---------------------------------------------------------------------------

export interface IndexerAdapter {
  /** Short identifier, e.g. "yts". Surfaces in `TriedEntry.name` and in the
   *  `tried[]` array the client sees. */
  name: string;

  supportsMovie: boolean;
  supportsEpisode: boolean;
  supportsSeasonPack: boolean;

  /** Called before each search. Return false to skip this adapter entirely
   *  (it is not added to `tried[]`). Receives both the current query and
   *  ctx so adapters can skip when required query fields are absent —
   *  e.g. Stremio needs an imdbId, TorrentDay episode search needs a
   *  series title. Default: always enabled. */
  enabled?(
    query: MovieQuery | EpisodeQuery | SeasonPackQuery,
    ctx: AdapterContext,
  ): boolean;

  searchMovie?(
    query: MovieQuery,
    ctx: AdapterContext,
  ): Promise<AdapterOutcome>;

  searchEpisode?(
    query: EpisodeQuery,
    ctx: AdapterContext,
  ): Promise<AdapterOutcome>;

  searchSeasonPack?(
    query: SeasonPackQuery,
    ctx: AdapterContext,
  ): Promise<AdapterOutcome>;

  /** Optional hook to translate this adapter's own tagged errors (e.g.
   *  `TorrentDayAuthError`, `KnabenTaggedError`) into the structured
   *  `AdapterError` wire form. Return `undefined` to fall through to the
   *  default `"<name>: <msg>"` formatting. */
  formatThrown?(err: unknown): AdapterError | undefined;
}

/**
 * Return value from a single adapter call. `errors` covers the fan-out case
 * (Stremio) where a single adapter call touches N upstreams and some may fail
 * while others succeed — those partial failures flow into
 * `FallbackChainResult.errors[]` exactly as the route currently emits them.
 */
export interface AdapterOutcome {
  results: TorrentResult[];
  /** Structured per-upstream errors. Thrown errors from the adapter itself
   *  are caught by `runFallback` and formatted separately — this is only for
   *  adapters that return partial failure info alongside partial results. */
  errors?: Array<{
    addonId?: string;
    addonName?: string;
    code: string;
  }>;
}

// ---------------------------------------------------------------------------
// FallbackChainResult
// ---------------------------------------------------------------------------

export interface FallbackChainResult {
  results: TorrentResult[];
  /** One entry per adapter that ran. `tried[i].count` is the raw result
   *  count from that adapter; `tried[i].error` is the primary error (first
   *  upstream failure, or the thrown message). See `errors[]` for the full
   *  expanded per-upstream list. */
  tried: TriedEntry[];
  /** Flat, wire-compatible mixed error list — one entry per per-upstream
   *  failure across the whole chain, in adapter visit order. Preserves the
   *  exact shape today's 502 response uses. */
  errors: AdapterError[];
  /** name of the adapter that produced non-empty results, if any. */
  winner?: string;
}

// ---------------------------------------------------------------------------
// runFallback — iterate adapters in order, return on first non-empty result.
// ---------------------------------------------------------------------------
//
// Semantics preserved from the previous inline implementation in
// routes/torrents.ts:
//   - Adapters are visited in the given order.
//   - Each visited adapter contributes exactly one TriedEntry.
//   - An adapter that returns an empty result set is recorded (count: 0) and
//     the chain continues.
//   - An adapter that throws is recorded (error: "<name>: <msg>") and the
//     chain continues.
//   - An adapter that reports per-upstream errors alongside results has each
//     upstream error appended to the chain's `errors[]` (matches route's
//     old per-addon flattening for Stremio).
//   - An adapter that returns >=1 result stops the chain — its results
//     become the winner and no further adapters are visited. Errors from
//     the winning adapter's own partial failures are still recorded.
//   - An adapter whose `enabled()` gate returns false is skipped without
//     any tried entry — it never ran.

export async function runFallback(
  adapters: IndexerAdapter[],
  query: MovieQuery | EpisodeQuery | SeasonPackQuery,
  kind: IndexerKind,
  ctx: AdapterContext = {},
): Promise<FallbackChainResult> {
  const tried: TriedEntry[] = [];
  const errors: AdapterError[] = [];

  for (const adapter of adapters) {
    if (!supports(adapter, kind)) continue;
    if (adapter.enabled && !adapter.enabled(query, ctx)) continue;

    const method = pickMethod(adapter, kind);
    if (!method) continue;

    const entry: TriedEntry = { name: adapter.name, count: 0 };
    tried.push(entry);

    let outcome: AdapterOutcome;
    try {
      outcome = await method(query as never, ctx);
    } catch (err) {
      const wireError = formatThrown(adapter, err);
      entry.error = wireError;
      errors.push(wireError);
      continue;
    }

    // Fan-out adapters (Stremio) may return partial errors alongside results.
    // Preserve the exact per-upstream expansion the route used to do inline.
    if (outcome.errors && outcome.errors.length > 0) {
      for (const e of outcome.errors) {
        errors.push({
          source: adapter.name,
          code: e.code,
          ...(e.addonId !== undefined ? { addonId: e.addonId } : {}),
          ...(e.addonName !== undefined ? { addonName: e.addonName } : {}),
        });
      }
      // Summary on the tried entry: first upstream failure.
      const first = outcome.errors[0]!;
      entry.error = {
        source: adapter.name,
        code: first.code,
        ...(first.addonId !== undefined ? { addonId: first.addonId } : {}),
        ...(first.addonName !== undefined ? { addonName: first.addonName } : {}),
      };
    }

    entry.count = outcome.results.length;

    if (outcome.results.length > 0) {
      return { results: outcome.results, tried, errors, winner: adapter.name };
    }
  }

  return { results: [], tried, errors };
}

function supports(adapter: IndexerAdapter, kind: IndexerKind): boolean {
  if (kind === "movie") return adapter.supportsMovie;
  if (kind === "episode") return adapter.supportsEpisode;
  return adapter.supportsSeasonPack;
}

function pickMethod(
  adapter: IndexerAdapter,
  kind: IndexerKind,
):
  | ((q: never, ctx: AdapterContext) => Promise<AdapterOutcome>)
  | undefined {
  if (kind === "movie") return adapter.searchMovie as never;
  if (kind === "episode") return adapter.searchEpisode as never;
  return adapter.searchSeasonPack as never;
}

function formatThrown(adapter: IndexerAdapter, err: unknown): AdapterError {
  if (adapter.formatThrown) {
    const custom = adapter.formatThrown(err);
    if (custom !== undefined) return custom;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return `${adapter.name}: ${msg}`;
}

// ---------------------------------------------------------------------------
// triedNames — collapse TriedEntry[] into the flat `string[]` the client
// consumes today via `q.data.tried`.
// ---------------------------------------------------------------------------

export function triedNames(tried: TriedEntry[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tried) {
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    out.push(t.name);
  }
  return out;
}
