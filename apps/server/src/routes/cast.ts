import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { CastAction, SetActiveTracksRequest, SubtitleTrack } from "@castcrate/shared";
import { listDevices } from "../services/discovery.js";
import {
  play,
  control,
  getSession,
  setActiveTracks,
  CastSessionNotFoundError,
  UnknownTrackIdError,
  type PlayParams,
  type PlayTrack,
} from "../services/cast.js";
import { getLanIp } from "../lib/network.js";
import { config } from "../lib/config.js";
import { getMeta, getStatus, setMetaHistoryId } from "../services/torrent.js";
import { appendHistory } from "../services/history.js";
import { listSubtitles } from "../services/subtitles.js";

// TrackId namespacing convention:
//   Torrent-embedded tracks → `index + 1` (typically 1..20)
//   OpenSubtitles tracks   → `10_000 + offset` (10_000..)
// Two separate ranges keeps them non-colliding while remaining stable per
// cast session (the OS results are cached for an hour, so the offset order
// is stable across a session lifetime). The `+1` on the torrent side
// preserves the pre-existing convention (0 is reserved because some
// Chromecast firmware treats trackId 0 as "no active track").
export const OS_TRACK_ID_BASE = 10_000;

function trackIdForSubtitle(track: SubtitleTrack, osOffset: number): number {
  if (track.source === "torrent") return track.index + 1;
  // OpenSubtitles — offset is the track's position in the OS result list.
  return OS_TRACK_ID_BASE + osOffset;
}

function urlForSubtitle(
  track: SubtitleTrack,
  ip: string,
  port: number,
  infoHash: string | null,
): string | null {
  if (track.source === "torrent") {
    if (!infoHash) return null;
    return `http://${ip}:${port}/stream/${infoHash}/subtitles/${track.index}`;
  }
  return `http://${ip}:${port}/api/subtitles/opensubtitles/${track.fileId}`;
}

// Extract infoHash from a streamPath like "/stream/abc123" or
// "/stream/abc123/transcoded". Returns null if the path doesn't match.
function infoHashFromStreamPath(streamPath: string): string | null {
  const m = /^\/stream\/([a-f0-9]+)/i.exec(streamPath);
  return m ? m[1]! : null;
}

const VALID_ACTIONS: ReadonlySet<CastAction> = new Set([
  "play",
  "pause",
  "stop",
  "seek",
  "volume",
  "mute",
  "unmute",
]);

interface PlayBody {
  deviceId?: string;
  streamPath?: string;
  title?: string;
  posterUrl?: string;
  contentType?: string;
  /** URL path for a subtitle track (torrent-embedded OR OpenSubtitles) to
   *  activate at cast start. When set, must match the URL suffix of one of
   *  the enumerated tracks. Empty / missing = subtitles off at start. */
  subtitlePath?: string;
  subtitleLanguage?: string;
  subtitleName?: string;
  /** IMDb id — enables the OpenSubtitles fallback branch on cast start
   *  (same as the /stream/:hash/subtitles?imdbId=… query on the picker). */
  imdbId?: string;
}

interface ControlBody {
  sessionId?: string;
  action?: string;
  value?: number;
}

export async function castRoutes(app: FastifyInstance) {
  app.get("/api/cast/devices", async () => ({ devices: listDevices() }));

  app.post<{ Body: PlayBody }>("/api/cast/play", async (req, reply) => {
    const {
      deviceId,
      streamPath,
      title,
      posterUrl,
      contentType,
      subtitlePath,
      subtitleLanguage,
      subtitleName,
      imdbId,
    } = req.body ?? {};
    if (!deviceId || !streamPath || !title) {
      return reply.code(400).send({
        error: "deviceId, streamPath, and title are required",
      });
    }

    // Detect whether streamPath is already an absolute URL (e.g. a debrid CDN link
    // returned by the Stremio HTTP-stream branch in /api/torrent/start).
    const isAbsolute = /^https?:\/\//i.test(streamPath);

    // We need a LAN IP only when the stream URL must be constructed from the
    // relative path, or when a relative subtitle path is being attached.
    const needsLanIp = !isAbsolute || Boolean(subtitlePath);
    let ip: string | null = null;
    if (needsLanIp) {
      ip = getLanIp();
      if (!ip) {
        return reply.code(500).send({
          error: "Could not determine LAN IP for stream URL — is the laptop on a network?",
        });
      }
    }

    const streamUrl = isAbsolute
      ? streamPath
      : `http://${ip!}:${config.port}${streamPath}`;

    try {
      const params: PlayParams = {
        deviceId,
        streamUrl,
        title,
        ...(posterUrl ? { posterUrl } : {}),
        ...(contentType ? { contentType } : {}),
      };

      // Enumerate ALL subtitle tracks on the torrent (plus OpenSubtitles if
      // an imdbId was supplied) upfront, so the receiver can later hot-swap
      // between them via EDIT_TRACKS_INFO without a LOAD/reload. Only applies
      // to torrent-backed sessions (streamPath = /stream/:hash/...);
      // HTTP-stream sessions (Stremio debrid) have no on-disk subtitle files
      // and honour only the explicit subtitlePath if the client attached one.
      //
      // trackId namespaces (see OS_TRACK_ID_BASE / trackIdForSubtitle above):
      //   - Torrent-embedded → `index + 1`
      //   - OpenSubtitles    → `10_000 + offset` in the OS result list
      // The client mirrors this arithmetic when POSTing to
      // /api/cast/sessions/:id/tracks.
      //
      // FALLBACK NOTE: if the torrent is stopped mid-cast, the subtitle
      // stream URLs become unreachable and the Chromecast silently drops
      // the track. OpenSubtitles URLs remain reachable (served from disk
      // cache), so switching OS→OS still works after torrent removal. See
      // "Subtitle track has no fallback if torrent disappears mid-cast".
      const infoHash = infoHashFromStreamPath(streamPath);
      if (infoHash) {
        const listOpts: Parameters<typeof listSubtitles>[1] = {};
        if (imdbId) listOpts.imdbId = imdbId;
        const tracks = await listSubtitles(infoHash, listOpts);
        if (tracks.length > 0) {
          let osOffset = 0;
          params.tracks = tracks.map<PlayTrack>((t) => {
            const url = urlForSubtitle(t, ip!, config.port, infoHash);
            const trackId = trackIdForSubtitle(
              t,
              t.source === "opensubtitles" ? osOffset++ : 0,
            );
            const label = t.source === "opensubtitles" ? t.languageName : t.language;
            return {
              trackId,
              // url can't be null here — torrent tracks always have an
              // infoHash; OS tracks build absolute URLs unconditionally.
              url: url!,
              language: t.language,
              name: label,
            };
          });
        }
      } else if (subtitlePath) {
        // HTTP-stream fallback: honour the explicit subtitlePath passed by
        // the client. We can't enumerate on the server (no torrent), so
        // runtime switching is not supported for these sessions. Use the
        // client-supplied language/name and assign trackId 1 by convention.
        params.tracks = [
          {
            trackId: 1,
            url: `http://${ip!}:${config.port}${subtitlePath}`,
            language: subtitleLanguage ?? "und",
            name: subtitleName ?? "Subtitles",
          },
        ];
      }

      // If the caller passed a specific subtitlePath, activate that track
      // at start; otherwise the receiver loads with subtitles off (empty
      // activeTrackIds — required, not undefined). Match by URL suffix so
      // both torrent (/stream/…) and OS (/api/subtitles/…) shapes work.
      if (subtitlePath && params.tracks) {
        const wanted = params.tracks.find((t) => t.url.endsWith(subtitlePath));
        if (wanted) params.initialActiveTrackId = wanted.trackId;
      }

      const result = await play(params);

      // TODO(stremio): HTTP-stream history not tracked in v1 — would need synthetic ID
      // Record cast start in history. Removal will update this entry rather
      // than appending a duplicate (see DELETE /api/torrent/:infoHash).
      // infoHashFromStreamPath returned null for absolute URLs — the if-guard
      // reuses `infoHash` from the subtitle-enumeration branch above.
      if (infoHash) {
        const m = getMeta(infoHash);
        if (m && !m.historyId) {
          const status = await getStatus(infoHash);
          const now = new Date().toISOString();
          const historyId = randomUUID();
          await appendHistory({
            id: historyId,
            title: m.title,
            posterUrl: m.posterUrl,
            imdbId: m.imdbId,
            resolution: m.resolution,
            videoName: status?.name ?? title,
            startedAt: m.startedAt,
            endedAt: now,
            completed: false,
          });
          setMetaHistoryId(infoHash, historyId);
        }
      }

      return { ...result, streamUrl };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "cast failed";
      const status = msg.startsWith("device not found") ? 404 : 500;
      return reply.code(status).send({ error: msg });
    }
  });

  app.post<{ Body: ControlBody }>("/api/cast/control", async (req, reply) => {
    const { sessionId, action, value } = req.body ?? {};
    if (!sessionId || !action || !VALID_ACTIONS.has(action as CastAction)) {
      return reply.code(400).send({
        error: "sessionId and a valid action (play|pause|stop|seek|volume) are required",
      });
    }
    try {
      await control(sessionId, action as CastAction, value);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "control failed";
      return reply.code(500).send({ error: msg });
    }
  });

  app.get<{ Params: { sessionId: string } }>(
    "/api/cast/sessions/:sessionId",
    async (req, reply) => {
      const s = getSession(req.params.sessionId);
      if (!s) return reply.code(404).send({ error: "not found" });
      return s;
    },
  );

  // Hot-swap the active subtitle track set on a live cast session.
  // Body: { activeTrackIds: number[] }. Empty array disables subtitles.
  // The receiver requires every id to have been in the initial LOAD's
  // `tracks` array (see /api/cast/play), so we validate first.
  //
  // Returns:
  //   200 { ok: true }       — swap accepted (receiver applied it)
  //   400 { error }          — malformed body or an id not in the session
  //   404 { error }          — sessionId doesn't exist / already stopped
  //   500 { error }          — the receiver refused (rare — usually a
  //                            transient connection error)
  app.post<{
    Params: { sessionId: string };
    Body: Partial<SetActiveTracksRequest>;
  }>("/api/cast/sessions/:sessionId/tracks", async (req, reply) => {
    const ids = req.body?.activeTrackIds;
    if (!Array.isArray(ids) || ids.some((n) => !Number.isInteger(n))) {
      return reply.code(400).send({
        error: "activeTrackIds must be an array of integers (empty to disable)",
      });
    }
    try {
      await setActiveTracks(req.params.sessionId, ids);
      return { ok: true };
    } catch (err) {
      if (err instanceof CastSessionNotFoundError) {
        return reply.code(404).send({ error: err.message });
      }
      if (err instanceof UnknownTrackIdError) {
        return reply.code(400).send({ error: err.message });
      }
      const msg = err instanceof Error ? err.message : "editTracksInfo failed";
      return reply.code(500).send({ error: msg });
    }
  });
}
