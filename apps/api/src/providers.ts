import type { Express } from "express";
import { randomUUID } from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { z } from "@charoo/contracts";
import {
  type Context,
  member,
  settings,
  eligible,
  blocked,
  audit,
} from "./domain.js";
import { requireThat } from "./errors.js";
const s3 = (publicUrl = false) =>
  new S3Client({
    endpoint:
      (publicUrl
        ? process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT
        : process.env.S3_ENDPOINT) || undefined,
    region: process.env.S3_REGION || "us-east-1",
    forcePathStyle: !!process.env.S3_ENDPOINT,
    credentials: process.env.S3_ACCESS_KEY
      ? {
          accessKeyId: process.env.S3_ACCESS_KEY,
          secretAccessKey: process.env.S3_SECRET_KEY || "",
        }
      : undefined,
  });
const bucket = () => process.env.S3_BUCKET || "charoo";
export function mediaRoutes(app: Express, ctx: Context) {
  app.post("/api/media/init", async (req, res) => {
    const input = z
      .object({
        roomId: z.string().uuid(),
        name: z
          .string()
          .min(1)
          .max(120)
          .regex(/^[\p{L}\p{N}_. ()-]+$/u),
        mime: z.enum([
          "image/jpeg",
          "image/png",
          "image/gif",
          "image/webp",
          "video/mp4",
          "video/webm",
          "audio/webm",
          "audio/mpeg",
          "application/pdf",
        ]),
        size: z.number().int().positive(),
      })
      .parse(req.body);
    const room = await member(ctx.db, input.roomId, res.locals.user.id, true),
      cfg = await settings(ctx.db);
    requireThat(
      process.env.MEDIA_SCANNER_URL &&
        process.env.MEDIA_SCANNER_TOKEN &&
        process.env.S3_BUCKET,
      503,
      "Media scanning is not configured",
    );
    requireThat(
      input.size <= cfg.upload_size_limit_mb * 1024 * 1024,
      400,
      "File too large",
    );
    if (room.type === "AVAILABLE_TONIGHT") {
      await eligible(ctx, res.locals.user);
      requireThat(
        cfg.available_room_media_enabled,
        403,
        "Media is disabled in public rooms",
      );
    }
    requireThat(
      await ctx.rt.limit(`upload:${res.locals.user.id}`, 10, 3600),
      429,
      "Upload limit reached",
    );
    const id = randomUUID(),
      key = `quarantine/${room.id}/${id}`;
    await ctx.db.query(
      "INSERT INTO attachments(id,room_id,uploader_id,object_key,name,mime,size) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        id,
        room.id,
        res.locals.user.id,
        key,
        input.name,
        input.mime,
        input.size,
      ],
    );
    const url = await getSignedUrl(
      s3(true),
      new PutObjectCommand({
        Bucket: bucket(),
        Key: key,
        ContentType: input.mime,
        ContentLength: input.size,
      }),
      { expiresIn: 300 },
    );
    res.status(201).json({ id, url });
  });
  app.post("/api/media/:id/complete", async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const a = (
      await ctx.db.query(
        "SELECT * FROM attachments WHERE id=$1 AND uploader_id=$2",
        [id, res.locals.user.id],
      )
    ).rows[0];
    requireThat(a, 404, "Attachment unavailable");
    await member(ctx.db, a.room_id, res.locals.user.id, true);
    requireThat(
      process.env.MEDIA_SCANNER_URL && process.env.MEDIA_SCANNER_TOKEN,
      503,
      "Scanner unavailable",
    );
    requireThat(a.state === "PENDING", 409, "Attachment already processed");
    const head = await s3().send(
      new HeadObjectCommand({ Bucket: bucket(), Key: a.object_key }),
    );
    requireThat(
      head.ContentLength === a.size && head.ContentType === a.mime,
      400,
      "Upload metadata mismatch",
    );
    const readUrl = await getSignedUrl(
      s3(true),
      new GetObjectCommand({ Bucket: bucket(), Key: a.object_key }),
      { expiresIn: 300 },
    );
    const approvedKey = `approved/${a.room_id}/${a.id}`;
    const writeUrl = await getSignedUrl(
      s3(true),
      new PutObjectCommand({
        Bucket: bucket(),
        Key: approvedKey,
        ContentType: a.mime,
      }),
      { expiresIn: 300 },
    );
    const response = await fetch(process.env.MEDIA_SCANNER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.MEDIA_SCANNER_TOKEN}`,
      },
      body: JSON.stringify({
        url: readUrl,
        writeUrl,
        mime: a.mime,
        size: a.size,
        stripMetadata: true,
      }),
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
    requireThat(response.ok, 503, "Scanner unavailable");
    const result = z
      .object({
        clean: z.boolean(),
        magicBytesValid: z.boolean(),
        metadataStripped: z.boolean(),
        contentSafe: z.boolean(),
      })
      .parse(await response.json());
    const approved =
      result.clean &&
      result.magicBytesValid &&
      result.metadataStripped &&
      result.contentSafe;
    if (approved) {
      const checked = await s3().send(
        new HeadObjectCommand({ Bucket: bucket(), Key: approvedKey }),
      );
      requireThat(
        checked.ContentLength &&
          checked.ContentLength <=
            (await settings(ctx.db)).upload_size_limit_mb * 1024 * 1024 &&
          checked.ContentType === a.mime,
        400,
        "Sanitized upload invalid",
      );
      await ctx.db.query(
        "UPDATE attachments SET state='APPROVED',object_key=$2,size=$3 WHERE id=$1",
        [id, approvedKey, checked.ContentLength],
      );
      await ctx.db.query(
        "INSERT INTO object_deletions(object_key) VALUES($1) ON CONFLICT DO NOTHING",
        [a.object_key],
      );
    } else
      await ctx.db.query(
        "UPDATE attachments SET state='REJECTED' WHERE id=$1",
        [id],
      );
    if (!approved) {
      await ctx.db.query(
        "INSERT INTO object_deletions(object_key) VALUES($1) ON CONFLICT DO NOTHING",
        [a.object_key],
      );
      requireThat(false, 400, "Attachment rejected by safety scanning");
    }
    res.json({ id, state: "APPROVED" });
  });
  app.get("/api/media/:id/download", async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const a = (
      await ctx.db.query(
        "SELECT * FROM attachments WHERE id=$1 AND state='APPROVED'",
        [id],
      )
    ).rows[0];
    requireThat(a, 404, "Attachment unavailable");
    await member(ctx.db, a.room_id, res.locals.user.id);
    requireThat(
      !(await blocked(ctx.db, res.locals.user.id, a.uploader_id)),
      403,
      "Attachment unavailable",
    );
    const url = await getSignedUrl(
      s3(true),
      new GetObjectCommand({
        Bucket: bucket(),
        Key: a.object_key,
        ResponseContentDisposition: `attachment; filename="${a.name.replace(/[^a-zA-Z0-9_. -]/g, "_")}"`,
        ResponseContentType: "application/octet-stream",
      }),
      { expiresIn: 60 },
    );
    res.json({ url, name: a.name });
  });
}
export async function deleteObjects(ctx: Context) {
  for (const row of (
    await ctx.db.query(
      "SELECT object_key FROM object_deletions ORDER BY created_at LIMIT 100",
    )
  ).rows) {
    await s3().send(
      new DeleteObjectCommand({ Bucket: bucket(), Key: row.object_key }),
    );
    await ctx.db.query("DELETE FROM object_deletions WHERE object_key=$1", [
      row.object_key,
    ]);
  }
}
function videoConfigured() {
  return !!(
    process.env.LIVEKIT_URL &&
    process.env.LIVEKIT_API_KEY &&
    process.env.LIVEKIT_API_SECRET
  );
}
export async function endLiveKitCall(id: string) {
  if (!videoConfigured())
    throw new Error("LiveKit configuration required for media revocation");
  const svc = new RoomServiceClient(
    process.env.LIVEKIT_URL!.replace(/^ws/, "http"),
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
  );
  try {
    await svc.deleteRoom(`call-${id}`);
  } catch (error) {
    if ((error as any).code !== "not_found" && (error as any).status !== 404)
      throw error;
  }
}
export function callRoutes(app: Express, ctx: Context) {
  app.get("/api/calls", async (_req, res) =>
    res.json(
      (
        await ctx.db.query(
          "SELECT c.*,u.display_name FROM calls c JOIN users u ON u.id=c.caller_id WHERE (c.target_id=$1 OR c.caller_id=$1) AND c.state<>'ENDED' AND c.expires_at>now()",
          [res.locals.user.id],
        )
      ).rows,
    ),
  );
  app.post("/api/calls", async (req, res) => {
    const input = z
      .object({ roomId: z.string().uuid(), targetId: z.string().uuid() })
      .parse(req.body);
    requireThat(
      (await settings(ctx.db)).video_enabled && videoConfigured(),
      503,
      "Video calls are not configured",
    );
    const room = await member(ctx.db, input.roomId, res.locals.user.id);
    requireThat(
      ["PRIVATE", "CONTACT", "STRANGER"].includes(room.type),
      403,
      "Video is available only in private conversations",
    );
    requireThat(
      input.targetId !== res.locals.user.id,
      400,
      "Choose another participant",
    );
    await member(ctx.db, input.roomId, input.targetId);
    requireThat(
      await ctx.rt.limit(`call:${res.locals.user.id}`, 5, 600),
      429,
      "Call limit reached",
    );
    const id = randomUUID();
    await ctx.db.query(
      "INSERT INTO calls(id,room_id,caller_id,target_id) VALUES($1,$2,$3,$4)",
      [id, room.id, res.locals.user.id, input.targetId],
    );
    await ctx.rt.publish({
      type: "call.request",
      userIds: [input.targetId, res.locals.user.id],
    });
    res.status(201).json({ id });
  });
  app.post("/api/calls/:id/respond", async (req, res) => {
    const id = z.string().uuid().parse(req.params.id),
      accept = z.object({ accept: z.boolean() }).parse(req.body).accept;
    const c = (
      await ctx.db.query(
        "SELECT * FROM calls WHERE id=$1 AND target_id=$2 AND state='RINGING' AND expires_at>now()",
        [id, res.locals.user.id],
      )
    ).rows[0];
    requireThat(c, 404, "Call unavailable");
    await member(ctx.db, c.room_id, res.locals.user.id);
    await ctx.db.query(
      "UPDATE calls SET state=$2 WHERE id=$1 AND state='RINGING'",
      [id, accept ? "ACCEPTED" : "ENDED"],
    );
    await ctx.rt.publish({
      type: "call.changed",
      userIds: [c.target_id, c.caller_id],
    });
    res.sendStatus(204);
  });
  app.post("/api/calls/:id/token", async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    requireThat(
      (await settings(ctx.db)).video_enabled && videoConfigured(),
      503,
      "Video unavailable",
    );
    const c = (
      await ctx.db.query(
        "SELECT * FROM calls WHERE id=$1 AND state='ACCEPTED' AND expires_at>now() AND (caller_id=$2 OR target_id=$2)",
        [id, res.locals.user.id],
      )
    ).rows[0];
    requireThat(c, 403, "Both users must accept the call");
    await member(ctx.db, c.room_id, res.locals.user.id);
    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      { identity: res.locals.user.id, ttl: "5m" },
    );
    at.addGrant({
      roomJoin: true,
      room: `call-${id}`,
      canPublish: true,
      canSubscribe: true,
    });
    res.json({ token: await at.toJwt(), url: process.env.LIVEKIT_URL });
  });
  app.post("/api/calls/:id/end", async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const c = (
      await ctx.db.query(
        "UPDATE calls SET state='ENDED' WHERE id=$1 AND (caller_id=$2 OR target_id=$2) RETURNING *",
        [id, res.locals.user.id],
      )
    ).rows[0];
    requireThat(c, 404, "Call unavailable");
    await endLiveKitCall(id);
    await ctx.rt.publish({
      type: "call.changed",
      userIds: [c.target_id, c.caller_id],
    });
    res.sendStatus(204);
  });
}
export function aiRoutes(app: Express, ctx: Context) {
  app.post("/api/assistant", async (req, res) => {
    const input = z
      .object({
        roomId: z.string().uuid(),
        style: z.enum(["icebreaker", "playful", "reply", "revive"]),
      })
      .parse(req.body);
    await member(ctx.db, input.roomId, res.locals.user.id);
    requireThat(
      (await settings(ctx.db)).AI_assistant_enabled &&
        process.env.AI_BASE_URL &&
        process.env.AI_API_KEY &&
        process.env.AI_MODEL,
      503,
      "Conversation assistant is not configured",
    );
    requireThat(
      await ctx.rt.limit(`ai:${res.locals.user.id}`, 10, 3600),
      429,
      "Assistant limit reached",
    );
    // Suggestions deliberately omit conversation history to avoid sharing a peer's private messages with a provider.
    const response = await fetch(
      `${process.env.AI_BASE_URL.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.AI_API_KEY}`,
        },
        body: JSON.stringify({
          model: process.env.AI_MODEL,
          messages: [
            {
              role: "system",
              content:
                "Write one short, friendly social conversation suggestion for adults. Respect consent. No harassment, coercion, threats, manipulation, stalking, or sexual content involving minors. Never imply availability is consent. Keep it non-explicit.",
            },
            {
              role: "user",
              content: `Give me a ${input.style} conversation starter.`,
            },
          ],
          max_tokens: 120,
        }),
        signal: AbortSignal.timeout(20000),
        redirect: "error",
      },
    );
    requireThat(response.ok, 503, "Assistant temporarily unavailable");
    const result = z
      .object({
        choices: z
          .array(
            z.object({ message: z.object({ content: z.string().max(2000) }) }),
          )
          .min(1),
      })
      .parse(await response.json());
    await audit(
      ctx.db,
      res.locals.user.id,
      "assistant.suggestion",
      input.roomId,
    );
    res.json({ suggestion: result.choices[0].message.content });
  });
}
