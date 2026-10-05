import { attachGateway } from "./gateway.js";
import { createServer } from "node:http";
import { parse } from "cookie";
import express from "express";
import nodemailer from "nodemailer";
import { WebSocketServer, WebSocket } from "ws";
import { fileURLToPath } from "node:url";
import { z, messageSchema } from "@charoo/contracts";
import { config } from "./config.js";
import { database } from "./database.js";
import { realtime } from "./realtime.js";
import { app } from "./app.js";
import { hash } from "./crypto.js";
import {
  member,
  user,
  sendMessage,
  blocked,
  cleanup,
  eligible,
  type Context,
} from "./domain.js";
import { deleteObjects, endLiveKitCall } from "./providers.js";
const cfg = config(),
  db = database(cfg.databaseUrl),
  rt = realtime(cfg.redisUrl);
const mailer = cfg.smtpUrl ? nodemailer.createTransport(cfg.smtpUrl) : null;
const ctx: Context = {
  config: cfg,
  db,
  rt,
  endCall: endLiveKitCall,
  mail: async (email, url) => {
    if (!mailer) throw new Error("Email not configured");
    await mailer.sendMail({
      from: cfg.emailFrom,
      to: email,
      subject: "Your Charoo sign-in link",
      text: `Sign in or verify your email: ${url}\nThis link expires in 15 minutes. If you did not request it, ignore this message.`,
    });
  },
};
const application = app(ctx);
const webRoot = fileURLToPath(new URL("../../web/dist/", import.meta.url));
application.use(
  express.static(webRoot, {
    index: false,
    setHeaders: (res, path) => {
      res.setHeader(
        "Cache-Control",
        path.endsWith("sw.js") ? "no-cache" : "public, max-age=3600",
      );
    },
  }),
);
application.get("/{*path}", (_req, res) =>
  res.sendFile(`${webRoot}/index.html`),
);
const server = createServer(application);
const gateway = attachGateway(server, ctx);
let running = false;
const timer = setInterval(async () => {
  if (running) return;
  running = true;
  try {
    await cleanup(ctx);
    if (process.env.S3_BUCKET) await deleteObjects(ctx);
    for (const c of (
      await db.query(
        "SELECT id FROM calls WHERE state='ENDED' AND media_terminated=false ORDER BY created_at DESC LIMIT 100",
      )
    ).rows) {
      try {
        await endLiveKitCall(c.id);
        await db.query("UPDATE calls SET media_terminated=true WHERE id=$1", [
          c.id,
        ]);
      } catch {}
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "cleanup.failed",
        code: (error as any).code || "INTERNAL",
      }),
    );
  } finally {
    running = false;
  }
}, 60000);
timer.unref();
server.listen(cfg.port, () =>
  console.info(JSON.stringify({ event: "server.started", port: cfg.port })),
);
process.on("SIGTERM", () => {
  clearInterval(timer);
  gateway.stop();
  server.close(() => process.exit(0));
});
