import { randomUUID } from "node:crypto";
import type { CastAction } from "@castcrate/shared";
import { listDevices } from "./discovery.js";

interface DefaultMediaReceiver {
  on(event: "status" | "close", cb: (...args: unknown[]) => void): void;
  load(media: MediaPayload, options: { autoplay: boolean }, cb: (err: Error | null, status: unknown) => void): void;
  play(cb?: (err: Error | null) => void): void;
  pause(cb?: (err: Error | null) => void): void;
  stop(cb?: (err: Error | null) => void): void;
  seek(seconds: number, cb?: (err: Error | null) => void): void;
  setVolume(volume: { level?: number; muted?: boolean }, cb?: (err: Error | null) => void): void;
  close(): void;
}

interface CastClient {
  on(event: "error" | "close", cb: (err?: Error) => void): void;
  connect(host: string | { host: string; port: number }, cb: () => void): void;
  launch(app: unknown, cb: (err: Error | null, player: DefaultMediaReceiver) => void): void;
  close(): void;
}

interface MediaPayload {
  contentId: string;
  contentType: string;
  streamType: "BUFFERED" | "LIVE";
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
}

const sessions = new Map<string, Session>();

export interface PlayParams {
  deviceId: string;
  streamUrl: string;
  title: string;
  posterUrl?: string;
  contentType?: string;
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

  const media: MediaPayload = {
    contentId: params.streamUrl,
    contentType: params.contentType ?? "video/mp4",
    streamType: "BUFFERED",
    metadata: {
      type: 0,
      metadataType: 1, // Movie
      title: params.title,
      images: params.posterUrl ? [{ url: params.posterUrl }] : [],
    },
  };

  await new Promise<void>((resolve, reject) => {
    player.load(media, { autoplay: true }, (err) => (err ? reject(err) : resolve()));
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
  });

  player.on("close", () => {
    session.status = "stopped";
    sessions.delete(sessionId);
  });

  return { sessionId };
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

export function getSession(sessionId: string): CastSessionStatus | null {
  const s = sessions.get(sessionId);
  if (!s) return null;
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
