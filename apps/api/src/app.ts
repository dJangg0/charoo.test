import express from "express";
import helmet from "helmet";
import { parse, serialize } from "cookie";
import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import {
  z,
  guestSchema,
  emailSchema,
  profileSchema,
  roomSchema,
  messageSchema,
  requestSchema,
  reportSchema,
  settingsSchema,
} from "@charoo/contracts";
import { HttpError, requireThat } from "./errors.js";
import { token, hash, decrypt } from "./crypto.js";
function cursor(row: any) {
  return Buffer.from(
    JSON.stringify({ at: new Date(row.created_at).toISOString(), id: row.id }),
  ).toString("base64url");
}
function parseCursor(value?: string) {
  if (!value) return null;
  try {
    return z
      .object({ at: z.string().datetime(), id: z.string().uuid() })
      .parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    throw new HttpError(400, "Invalid pagination cursor");
  }
}
import {
  type Context,
  settings,
  user,
  publicUser,
  eligible,
  member,
  blocked,
  createDirect,
  audit,
  sendMessage,
  serializeMessages,
  closeRoom,
  match,
  terminateCalls,
} from "./domain.js";
import { mediaRoutes, callRoutes, aiRoutes } from "./providers.js";
export function app(ctx: Context) {
  const app = express();
  app.disable("x-powered-by");
  const proxies = (process.env.TRUST_PROXY_CIDRS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const p of proxies) {
    const [address, bits] = p.split("/");
    const family = isIP(address);
    if (
      !family ||
      (bits !== undefined &&
        (!/^\d+$/.test(bits) || Number(bits) > (family === 4 ? 32 : 128)))
    )
      throw new Error(
        "TRUST_PROXY_CIDRS must contain explicit IP/CIDR entries",
      );
  }
  if (proxies.length) app.set("trust proxy", proxies);
  const externalOrigins = [
    process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT,
    process.env.LIVEKIT_URL,
  ]
    .filter(Boolean)
    .flatMap((value) => {
      const url = new URL(value!);
      return [url.origin, url.origin.replace(/^ws/, "http")];
    });
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          connectSrc: ["'self'", ...externalOrigins],
          mediaSrc: ["'self'", "blob:", ...externalOrigins],
          upgradeInsecureRequests: ctx.config.production ? [] : null,
        },
      },
    }),
  );
  app.use(express.json({ limit: "32kb" }));
  app.use((req, res, next) => {
    res.setHeader("X-Request-Id", randomUUID());
    res.setHeader("Cache-Control", "no-store");
    const origin = req.headers.origin;
    if (origin && origin !== ctx.config.origin)
      return next(new HttpError(403, "Untrusted origin"));
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type,X-CSRF-Token",
      );
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE");
      res.sendStatus(204);
      return;
    }
    if (!["GET", "HEAD"].includes(req.method) && origin !== ctx.config.origin)
      return next(new HttpError(403, "Origin required"));
    next();
  });
  app.get("/api/health", async (_req, res) => {
    await ctx.db.query("SELECT 1");
    await ctx.rt.get("health");
    res.json({ status: "ok" });
  });
  app.use("/api", async (req, res, next) => {
    if (!(await ctx.rt.limit(`ip:${req.ip}`, 180, 60)))
      return next(new HttpError(429, "Too many requests; try again shortly"));
    next();
  });
  const issueSession = async (res: express.Response, id: string) => {
    const t = token(),
      csrf = token();
    await ctx.db.query(
      "INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '7 days')",
      [hash(t), id, csrf],
    );
    res.setHeader(
      "Set-Cookie",
      serialize("charoo_session", t, {
        httpOnly: true,
        secure: ctx.config.production,
        sameSite: "lax",
        path: "/",
        maxAge: 604800,
      }),
    );
    return csrf;
  };
  const session = async (req: express.Request) => {
    const t = parse(req.headers.cookie || "").charoo_session;
    if (!t) return null;
    return (
      (
        await ctx.db.query(
          "SELECT * FROM sessions WHERE token_hash=$1 AND expires_at>now()",
          [hash(t)],
        )
      ).rows[0] || null
    );
  };
  app.post("/api/auth/guest", async (req, res) => {
    guestSchema.parse(req.body);
    requireThat(
      (await settings(ctx.db)).guest_access_enabled,
      403,
      "Guest access is disabled",
    );
    requireThat(
      await ctx.rt.limit(`guest:${req.ip}`, 10, 3600),
      429,
      "Guest session limit reached",
    );
    const existing = await session(req);
    if (existing) {
      res.json({
        user: publicUser(await user(ctx.db, existing.user_id)),
        csrf: existing.csrf,
      });
      return;
    }
    const id = randomUUID(),
      name = `Guest ${token().slice(0, 4)}`;
    await ctx.db.query(
      "INSERT INTO users(id,display_name,profile,guest_expires_at) VALUES($1,$2,$3,now()+interval '7 days')",
      [
        id,
        name,
        JSON.stringify({
          displayName: name,
          age: null,
          gender: "",
          region: "",
          bio: "",
          interests: [],
          aslVisibility: "private",
        }),
      ],
    );
    res.status(201).json({
      user: publicUser(await user(ctx.db, id)),
      csrf: await issueSession(res, id),
    });
  });
  app.post("/api/auth/email", async (req, res) => {
    const input = emailSchema.parse(req.body);
    requireThat(
      await ctx.rt.limit(`email:${req.ip}`, 5, 900),
      429,
      "Please wait before requesting another link",
    );
    requireThat(ctx.config.smtpUrl, 503, "Email service is not configured");
    const existing = await session(req);
    if (existing)
      requireThat(
        req.headers["x-csrf-token"] === existing.csrf,
        403,
        "Invalid request token",
      );
    let id = existing?.user_id;
    if (!id) {
      id = randomUUID();
      await ctx.db.query(
        "INSERT INTO users(id,display_name,profile,guest_expires_at) VALUES($1,'New friend',$2,now()+interval '7 days')",
        [
          id,
          JSON.stringify({
            displayName: "New friend",
            age: null,
            gender: "",
            region: "",
            bio: "",
            interests: [],
            aslVisibility: "private",
          }),
        ],
      );
    }
    const t = token(),
      email = input.email.toLowerCase();
    await ctx.db.query(
      "INSERT INTO email_tokens(token_hash,email,user_id,expires_at) VALUES($1,$2,$3,now()+interval '15 minutes')",
      [hash(t), email, id],
    );
    await ctx.mail(email, `${ctx.config.origin}/#verify=${t}`);
    res.json({
      message: "Check your email for a sign-in link. It expires in 15 minutes.",
    });
  });
  app.post("/api/auth/verify", async (req, res) => {
    const t = z
      .object({ token: z.string().min(30).max(100) })
      .parse(req.body).token;
    const id = await ctx.db.transaction(async (db) => {
      const v = (
        await db.query(
          "DELETE FROM email_tokens WHERE token_hash=$1 AND expires_at>now() RETURNING *",
          [hash(t)],
        )
      ).rows[0];
      requireThat(v, 400, "This link is invalid or expired");
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [v.email]);
      const target = (
        await db.query("SELECT id FROM users WHERE email=$1", [v.email])
      ).rows[0];
      if (target) return target.id;
      const current = (
        await db.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [
          v.user_id,
        ])
      ).rows[0];
      requireThat(current, 400, "Account unavailable");
      if (current.verified) {
        requireThat(
          current.email === v.email,
          409,
          "Sign out before verifying a different email",
        );
        return current.id;
      }
      await db.query(
        "UPDATE users SET email=$2,verified=true,guest_expires_at=NULL WHERE id=$1",
        [v.user_id, v.email],
      );
      await db.query("DELETE FROM sessions WHERE user_id=$1", [v.user_id]);
      return v.user_id;
    });
    const previous = await session(req);
    if (previous)
      await ctx.db.query("DELETE FROM sessions WHERE token_hash=$1", [
        previous.token_hash,
      ]);
    res.json({
      user: publicUser(await user(ctx.db, id)),
      csrf: await issueSession(res, id),
    });
  });
  app.use("/api", async (req, res, next) => {
    const s = await session(req);
    requireThat(s, 401, "Sign in to continue");
    const u = await user(ctx.db, s.user_id);
    if (!["GET", "HEAD"].includes(req.method))
      requireThat(
        req.headers["x-csrf-token"] === s.csrf,
        403,
        "Invalid request token",
      );
    res.locals.user = u;
    res.locals.session = s;
    next();
  });
  app.get("/api/me", async (_req, res) =>
    res.json({
      user: publicUser(
        res.locals.user,
        (await ctx.rt.get(`presence:${res.locals.user.id}`)) || "Offline",
      ),
      csrf: res.locals.session.csrf,
      settings: await settings(ctx.db),
    }),
  );
  app.post("/api/auth/logout", async (_req, res) => {
    await ctx.db.query("DELETE FROM sessions WHERE token_hash=$1", [
      res.locals.session.token_hash,
    ]);
    await ctx.rt.del(`presence:${res.locals.user.id}`);
    await ctx.rt.del(`available:${res.locals.user.id}`);
    await ctx.rt.del(`match:waiting:${res.locals.user.id}`);
    await ctx.rt.dequeue(res.locals.user.id);
    res.setHeader(
      "Set-Cookie",
      serialize("charoo_session", "", {
        path: "/",
        maxAge: 0,
        httpOnly: true,
        sameSite: "lax",
        secure: ctx.config.production,
      }),
    );
    res.sendStatus(204);
  });
  app.patch("/api/me/profile", async (req, res) => {
    const p = profileSchema.parse(req.body);
    await ctx.db.query(
      "UPDATE users SET display_name=$2,profile=$3 WHERE id=$1",
      [res.locals.user.id, p.displayName, JSON.stringify(p)],
    );
    res.json(publicUser(await user(ctx.db, res.locals.user.id)));
  });
  app.post("/api/presence", async (req, res) => {
    const input = z
        .object({
          status: z.enum(["Offline", "Online", "Available Tonight"]),
          roomId: z.string().uuid().optional(),
          heartbeat: z.boolean().default(false),
        })
        .parse(req.body),
      u = res.locals.user;
    if (input.status === "Offline") {
      await ctx.rt.del(`presence:${u.id}`);
      await ctx.rt.del(`available:${u.id}`);
      await ctx.rt.del(`match:waiting:${u.id}`);
      await ctx.rt.dequeue(u.id);
    } else {
      await ctx.rt.set(`presence:${u.id}`, "Online", 90);
      if (input.status === "Available Tonight") {
        await eligible(ctx, u);
        if (!input.heartbeat && !(await ctx.rt.get(`available:${u.id}`)))
          await ctx.rt.set(
            `available:${u.id}`,
            "1",
            (await settings(ctx.db)).available_tonight_duration_hours * 3600,
          );
        if (await ctx.rt.get(`available:${u.id}`))
          await ctx.rt.set(`presence:${u.id}`, "Available Tonight", 90);
      } else await ctx.rt.del(`available:${u.id}`);
      if (input.roomId) {
        await member(ctx.db, input.roomId, u.id);
        await ctx.rt.roomPresence(input.roomId, u.id);
      }
    }
    if (
      (await ctx.rt.get(`match:waiting:${u.id}`)) &&
      input.status !== "Offline"
    )
      await ctx.rt.set(`match:waiting:${u.id}`, "1", 90);
    res.json({
      status: (await ctx.rt.get(`presence:${u.id}`)) || "Offline",
      availableExpires: !!(await ctx.rt.get(`available:${u.id}`)),
    });
  });
  app.post("/api/match", async (_req, res) =>
    res.json(await match(ctx, res.locals.user)),
  );
  app.delete("/api/match", async (_req, res) => {
    await ctx.db.transaction(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(901002)");
      await ctx.rt.dequeue(res.locals.user.id);
      await ctx.rt.del(`match:waiting:${res.locals.user.id}`);
    });
    res.sendStatus(204);
  });
  app.get("/api/rooms", async (req, res) => {
    const u = res.locals.user;
    await eligible(ctx, u);
    const query = z
      .object({
        q: z.string().max(100).default(""),
        category: z.string().max(30).default(""),
        before: z.string().max(300).optional(),
      })
      .parse(req.query);
    const position = parseCursor(query.before);
    const rows = (
      await ctx.db.query(
        "SELECT r.* FROM rooms r WHERE type='AVAILABLE_TONIGHT' AND state='OPEN' AND expires_at>now() AND ($1='' OR title ILIKE '%'||$1||'%' OR description ILIKE '%'||$1||'%' OR tags::text ILIKE '%'||$1||'%') AND ($2='' OR category=$2) AND ($3::timestamptz IS NULL OR (created_at,id)<($3,$5::uuid)) AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.user_id=$4 AND b.target_id=r.creator_id) OR (b.target_id=$4 AND b.user_id=r.creator_id)) ORDER BY created_at DESC,id DESC LIMIT 30",
        [
          query.q,
          query.category,
          position?.at || null,
          u.id,
          position?.id || null,
        ],
      )
    ).rows;
    res.json({
      rooms: await Promise.all(
        rows.map(async (r) => ({
          ...r,
          share_hash: undefined,
          online: await ctx.rt.roomCount(r.id),
        })),
      ),
      next: rows.length === 30 ? cursor(rows.at(-1)) : null,
    });
  });
  app.get("/api/conversations", async (_req, res) => {
    const rows = (
      await ctx.db.query(
        "SELECT r.* FROM rooms r JOIN participants p ON p.room_id=r.id WHERE p.user_id=$1 AND p.state='JOINED' AND r.state='OPEN' AND (r.expires_at IS NULL OR r.expires_at>now()) ORDER BY r.last_activity DESC LIMIT 50",
        [res.locals.user.id],
      )
    ).rows;
    res.json(rows.map((r) => ({ ...r, share_hash: undefined })));
  });
  app.post("/api/rooms", async (req, res) => {
    const input = roomSchema.parse(req.body),
      u = res.locals.user,
      cfg = await settings(ctx.db);
    requireThat(
      await ctx.rt.limit(`room-create:${u.id}`, 10, 3600),
      429,
      "Room creation limit reached",
    );
    if (input.type === "AVAILABLE_TONIGHT") await eligible(ctx, u);
    else
      requireThat(
        u.verified || cfg.guest_access_enabled,
        403,
        "Guest rooms disabled",
      );
    const id = randomUUID(),
      link = input.type === "SHARED_GROUP" ? token() : null;
    await ctx.db.transaction(async (db) => {
      await db.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [u.id]);
      if (input.type === "AVAILABLE_TONIGHT")
        requireThat(
          (
            await db.query(
              "SELECT count(*)::int AS n FROM rooms WHERE creator_id=$1 AND type='AVAILABLE_TONIGHT' AND state='OPEN' AND expires_at>now()",
              [u.id],
            )
          ).rows[0].n < cfg.available_room_creation_limit,
          429,
          "Close an active room before creating another",
        );
      const hours = Math.min(
        input.durationHours || 24,
        input.type === "AVAILABLE_TONIGHT"
          ? cfg.available_room_retention_hours
          : cfg.shared_room_retention_hours,
      );
      await db.query(
        "INSERT INTO rooms(id,type,creator_id,title,description,category,region,tags,verified_only,share_hash,slow_mode,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now()+($12*interval '1 hour'))",
        [
          id,
          input.type,
          u.id,
          input.title,
          input.description,
          input.category,
          input.region,
          JSON.stringify(input.tags),
          input.type === "AVAILABLE_TONIGHT" || input.verifiedOnly,
          link ? hash(link) : null,
          cfg.available_room_slow_mode,
          hours,
        ],
      );
      await db.query(
        "INSERT INTO participants(room_id,user_id) VALUES($1,$2)",
        [id, u.id],
      );
    });
    await ctx.rt.publish({ type: "discovery.changed" });
    res.status(201).json({
      id,
      shareUrl: link ? `${ctx.config.origin}/#room=${link}` : null,
    });
  });
  app.post("/api/shared/join", async (req, res) => {
    const link = z
      .object({ token: z.string().min(30).max(100) })
      .parse(req.body).token;
    const room = (
      await ctx.db.query("SELECT * FROM rooms WHERE share_hash=$1", [
        hash(link),
      ])
    ).rows[0];
    requireThat(room, 404, "Room unavailable");
    await join(room, res.locals.user);
    res.json({ id: room.id });
  });
  const join = async (room: any, u: any) => {
    requireThat(
      room.state === "OPEN" && new Date(room.expires_at).getTime() > Date.now(),
      410,
      "Room expired",
    );
    if (room.type === "AVAILABLE_TONIGHT") await eligible(ctx, u);
    requireThat(
      !room.verified_only || u.verified,
      403,
      "Verify your email to join",
    );
    requireThat(
      !(await blocked(ctx.db, u.id, room.creator_id)),
      403,
      "Room unavailable",
    );
    requireThat(
      u.verified || (await settings(ctx.db)).guest_access_enabled,
      403,
      "Guest access disabled",
    );
    const old = (
      await ctx.db.query(
        "SELECT state FROM participants WHERE room_id=$1 AND user_id=$2",
        [room.id, u.id],
      )
    ).rows[0];
    requireThat(
      old?.state !== "REMOVED",
      403,
      "You were removed from this room",
    );
    await ctx.db.query(
      "INSERT INTO participants(room_id,user_id) VALUES($1,$2) ON CONFLICT(room_id,user_id) DO UPDATE SET state='JOINED' WHERE participants.state<>'REMOVED'",
      [room.id, u.id],
    );
    await ctx.rt.roomPresence(room.id, u.id);
    await ctx.rt.publish({ type: "discovery.changed" });
  };
  app.param("roomId", (req, _res, next, id) => {
    try {
      z.string().uuid().parse(id);
      next();
    } catch {
      next(new HttpError(400, "Invalid room"));
    }
  });
  app.post("/api/rooms/:roomId/join", async (req, res) => {
    const room = (
      await ctx.db.query(
        "SELECT * FROM rooms WHERE id=$1 AND type='AVAILABLE_TONIGHT'",
        [req.params.roomId],
      )
    ).rows[0];
    requireThat(room, 404, "Room unavailable");
    await join(room, res.locals.user);
    res.sendStatus(204);
  });
  app.get("/api/rooms/:roomId", async (req, res) => {
    const u = res.locals.user,
      room = await member(ctx.db, String(req.params.roomId), u.id);
    if (room.type === "AVAILABLE_TONIGHT") await eligible(ctx, u);
    const people = (
      await ctx.db.query(
        "SELECT u.id,u.display_name,u.verified,u.profile,p.meaningful_count FROM participants p JOIN users u ON u.id=p.user_id WHERE p.room_id=$1 AND p.state='JOINED' ORDER BY p.joined_at LIMIT 100",
        [room.id],
      )
    ).rows;
    const visibleProfiles = new Set<string>();
    for (const p of people) {
      if (p.id === u.id || p.profile.aslVisibility === "public")
        visibleProfiles.add(p.id);
      else if (p.profile.aslVisibility === "contacts_only") {
        const [a, b] = [p.id, u.id].sort();
        if (
          (
            await ctx.db.query(
              "SELECT 1 FROM contacts WHERE user_a=$1 AND user_b=$2",
              [a, b],
            )
          ).rows.length
        )
          visibleProfiles.add(p.id);
      }
    }
    res.json({
      ...room,
      share_hash: undefined,
      online: await ctx.rt.roomCount(room.id),
      participants: people.map((p) => ({
        id: p.id,
        name: room.type === "STRANGER" ? "Stranger" : p.display_name,
        verified: p.verified,
        asl:
          (room.type !== "STRANGER" || room.asl_revealed) &&
          visibleProfiles.has(p.id)
            ? {
                age: p.profile.age,
                gender: p.profile.gender,
                region: p.profile.region,
              }
            : null,
      })),
      aslProgress: people.map((p) => ({ id: p.id, count: p.meaningful_count })),
    });
  });
  app.get("/api/rooms/:roomId/messages", async (req, res) => {
    const room = await member(
      ctx.db,
      String(req.params.roomId),
      res.locals.user.id,
    );
    if (room.type === "AVAILABLE_TONIGHT") await eligible(ctx, res.locals.user);
    const input = z
      .object({ before: z.string().max(300).optional() })
      .parse(req.query);
    const position = parseCursor(input.before);
    const rows = (
      await ctx.db.query(
        "SELECT m.*,u.display_name,r.type AS room_type FROM messages m JOIN users u ON u.id=m.sender_id JOIN rooms r ON r.id=m.room_id WHERE m.room_id=$1 AND ($2::timestamptz IS NULL OR (m.created_at,m.id)<($2,$3::uuid)) ORDER BY m.created_at DESC,m.id DESC LIMIT 50",
        [room.id, position?.at || null, position?.id || null],
      )
    ).rows;
    res.json({
      messages: await serializeMessages(
        ctx,
        rows.reverse(),
        res.locals.user.id,
      ),
      next: rows.length === 50 ? cursor(rows[0]) : null,
    });
  });
  app.post("/api/rooms/:roomId/messages", async (req, res) => {
    requireThat(
      await ctx.rt.limit(`message:${res.locals.user.id}`, 40, 60),
      429,
      "Message limit reached",
    );
    res
      .status(201)
      .json(
        await sendMessage(
          ctx,
          res.locals.user,
          String(req.params.roomId),
          messageSchema.parse(req.body),
        ),
      );
  });
  app.post("/api/rooms/:roomId/read", async (req, res) => {
    await member(ctx.db, String(req.params.roomId), res.locals.user.id);
    await ctx.db.query(
      "UPDATE participants SET read_at=now() WHERE room_id=$1 AND user_id=$2",
      [req.params.roomId, res.locals.user.id],
    );
    await ctx.rt.publish({
      type: "read",
      roomId: String(req.params.roomId),
      payload: { userId: res.locals.user.id },
    });
    res.sendStatus(204);
  });
  app.post("/api/rooms/:roomId/reactions", async (req, res) => {
    await member(ctx.db, String(req.params.roomId), res.locals.user.id, true);
    const input = z
      .object({
        messageId: z.string().uuid(),
        emoji: z.enum(["❤️", "👍", "😂", "🔥"]),
        remove: z.boolean().default(false),
      })
      .parse(req.body);
    requireThat(
      (
        await ctx.db.query(
          "SELECT 1 FROM messages WHERE id=$1 AND room_id=$2",
          [input.messageId, req.params.roomId],
        )
      ).rows.length,
      404,
      "Message unavailable",
    );
    if (input.remove)
      await ctx.db.query(
        "DELETE FROM reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3",
        [input.messageId, res.locals.user.id, input.emoji],
      );
    else
      await ctx.db.query(
        "INSERT INTO reactions(message_id,user_id,emoji) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [input.messageId, res.locals.user.id, input.emoji],
      );
    await ctx.rt.publish({
      type: "message",
      roomId: String(req.params.roomId),
    });
    res.sendStatus(204);
  });
  app.post("/api/rooms/:roomId/leave", async (req, res) => {
    const room = await member(
      ctx.db,
      String(req.params.roomId),
      res.locals.user.id,
    );
    if (["STRANGER", "PRIVATE"].includes(room.type))
      await closeRoom(ctx, room.id, res.locals.user.id);
    else if (room.type !== "CONTACT")
      await ctx.db.query(
        "UPDATE participants SET state='LEFT' WHERE room_id=$1 AND user_id=$2",
        [room.id, res.locals.user.id],
      );
    await ctx.rt.publish({ type: "room.changed", roomId: room.id });
    res.sendStatus(204);
  });
  app.patch("/api/rooms/:roomId", async (req, res) => {
    const room = await member(
      ctx.db,
      String(req.params.roomId),
      res.locals.user.id,
    );
    requireThat(
      room.creator_id === res.locals.user.id &&
        ["AVAILABLE_TONIGHT", "SHARED_GROUP"].includes(room.type),
      403,
      "Room owner required",
    );
    const input = z
      .object({
        title: z.string().trim().min(3).max(100),
        description: z.string().trim().max(500),
        slowMode: z.number().int().min(0).max(60),
      })
      .parse(req.body);
    await ctx.db.query(
      "UPDATE rooms SET title=$2,description=$3,slow_mode=$4 WHERE id=$1",
      [room.id, input.title, input.description, input.slowMode],
    );
    await audit(ctx.db, res.locals.user.id, "room.edit", room.id);
    await ctx.rt.publish({ type: "discovery.changed" });
    res.sendStatus(204);
  });
  app.post("/api/rooms/:roomId/moderate", async (req, res) => {
    const room = await member(
      ctx.db,
      String(req.params.roomId),
      res.locals.user.id,
    );
    requireThat(
      room.creator_id === res.locals.user.id &&
        ["AVAILABLE_TONIGHT", "SHARED_GROUP"].includes(room.type),
      403,
      "Room owner required",
    );
    const input = z
      .object({
        action: z.enum(["CLOSE", "REMOVE", "MUTE"]),
        targetId: z.string().uuid().optional(),
      })
      .parse(req.body);
    if (input.action === "CLOSE")
      await closeRoom(ctx, room.id, res.locals.user.id);
    else {
      requireThat(
        input.targetId && input.targetId !== res.locals.user.id,
        400,
        "Choose another participant",
      );
      await ctx.db.query(
        input.action === "REMOVE"
          ? "UPDATE participants SET state='REMOVED' WHERE room_id=$1 AND user_id=$2"
          : "UPDATE participants SET muted_until=now()+interval '30 minutes' WHERE room_id=$1 AND user_id=$2",
        [room.id, input.targetId],
      );
    }
    await audit(
      ctx.db,
      res.locals.user.id,
      `room.${input.action.toLowerCase()}`,
      room.id,
      { targetId: input.targetId },
    );
    await ctx.rt.publish({ type: "room.changed", roomId: room.id });
    res.sendStatus(204);
  });
  app.post("/api/blocks", async (req, res) => {
    const target = z
      .object({ targetId: z.string().uuid() })
      .parse(req.body).targetId;
    requireThat(target !== res.locals.user.id, 400, "Cannot block yourself");
    requireThat(
      (await ctx.db.query("SELECT 1 FROM users WHERE id=$1", [target])).rows
        .length,
      404,
      "User unavailable",
    );
    await ctx.db.query(
      "INSERT INTO blocks(user_id,target_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [res.locals.user.id, target],
    );
    await ctx.db.query(
      "UPDATE social_requests SET state='REJECTED' WHERE state='PENDING' AND ((requester_id=$1 AND target_id=$2) OR (requester_id=$2 AND target_id=$1))",
      [res.locals.user.id, target],
    );
    await terminateCalls(
      ctx,
      "(caller_id=$1 AND target_id=$2) OR (caller_id=$2 AND target_id=$1)",
      [res.locals.user.id, target],
    );
    await ctx.rt.publish({
      type: "blocked",
      userIds: [res.locals.user.id, target],
    });
    res.sendStatus(204);
  });
  app.get("/api/blocks", async (_req, res) =>
    res.json(
      (
        await ctx.db.query(
          "SELECT b.target_id,u.display_name FROM blocks b JOIN users u ON u.id=b.target_id WHERE b.user_id=$1",
          [res.locals.user.id],
        )
      ).rows,
    ),
  );
  app.delete("/api/blocks/:id", async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    await ctx.db.query("DELETE FROM blocks WHERE user_id=$1 AND target_id=$2", [
      res.locals.user.id,
      id,
    ]);
    res.sendStatus(204);
  });
  app.post("/api/reports", async (req, res) => {
    const input = reportSchema.parse(req.body);
    requireThat(
      await ctx.rt.limit(`report:${res.locals.user.id}`, 10, 3600),
      429,
      "Report limit reached",
    );
    let roomId = input.roomId;
    if (input.messageId) {
      const m = (
        await ctx.db.query("SELECT room_id FROM messages WHERE id=$1", [
          input.messageId,
        ])
      ).rows[0];
      requireThat(m, 404, "Message unavailable");
      roomId = m.room_id;
    }
    if (roomId) await member(ctx.db, roomId, res.locals.user.id);
    await ctx.db.query(
      "INSERT INTO reports(id,reporter_id,target_id,room_id,message_id,reason) VALUES($1,$2,$3,$4,$5,$6)",
      [
        randomUUID(),
        res.locals.user.id,
        input.targetId || null,
        roomId || null,
        input.messageId || null,
        input.reason,
      ],
    );
    res.status(201).json({
      message: "Report received. Thank you for helping keep Charoo safe.",
    });
  });
  app.get("/api/requests", async (_req, res) => {
    res.json(
      (
        await ctx.db.query(
          "SELECT s.*,u.display_name FROM social_requests s JOIN users u ON u.id=s.requester_id WHERE s.target_id=$1 AND s.state='PENDING' AND s.expires_at>now() ORDER BY s.created_at DESC",
          [res.locals.user.id],
        )
      ).rows,
    );
  });
  app.post("/api/requests", async (req, res) => {
    const input = requestSchema.parse(req.body),
      u = res.locals.user;
    requireThat(u.verified, 403, "Verify your email first");
    const target = await user(ctx.db, input.targetId);
    requireThat(
      target.verified && target.id !== u.id,
      400,
      "Choose another verified user",
    );
    requireThat(
      !(await blocked(ctx.db, u.id, target.id)),
      403,
      "Request unavailable",
    );
    requireThat(
      await ctx.rt.limit(`social:${u.id}`, 10, 3600),
      429,
      "Request limit reached",
    );
    if (input.kind === "RECONNECT") {
      const [a, b] = [u.id, target.id].sort();
      requireThat(
        (
          await ctx.db.query(
            "SELECT 1 FROM match_history WHERE user_a=$1 AND user_b=$2",
            [a, b],
          )
        ).rows.length,
        403,
        "No previous match",
      );
    } else {
      requireThat(input.roomId, 400, "A shared conversation is required");
      await member(ctx.db, input.roomId, u.id);
      await member(ctx.db, input.roomId, target.id);
    }
    const id = randomUUID();
    await ctx.db.query(
      "INSERT INTO social_requests(id,requester_id,target_id,kind,source_room_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
      [id, u.id, target.id, input.kind, input.roomId || null],
    );
    await ctx.rt.publish({ type: "request", userIds: [target.id] });
    res.status(201).json({ id });
  });
  app.post("/api/requests/:id/respond", async (req, res) => {
    const id = z.string().uuid().parse(req.params.id),
      accept = z.object({ accept: z.boolean() }).parse(req.body).accept,
      u = res.locals.user;
    requireThat(u.verified, 403, "Verify your email first");
    const result = await ctx.db.transaction(async (db) => {
      const request = (
        await db.query(
          "SELECT * FROM social_requests WHERE id=$1 AND target_id=$2 AND state='PENDING' AND expires_at>now() FOR UPDATE",
          [id, u.id],
        )
      ).rows[0];
      requireThat(request, 404, "Request unavailable");
      await user(db, request.requester_id);
      requireThat(
        !(await blocked(db, u.id, request.requester_id)),
        403,
        "Request unavailable",
      );
      let roomId: string | null = null;
      if (accept) {
        const [a, b] = [u.id, request.requester_id].sort();
        await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `${a}:${b}`,
        ]);
        if (request.kind === "CONTACT") {
          const existing = (
            await db.query(
              "SELECT room_id FROM contacts WHERE user_a=$1 AND user_b=$2",
              [a, b],
            )
          ).rows[0];
          roomId =
            existing?.room_id ||
            (await createDirect(db, a, b, "CONTACT", await settings(db)));
          if (!existing)
            await db.query(
              "INSERT INTO contacts(user_a,user_b,room_id) VALUES($1,$2,$3)",
              [a, b, roomId],
            );
        } else
          roomId = await createDirect(
            db,
            u.id,
            request.requester_id,
            "PRIVATE",
            await settings(db),
          );
      }
      await db.query(
        "UPDATE social_requests SET state=$2,result_room_id=$3 WHERE id=$1",
        [id, accept ? "ACCEPTED" : "REJECTED", roomId],
      );
      return { roomId, requesterId: request.requester_id };
    });
    await ctx.rt.publish({
      type: "request.responded",
      userIds: [u.id, result.requesterId],
      payload: result,
    });
    res.json(result);
  });
  app.get("/api/contacts", async (_req, res) => {
    const id = res.locals.user.id;
    res.json(
      (
        await ctx.db.query(
          "SELECT c.room_id,u.id,u.display_name FROM contacts c JOIN users u ON u.id=CASE WHEN c.user_a=$1 THEN c.user_b ELSE c.user_a END WHERE (c.user_a=$1 OR c.user_b=$1) AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.user_id=$1 AND b.target_id=u.id) OR (b.target_id=$1 AND b.user_id=u.id))",
          [id],
        )
      ).rows,
    );
  });
  app.delete("/api/contacts/:id", async (req, res) => {
    const target = z.string().uuid().parse(req.params.id);
    const [a, b] = [res.locals.user.id, target].sort();
    const result = await ctx.db.query(
      "DELETE FROM contacts WHERE user_a=$1 AND user_b=$2 RETURNING room_id",
      [a, b],
    );
    if (result.rows[0])
      await closeRoom(ctx, result.rows[0].room_id, res.locals.user.id);
    res.sendStatus(204);
  });
  app.get("/api/reconnect", async (_req, res) => {
    const id = res.locals.user.id;
    res.json(
      (
        await ctx.db.query(
          "SELECT u.id,u.display_name,h.matched_at FROM match_history h JOIN users u ON u.id=CASE WHEN h.user_a=$1 THEN h.user_b ELSE h.user_a END WHERE (h.user_a=$1 OR h.user_b=$1) AND u.verified=true ORDER BY h.matched_at DESC LIMIT 30",
          [id],
        )
      ).rows,
    );
  });
  mediaRoutes(app, ctx);
  callRoutes(app, ctx);
  aiRoutes(app, ctx);
  app.use("/api/admin", (_req, res, next) => {
    requireThat(
      ["ADMIN", "MODERATOR", "SUPPORT"].includes(res.locals.user.role),
      403,
      "Staff role required",
    );
    next();
  });
  app.get("/api/admin/dashboard", async (_req, res) => {
    const result = await ctx.db.query(
      "SELECT (SELECT count(*)::int FROM users) AS users,(SELECT count(*)::int FROM rooms WHERE state='OPEN' AND type='AVAILABLE_TONIGHT' AND expires_at>now()) AS public_rooms,(SELECT count(*)::int FROM rooms WHERE state='OPEN' AND type='SHARED_GROUP' AND expires_at>now()) AS shared_rooms,(SELECT count(*)::int FROM reports WHERE state='OPEN') AS reports",
    );
    res.json({
      ...result.rows[0],
      queue: (await ctx.rt.candidates()).length,
      settings: await settings(ctx.db),
      providers: {
        email: !!ctx.config.smtpUrl,
        media: !!process.env.MEDIA_SCANNER_URL,
        video: !!process.env.LIVEKIT_API_KEY,
        ai: !!process.env.AI_API_KEY,
      },
    });
  });
  app.get("/api/admin/reports", async (_req, res) =>
    res.json(
      (
        await ctx.db.query(
          "SELECT * FROM reports ORDER BY created_at DESC LIMIT 100",
        )
      ).rows,
    ),
  );
  app.get("/api/admin/reports/:id/evidence", async (req, res) => {
    requireThat(
      ["ADMIN", "MODERATOR"].includes(res.locals.user.role),
      403,
      "Moderator role required",
    );
    const id = z.string().uuid().parse(req.params.id);
    const r = (
      await ctx.db.query(
        "SELECT r.id,m.ciphertext,m.room_id,m.sender_id,m.created_at FROM reports r LEFT JOIN messages m ON m.id=r.message_id WHERE r.id=$1",
        [id],
      )
    ).rows[0];
    requireThat(r, 404, "Report unavailable");
    await audit(ctx.db, res.locals.user.id, "report.evidence.read", id);
    res.json({
      text: r.ciphertext
        ? decrypt(r.ciphertext, ctx.config.key, r.room_id)
        : null,
      senderId: r.sender_id,
      createdAt: r.created_at,
    });
  });
  app.get("/api/admin/rooms", async (_req, res) =>
    res.json(
      (
        await ctx.db.query(
          "SELECT id,type,title,creator_id,state,created_at,expires_at FROM rooms ORDER BY created_at DESC LIMIT 100",
        )
      ).rows,
    ),
  );
  app.get("/api/admin/audit", async (_req, res) => {
    requireThat(res.locals.user.role === "ADMIN", 403, "Admin role required");
    res.json(
      (
        await ctx.db.query(
          "SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100",
        )
      ).rows,
    );
  });
  app.patch("/api/admin/settings", async (req, res) => {
    requireThat(res.locals.user.role === "ADMIN", 403, "Admin role required");
    const value = settingsSchema.parse(req.body);
    await ctx.db.transaction(async (db) => {
      await db.query("UPDATE settings SET value=$1 WHERE id=true", [
        JSON.stringify(value),
      ]);
      await audit(db, res.locals.user.id, "settings.update", "settings");
    });
    res.json(value);
  });
  app.post("/api/admin/actions", async (req, res) => {
    requireThat(
      ["ADMIN", "MODERATOR"].includes(res.locals.user.role),
      403,
      "Moderator role required",
    );
    const input = z
      .object({
        action: z.enum(["CLOSE_ROOM", "BAN", "SUSPEND", "RESOLVE_REPORT"]),
        targetId: z.string().uuid(),
      })
      .parse(req.body);
    if (input.action === "CLOSE_ROOM")
      await closeRoom(ctx, input.targetId, res.locals.user.id);
    else if (input.action === "RESOLVE_REPORT")
      await ctx.db.query("UPDATE reports SET state='RESOLVED' WHERE id=$1", [
        input.targetId,
      ]);
    else {
      requireThat(
        input.targetId !== res.locals.user.id,
        400,
        "Cannot act on yourself",
      );
      const target = (
        await ctx.db.query("SELECT role FROM users WHERE id=$1", [
          input.targetId,
        ])
      ).rows[0];
      requireThat(
        target && target.role === "USER",
        403,
        "Staff accounts require an operator",
      );
      await ctx.db.transaction(async (db) => {
        await db.query(
          input.action === "BAN"
            ? "UPDATE users SET banned=true WHERE id=$1"
            : "UPDATE users SET suspended_until=now()+interval '24 hours' WHERE id=$1",
          [input.targetId],
        );
        await db.query("DELETE FROM sessions WHERE user_id=$1", [
          input.targetId,
        ]);
      });
      await terminateCalls(ctx, "caller_id=$1 OR target_id=$1", [
        input.targetId,
      ]);
      await ctx.rt.del(`presence:${input.targetId}`);
      await ctx.rt.dequeue(input.targetId);
      await ctx.rt.publish({
        type: "session.revoked",
        userIds: [input.targetId],
      });
    }
    await audit(
      ctx.db,
      res.locals.user.id,
      input.action.toLowerCase(),
      input.targetId,
    );
    res.sendStatus(204);
  });
  app.use("/api", (_req, _res, next) =>
    next(new HttpError(404, "Endpoint unavailable")),
  );
  app.use(
    (
      error: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status =
        error instanceof HttpError
          ? error.status
          : error instanceof z.ZodError
            ? 400
            : error.code === "23505"
              ? 409
              : error.code === "23503"
                ? 400
                : error.type === "entity.too.large"
                  ? 413
                  : error instanceof SyntaxError
                    ? 400
                    : 500;
      if (status === 500)
        console.error(
          JSON.stringify({
            event: "request.error",
            requestId: res.getHeader("X-Request-Id"),
            code: error.code || "INTERNAL",
          }),
        );
      res.status(status).json({
        error:
          status === 500
            ? "Something went wrong. Please try again."
            : error instanceof z.ZodError
              ? "Invalid input"
              : status === 413
                ? "Request too large"
                : error.code === "23505"
                  ? "This action already exists"
                  : error.code === "23503"
                    ? "Related item unavailable"
                    : error.message,
        requestId: res.getHeader("X-Request-Id"),
      });
    },
  );
  return app;
}
