import { randomUUID } from "node:crypto";
import type { CastAction, CastSessionState, CastSessionStatus } from "@castcrate/shared";
import { listDevices } from "./discovery.js";
import { broadcast } from "./events.js";

interface DefaultMediaReceiver {
  on(event: "status" | "close", cb: (...args: unknown[]) => void): void;
  load(media: MediaPayload, options: { autoplay: boolean }, cb: (err: Error | null, status: unknown) => void): void;
  play(cb?: (err: Error | null) => void): void;
  pause(cb?: (err: Error | null) => void): void;
  stop(cb?: (err: Error | null) => void): void;
  seek(seconds: number, cb?: (err: Error | null) => void): void;
  setVolume(volume: { level?: number; muted?: boolean }, cb?: (err: Error | null) => void): void;
  /** Round-trip probe against the receiver. Errors or hangs indicate the
   *  device is unreachable. See docs/features/castcrate/chromecast/context.md. */
  getStatus(cb: (err: Error | null, status: unknown) => void): void;
  close(): void;
}

interface CastClient {
  on(event: "error" | "close", cb: (err?: Error) => void): void;
  connect(host: string | { host: string; port: number }, cb: () => void): void;
  launch(app: unknown, cb: (err: Error | null, player: DefaultMediaReceiver) => void): void;
  close(): void;
}

interface MediaTextTrack {
  trackId: number;
  type: "TEXT";
  trackContentId: string;
  trackContentType: string;
  name: string;
  language: string;
  subtype: "SUBTITLES" | "CAPTIONS";
}

interface MediaPayload {
  contentId: string;
  contentType: string;
  streamType: "BUFFERED" | "LIVE";
  tracks?: MediaTextTrack[];
  metadata?: {
    type: number;
    metadataType: number;
    title: string;
    images?: { url: string }[];
  };
}

interface CastModule {
  Client: new () => CastClient;
  DefaultMediaReceiver: unknown;
}

let castModule: Promise<CastModule> | null = null;
function getCastModule(): Promise<CastModule> {
  if (!castModule) {
    castModule = (async () => {
      // castv2-client is CommonJS; default-import via dynamic import
      const mod = (await import("castv2-client")) as unknown as CastModule | { default: CastModule };
      return "default" in mod ? mod.default : (mod as CastModule);
    })();
  }
  return castModule;
}

interface Session {
  sessionId: string;
  deviceId: string;
  deviceName: string;
  client: CastClient;
  player: DefaultMediaReceiver;
  status: CastSessionState;
  currentTime: number;
  duration: number;
  volumeLevel: number;
  muted: boolean;
  /** Heartbeat interval handle; cleared on stop or on flip to disconnected. */
  heartbeatTimer: NodeJS.Timeout | null;
  /** Count of consecutive failed probes. Reset to 0 on each success. */
  heartbeatFailures: number;
}

const sessions = new Map<string, Session>();

// --- Heartbeat -----------------------------------------------------------
//
// castv2-client only emits `player.on("close")` when the connection is
// closed cleanly (stop, or the receiver actively disconnects). If the
// Chromecast is unplugged, the TV loses HDMI-CEC/power, or the LAN drops,
// the TCP connection hangs and neither `close` nor `error` fires. Sessions
// then live forever in the map with a stale timeline, and the UI polls
// against them indefinitely.
//
// Fix: every HEARTBEAT_INTERVAL_MS, issue a real receiver round-trip
// (MediaController.GET_STATUS via DefaultMediaReceiver.getStatus). Wrap it
// in HEARTBEAT_TIMEOUT_MS since the underlying request/response controller
// has no timeout of its own and will wait forever for a reply that never
// comes. After HEARTBEAT_MAX_FAILURES consecutive failures, flip the
// session to "disconnected", broadcast the WS event, and stop probing.

/** How often to probe an active session. */
const HEARTBEAT_INTERVAL_MS = 30_000;
/** How long to wait for a single getStatus round-trip before treating it as a failure. */
const HEARTBEAT_TIMEOUT_MS = 5_000;
/** N consecutive failures before the session flips to `"disconnected"`. */
const HEARTBEAT_MAX_FAILURES = 2;

function stopHeartbeat(session: Session): void {
  if (session.heartbeatTimer) {
    clearInterval(session.heartbeatTimer);
    session.heartbeatTimer = null;
  }
}

function markDisconnected(session: Session): void {
  if (session.status === "disconnected") return;
  session.status = "disconnected";
  stopHeartbeat(session);
  broadcast({
    type: "cast:disconnected",
    sessionId: session.sessionId,
    deviceName: session.deviceName,
  });
  // Also push a status event so any client that was already displaying the
  // session (via the cast:status cache key) sees the flipped state without
  // needing a separate handler.
  broadcast({ type: "cast:status", session: serialiseSession(session) });
  // Best-effort: tear down the underlying client. If the socket is truly
  // dead this will no-op or throw; either is fine.
  try {
    session.client.close();
  } catch {
    /* ignore — connection is already gone */
  }
  // Leave the session entry in the map so GET /api/cast/sessions/:id keeps
  // returning `status: "disconnected"` until the UI stops or refreshes.
  // The web client is responsible for issuing DELETE (via castControl stop)
  // to clear it out; the stop path already deletes the entry.
}

function probeOnce(session: Session): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("heartbeat timeout"));
    }, HEARTBEAT_TIMEOUT_MS);
    try {
      session.player.getStatus((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      });
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function startHeartbeat(session: Session): void {
  if (session.heartbeatTimer) return;
  const timer = setInterval(() => {
    // If the session has already been removed (e.g. stop raced with
    // the interval firing), bail out.
    if (!sessions.has(session.sessionId)) {
      stopHeartbeat(session);
      return;
    }
    void probeOnce(session)
      .then(() => {
        session.heartbeatFailures = 0;
      })
      .catch(() => {
        session.heartbeatFailures += 1;
        if (session.heartbeatFailures >= HEARTBEAT_MAX_FAILURES) {
          markDisconnected(session);
        }
      });
  }, HEARTBEAT_INTERVAL_MS);
  // Don't hold the event loop open just for heartbeats.
  timer.unref?.();
  session.heartbeatTimer = timer;
}

export interface PlayTrack {
  url: string;
  language: string;
  name: string;
}

export interface PlayParams {
  deviceId: string;
  streamUrl: string;
  title: string;
  posterUrl?: string;
  contentType?: string;
  /** Optional subtitle tracks (VTT). Only the first track is enabled by default. */
  tracks?: PlayTrack[];
}

export async function play(params: PlayParams): Promise<{ sessionId: string }> {
  const device = listDevices().find((d) => d.id === params.deviceId);
  if (!device) {
    throw new Error(`device not found: ${params.deviceId}`);
  }
  const { Client, DefaultMediaReceiver } = await getCastModule();
  const client = new Client();

  await new Promise<void>((resolve, reject) => {
    client.on("error", reject);
    client.connect({ host: device.ip, port: device.port }, () => resolve());
  });

  const player = await new Promise<DefaultMediaReceiver>((resolve, reject) => {
    client.launch(DefaultMediaReceiver, (err, p) => (err ? reject(err) : resolve(p)));
  });

  const tracks: MediaTextTrack[] | undefined = params.tracks?.map((t, i) => ({
    trackId: i + 1,
    type: "TEXT",
    trackContentId: t.url,
    trackContentType: "text/vtt",
    name: t.name,
    language: t.language,
    subtype: "SUBTITLES",
  }));

  const media: MediaPayload = {
    contentId: params.streamUrl,
    contentType: params.contentType ?? "video/mp4",
    streamType: "BUFFERED",
    ...(tracks && tracks.length > 0 ? { tracks } : {}),
    metadata: {
      type: 0,
      metadataType: 1, // Movie
      title: params.title,
      images: params.posterUrl ? [{ url: params.posterUrl }] : [],
    },
  };

  const loadOptions: { autoplay: boolean; activeTrackIds?: number[] } = {
    autoplay: true,
  };
  if (tracks && tracks.length > 0) loadOptions.activeTrackIds = [1];

  await new Promise<void>((resolve, reject) => {
    player.load(
      media,
      loadOptions as { autoplay: boolean },
      (err) => (err ? reject(err) : resolve()),
    );
  });

  const sessionId = randomUUID();
  const session: Session = {
    sessionId,
    deviceId: params.deviceId,
    deviceName: device.name,
    client,
    player,
    status: "playing",
    currentTime: 0,
    duration: 0,
    volumeLevel: 1,
    muted: false,
    heartbeatTimer: null,
    heartbeatFailures: 0,
  };
  sessions.set(sessionId, session);

  player.on("status", (...args: unknown[]) => {
    const status = args[0] as
      | {
          playerState?: string;
          currentTime?: number;
          media?: { duration?: number };
          volume?: { level?: number; muted?: boolean };
        }
      | undefined;
    if (!status) return;
    // Any inbound status is proof of life — reset the failure counter. This
    // catches the case where the receiver is chatty but a single probe
    // happened to time out (e.g. network hiccup).
    session.heartbeatFailures = 0;
    // Don't clobber the `disconnected` state — once we've decided a session
    // is dead, a stray late-arriving status shouldn't resurrect it.
    if (session.status !== "disconnected") {
      if (status.playerState === "PLAYING") session.status = "playing";
      else if (status.playerState === "PAUSED") session.status = "paused";
      else if (status.playerState === "BUFFERING") session.status = "buffering";
    }
    if (typeof status.currentTime === "number") session.currentTime = status.currentTime;
    if (typeof status.media?.duration === "number") session.duration = status.media.duration;
    if (status.volume) {
      if (typeof status.volume.level === "number")
        session.volumeLevel = status.volume.level;
      if (typeof status.volume.muted === "boolean") session.muted = status.volume.muted;
    }
    broadcast({ type: "cast:status", session: serialiseSession(session) });
  });

  player.on("close", () => {
    stopHeartbeat(session);
    session.status = "stopped";
    sessions.delete(sessionId);
    broadcast({ type: "cast:closed", sessionId });
  });

  startHeartbeat(session);

  return { sessionId };
}

export async function control(
  sessionId: string,
  action: CastAction,
  value?: number,
): Promise<void> {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("session not found");

  // A disconnected session's underlying TCP connection is dead; issuing
  // most controls against it will hang forever (see request-response.js
  // — no timeout). Stop is the only sensible action: tear down local
  // state and let the caller move on. Everything else should fail fast.
  if (s.status === "disconnected") {
    if (action === "stop") {
      stopHeartbeat(s);
      sessions.delete(sessionId);
      broadcast({ type: "cast:closed", sessionId });
      try {
        s.client.close();
      } catch {
        /* ignore — already gone */
      }
      return;
    }
    throw new Error("session is disconnected — issue stop to clear it");
  }

  await new Promise<void>((resolve, reject) => {
    const cb = (err: Error | null) => (err ? reject(err) : resolve());
    if (action === "play") s.player.play(cb);
    else if (action === "pause") s.player.pause(cb);
    else if (action === "stop") {
      stopHeartbeat(s);
      s.player.stop(cb);
      s.client.close();
      s.status = "stopped";
      sessions.delete(sessionId);
    } else if (action === "seek") s.player.seek(value ?? 0, cb);
    else if (action === "volume") {
      const level = Math.max(0, Math.min(1, value ?? 0));
      s.volumeLevel = level;
      s.player.setVolume({ level }, cb);
    } else if (action === "mute") {
      s.muted = true;
      s.player.setVolume({ muted: true }, cb);
    } else if (action === "unmute") {
      s.muted = false;
      s.player.setVolume({ muted: false }, cb);
    } else {
      reject(new Error(`unknown action: ${action}`));
    }
  });
}

function serialiseSession(s: Session): CastSessionStatus {
  return {
    sessionId: s.sessionId,
    deviceId: s.deviceId,
    deviceName: s.deviceName,
    status: s.status,
    currentTime: s.currentTime,
    duration: s.duration,
    volumeLevel: s.volumeLevel,
    muted: s.muted,
  };
}

export function getSession(sessionId: string): CastSessionStatus | null {
  const s = sessions.get(sessionId);
  if (!s) return null;
  return serialiseSession(s);
}

export async function shutdownCast(): Promise<void> {
  for (const s of sessions.values()) {
    // Clear heartbeat interval first — if we tear the client down while a
    // probe is in flight, the interval keeps referencing the dead session
    // (would only matter if unref() didn't take, but be defensive).
    stopHeartbeat(s);
    try {
      s.client.close();
    } catch {
      /* ignore */
    }
  }
  sessions.clear();
}
