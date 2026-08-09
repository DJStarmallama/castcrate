import { randomUUID } from "node:crypto";
import type { CastAction } from "@castcrate/shared";
import { listDevices } from "./discovery.js";
import { broadcast } from "./events.js";

interface MediaController {
  /** Sends a Media Namespace request with the currentSession's mediaSessionId
   *  automatically attached. Used for EDIT_TRACKS_INFO (not exposed as a
   *  first-class method on DefaultMediaReceiver in castv2-client 1.2.0). */
  sessionRequest(data: Record<string, unknown>, cb?: (err: Error | null, status?: unknown) => void): void;
}

interface DefaultMediaReceiver {
  on(event: "status" | "close", cb: (...args: unknown[]) => void): void;
  load(media: MediaPayload, options: { autoplay: boolean }, cb: (err: Error | null, status: unknown) => void): void;
  play(cb?: (err: Error | null) => void): void;
  pause(cb?: (err: Error | null) => void): void;
  stop(cb?: (err: Error | null) => void): void;
  seek(seconds: number, cb?: (err: Error | null) => void): void;
  setVolume(volume: { level?: number; muted?: boolean }, cb?: (err: Error | null) => void): void;
  close(): void;
  /** Sub-controller exposed by DefaultMediaReceiver — needed for messages the
   *  wrapper doesn't proxy (EDIT_TRACKS_INFO). See castv2-client/lib/senders/
   *  default-media-receiver.js. */
  media: MediaController;
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
  client: CastClient;
  player: DefaultMediaReceiver;
  status: "buffering" | "playing" | "paused" | "stopped";
  currentTime: number;
  duration: number;
  volumeLevel: number;
  muted: boolean;
  /** Chromecast trackIds that were passed in the initial LOAD payload.
   *  Used to validate hot-swap requests to `setActiveTracks`. */
  knownTrackIds: Set<number>;
}

const sessions = new Map<string, Session>();

export interface PlayTrack {
  /** Stable trackId used by the Chromecast to reference this track in
   *  `activeTrackIds`. Convention: `subtitleIndex + 1` so the caller can
   *  map from SubtitleTrack.index → trackId trivially. Must be > 0 (some
   *  receivers treat 0 as "no track"). */
  trackId: number;
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
  /** Full list of subtitle tracks (VTT) to advertise to the receiver. Pass
   *  ALL known tracks upfront — the receiver refuses to activate a trackId
   *  that wasn't in the initial LOAD payload, so on-the-fly switching
   *  requires enumerating everything now. */
  tracks?: PlayTrack[];
  /** trackId to enable at start. `undefined` or missing → no subtitles.
   *  Must be a trackId that appears in `tracks`. */
  initialActiveTrackId?: number;
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

  const tracks: MediaTextTrack[] | undefined = params.tracks?.map((t) => ({
    trackId: t.trackId,
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

  // activeTrackIds MUST be an array (never undefined) — the receiver rejects
  // undefined. Empty array = subtitles off. Only enable the requested initial
  // track if it's actually one of the tracks we advertised.
  const knownTrackIds = new Set<number>(tracks?.map((t) => t.trackId) ?? []);
  const activeTrackIds: number[] =
    params.initialActiveTrackId !== undefined &&
    knownTrackIds.has(params.initialActiveTrackId)
      ? [params.initialActiveTrackId]
      : [];

  const loadOptions: { autoplay: boolean; activeTrackIds: number[] } = {
    autoplay: true,
    activeTrackIds,
  };

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
    client,
    player,
    status: "playing",
    currentTime: 0,
    duration: 0,
    volumeLevel: 1,
    muted: false,
    knownTrackIds,
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
    if (status.playerState === "PLAYING") session.status = "playing";
    else if (status.playerState === "PAUSED") session.status = "paused";
    else if (status.playerState === "BUFFERING") session.status = "buffering";
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
    session.status = "stopped";
    sessions.delete(sessionId);
    broadcast({ type: "cast:closed", sessionId });
  });

  return { sessionId };
}

/** Thrown when a caller references a sessionId that isn't in memory. Routes
 *  should map this to 404. */
export class CastSessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`session not found: ${sessionId}`);
    this.name = "CastSessionNotFoundError";
  }
}

/** Thrown when a caller tries to activate a trackId the session doesn't know
 *  about (i.e. wasn't passed in the initial LOAD payload). Routes should map
 *  this to 400. */
export class UnknownTrackIdError extends Error {
  constructor(unknown: number[]) {
    super(`unknown trackId(s): ${unknown.join(", ")}`);
    this.name = "UnknownTrackIdError";
  }
}

/**
 * Hot-swap the active subtitle track set on a live cast session. Sends an
 * EDIT_TRACKS_INFO Media Namespace message, which the receiver honours
 * without pausing or reloading — the requirement is that every trackId
 * passed in `activeTrackIds` was in the tracks array of the original LOAD.
 *
 * Pass `[]` to disable all subtitles. The receiver rejects `undefined`.
 */
export async function setActiveTracks(
  sessionId: string,
  activeTrackIds: number[],
): Promise<void> {
  const s = sessions.get(sessionId);
  if (!s) throw new CastSessionNotFoundError(sessionId);
  const unknown = activeTrackIds.filter((id) => !s.knownTrackIds.has(id));
  if (unknown.length > 0) throw new UnknownTrackIdError(unknown);
  await new Promise<void>((resolve, reject) => {
    s.player.media.sessionRequest(
      { type: "EDIT_TRACKS_INFO", activeTrackIds },
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

export async function control(
  sessionId: string,
  action: CastAction,
  value?: number,
): Promise<void> {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("session not found");
  await new Promise<void>((resolve, reject) => {
    const cb = (err: Error | null) => (err ? reject(err) : resolve());
    if (action === "play") s.player.play(cb);
    else if (action === "pause") s.player.pause(cb);
    else if (action === "stop") {
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

import type { CastSessionStatus } from "@castcrate/shared";

function serialiseSession(s: Session): CastSessionStatus {
  return {
    sessionId: s.sessionId,
    deviceId: s.deviceId,
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
    try {
      s.client.close();
    } catch {
      /* ignore */
    }
  }
  sessions.clear();
}
