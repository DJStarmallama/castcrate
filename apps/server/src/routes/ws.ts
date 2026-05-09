import type { FastifyInstance } from "fastify";
import { addSocket } from "../services/events.js";

interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: "close" | "error", cb: () => void): void;
}

export async function wsRoutes(app: FastifyInstance) {
  app.get("/ws", { websocket: true }, (socket: SocketLike) => {
    addSocket(socket);
  });
}
