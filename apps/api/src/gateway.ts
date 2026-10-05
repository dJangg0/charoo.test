import type { Server } from "node:http";
import { parse } from "cookie";
import { WebSocketServer, WebSocket } from "ws";
import { z, messageSchema } from "@charoo/contracts";
import { hash } from "./crypto.js";
import {
  member,
  user,
  sendMessage,
  blocked,
  eligible,
  type Context,
} from "./domain.js";
export function attachGateway(server: Server, ctx: Context) {
  const { db, rt, config: cfg } = ctx;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  const sockets = new Map<
    WebSocket,
    {
      userId: string;
      tokenHash: string;
      rooms: Set<string>;
      discovery: boolean;
    }
  >();
  server.on("upgrade", async (req, socket, head) => {
    try {
      if (req.headers.origin !== cfg.origin || req.url !== "/api/ws")
        throw new Error("Origin");
      const t = parse(req.headers.cookie || "").charoo_session;
      if (!t) throw new Error("Session");
      const s = (
        await db.query(
          "SELECT * FROM sessions WHERE token_hash=$1 AND expires_at>now()",
          [hash(t)],
        )
      ).rows[0];
      if (!s) throw new Error("Session");
      await user(db, s.user_id);
      if (!(await rt.limit(`ws:${s.user_id}`, 20, 60))) throw new Error("Rate");
      wss.handleUpgrade(req, socket, head, (ws) => {
        sockets.set(ws, {
          userId: s.user_id,
          tokenHash: hash(t),
          rooms: new Set(),
          discovery: false,
        });
        wss.emit("connection", ws);
      });
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
    }
  });
  const send = (ws: WebSocket, event: unknown) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 256000) {
      ws.close(1013, "Reconnect to load history");
      return;
    }
    ws.send(JSON.stringify(event));
  };
  async function authorizedSession(ws: WebSocket) {
    const state = sockets.get(ws)!;
    const s = (
      await db.query(
        "SELECT 1 FROM sessions WHERE token_hash=$1 AND expires_at>now()",
        [state.tokenHash],
      )
    ).rows[0];
    if (!s) throw new Error("Session expired");
    return user(db, state.userId);
  }
  wss.on("connection", (ws) => {
    const state = sockets.get(ws)!;
    ws.on("close", () => sockets.delete(ws));
    ws.on("error", () => ws.close());
    ws.on("message", async (data) => {
      try {
        const u = await authorizedSession(ws);
        if (!(await rt.limit(`ws-event:${u.id}`, 100, 60)))
          throw new Error("Too many events");
        const input = z
          .object({
            type: z.enum([
              "subscribe",
              "unsubscribe",
              "message",
              "typing",
              "ping",
              "discovery",
            ]),
            roomId: z.string().uuid().optional(),
            payload: z.unknown().optional(),
          })
          .parse(JSON.parse(data.toString()));
        if (input.type === "ping") {
          send(ws, { type: "pong" });
          return;
        }
        if (input.type === "discovery") {
          if (input.payload === true) await eligible(ctx, u);
          state.discovery = input.payload === true;
          return;
        }
        if (!input.roomId) throw new Error("Room required");
        if (input.type === "unsubscribe") {
          state.rooms.delete(input.roomId);
          return;
        }
        const room = await member(
          db,
          input.roomId,
          u.id,
          input.type !== "subscribe",
        );
        if (room.type === "AVAILABLE_TONIGHT") await eligible(ctx, u);
        if (input.type === "subscribe") {
          if (state.rooms.size >= 10) throw new Error("Too many subscriptions");
          state.rooms.add(input.roomId);
          send(ws, { type: "subscribed", roomId: input.roomId });
        }
        if (input.type === "message") {
          if (!(await rt.limit(`message:${u.id}`, 40, 60)))
            throw new Error("Message limit reached");
          const result = await sendMessage(
            ctx,
            u,
            input.roomId,
            messageSchema.parse(input.payload),
          );
          send(ws, {
            type: "ack",
            payload: {
              ...result,
              clientMessageId: messageSchema.parse(input.payload)
                .clientMessageId,
            },
          });
        }
        if (input.type === "typing" && (await rt.limit(`typing:${u.id}`, 2, 2)))
          await rt.publish({
            type: "typing",
            roomId: input.roomId,
            payload: { userId: u.id },
          });
      } catch (error) {
        send(ws, {
          type: "error",
          payload: {
            message: error instanceof Error ? error.message : "Invalid event",
          },
        });
      }
    });
  });
  rt.subscribe(async (event) => {
    for (const [ws, state] of sockets) {
      if (event.type === "discovery.changed" && !state.discovery) continue;
      if (event.userIds && !event.userIds.includes(state.userId)) continue;
      if (event.roomId && !state.rooms.has(event.roomId)) continue;
      if (
        !event.roomId &&
        !event.userIds &&
        !["discovery.changed"].includes(event.type)
      )
        continue;
      try {
        const u = await authorizedSession(ws);
        if (event.roomId && event.type !== "room.closed") {
          const room = await member(db, event.roomId, state.userId);
          if (room.type === "AVAILABLE_TONIGHT") await eligible(ctx, u);
        }
        if (
          event.type === "typing" &&
          event.payload &&
          (await blocked(db, state.userId, (event.payload as any).userId))
        )
          continue;
        send(ws, event);
      } catch {
        if (event.roomId) state.rooms.delete(event.roomId);
        else ws.close(1008, "Session unavailable");
      }
    }
  });
  const heartbeats = setInterval(async () => {
    for (const [ws, state] of sockets) {
      try {
        await authorizedSession(ws);
        ws.ping();
      } catch {
        ws.close(1008, "Session expired");
        sockets.delete(ws);
      }
    }
  }, 30000);
  heartbeats.unref();
  return {
    wss,
    stop: () => {
      clearInterval(heartbeats);
      wss.clients.forEach((ws) => ws.terminate());
      wss.close();
    },
  };
}
