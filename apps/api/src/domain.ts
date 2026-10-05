import { randomUUID } from "node:crypto";
import type { Database } from "./database.js";
import type { Realtime } from "./realtime.js";
import type { Config } from "./config.js";
import type { Settings } from "@charoo/contracts";
import { defaultSettings } from "@charoo/contracts";
import { requireThat } from "./errors.js";
import { decrypt, encrypt, hash, fingerprint } from "./crypto.js";
export interface Context {
  db: Database;
  rt: Realtime;
  config: Config;
  mail: (email: string, url: string) => Promise<void>;
  endCall?: (id: string) => Promise<void>;
}
export async function settings(db: Database): Promise<Settings> {
  return {
    ...defaultSettings,
    ...(await db.query("SELECT value FROM settings WHERE id=true")).rows[0]
      ?.value,
  };
}
export async function user(db: Database, id: string) {
  const u = (await db.query("SELECT * FROM users WHERE id=$1", [id])).rows[0];
  requireThat(u, 401, "Session expired");
  requireThat(
    !u.banned &&
      (!u.suspended_until ||
        new Date(u.suspended_until).getTime() <= Date.now()),
    403,
    "Account unavailable",
  );
  return u;
}
export function publicUser(u: any, status = "Offline") {
  return {
    id: u.id,
    displayName: u.display_name,
    verified: u.verified,
    role: u.role,
    profile: u.profile,
    status,
  };
}
export async function blocked(db: Database, a: string, b: string) {
  return !!(
    await db.query(
      "SELECT 1 FROM blocks WHERE (user_id=$1 AND target_id=$2) OR (user_id=$2 AND target_id=$1)",
      [a, b],
    )
  ).rows.length;
}
export async function eligible(ctx: Context, u: any) {
  requireThat(u.verified, 403, "Verify your email to use Available Tonight");
  requireThat(
    await ctx.rt.get(`presence:${u.id}`),
    403,
    "Go online to use Available Tonight",
  );
  requireThat(
    (await settings(ctx.db)).available_tonight_enabled,
    403,
    "Available Tonight is currently disabled",
  );
}
export async function member(
  db: Database,
  roomId: string,
  userId: string,
  write = false,
) {
  const row = (
    await db.query(
      "SELECT r.*,p.state AS participant_state,p.muted_until,p.last_message_at FROM rooms r LEFT JOIN participants p ON p.room_id=r.id AND p.user_id=$2 WHERE r.id=$1",
      [roomId, userId],
    )
  ).rows[0];
  requireThat(
    row && row.participant_state === "JOINED",
    404,
    "Conversation unavailable",
  );
  requireThat(
    row.state === "OPEN" &&
      (!row.expires_at || new Date(row.expires_at).getTime() > Date.now()),
    410,
    "This conversation has ended",
  );
  if (write)
    requireThat(
      !row.muted_until || new Date(row.muted_until).getTime() <= Date.now(),
      403,
      "You are muted in this room",
    );
  if (["STRANGER", "PRIVATE", "CONTACT"].includes(row.type)) {
    const peers = (
      await db.query(
        "SELECT user_id FROM participants WHERE room_id=$1 AND user_id<>$2",
        [roomId, userId],
      )
    ).rows;
    for (const p of peers)
      requireThat(
        !(await blocked(db, userId, p.user_id)),
        403,
        "Conversation unavailable",
      );
  }
  return row;
}
export async function createDirect(
  db: Database,
  a: string,
  b: string,
  type: string,
  cfg: Settings,
) {
  const id = randomUUID();
  await db.query(
    "INSERT INTO rooms(id,type,creator_id,title,slow_mode) VALUES($1,$2,$3,'Private conversation',1)",
    [id, type, a],
  );
  await db.query(
    "INSERT INTO participants(room_id,user_id) VALUES($1,$2),($1,$3)",
    [id, a, b],
  );
  return id;
}
export async function audit(
  db: Database,
  actor: string,
  action: string,
  target: string,
  details = {},
) {
  await db.query(
    "INSERT INTO audit_logs(id,actor_id,action,target_id,details) VALUES($1,$2,$3,$4,$5)",
    [randomUUID(), actor, action, target, JSON.stringify(details)],
  );
}
export function meaningful(
  text: string,
  lastFingerprint: string | null,
  lastAt: Date | null,
  now = Date.now(),
) {
  const normalized = text.toLocaleLowerCase().replace(/\s+/g, " ").trim();
  return (
    normalized.length >= 8 &&
    new Set(normalized).size >= 4 &&
    hash(normalized) !== lastFingerprint &&
    (!lastAt || now - new Date(lastAt).getTime() >= 3000)
  );
}
export async function serializeMessages(
  ctx: Context,
  rows: any[],
  viewerId: string,
) {
  if (!rows.length) return [];
  const senders = [...new Set(rows.map((m) => m.sender_id))],
    ids = rows.map((m) => m.id),
    rooms = [...new Set(rows.map((m) => m.room_id))];
  const hidden = new Set(
    (
      await ctx.db.query(
        "SELECT CASE WHEN user_id=$1 THEN target_id ELSE user_id END AS id FROM blocks WHERE (user_id=$1 AND target_id=ANY($2::uuid[])) OR (target_id=$1 AND user_id=ANY($2::uuid[]))",
        [viewerId, senders],
      )
    ).rows.map((b) => b.id),
  );
  const reactions = (
    await ctx.db.query(
      "SELECT message_id,user_id,emoji FROM reactions WHERE message_id=ANY($1::uuid[])",
      [ids],
    )
  ).rows;
  const readers = (
    await ctx.db.query(
      "SELECT room_id,user_id,read_at FROM participants WHERE room_id=ANY($1::uuid[]) AND read_at IS NOT NULL",
      [rooms],
    )
  ).rows;
  return rows
    .filter((m) => m.sender_id === viewerId || !hidden.has(m.sender_id))
    .map((m) => {
      const grouped: Record<string, string[]> = {};
      for (const r of reactions.filter((r) => r.message_id === m.id))
        (grouped[r.emoji] ??= []).push(r.user_id);
      return {
        id: m.id,
        roomId: m.room_id,
        senderId: m.sender_id,
        name: m.room_type === "STRANGER" ? "Stranger" : m.display_name,
        text: decrypt(m.ciphertext, ctx.config.key, m.room_id),
        createdAt: m.created_at,
        clientMessageId: m.client_message_id,
        replyTo: m.reply_to,
        attachmentId: m.attachment_id,
        reactions: grouped,
        readBy: ["STRANGER", "PRIVATE", "CONTACT"].includes(m.room_type)
          ? readers
              .filter(
                (r) =>
                  r.room_id === m.room_id &&
                  r.user_id !== m.sender_id &&
                  new Date(r.read_at).getTime() >=
                    new Date(m.created_at).getTime(),
              )
              .map((r) => r.user_id)
          : [],
      };
    });
}
export async function sendMessage(
  ctx: Context,
  u: any,
  roomId: string,
  body: any,
) {
  const cfg = await settings(ctx.db);
  const result = await ctx.db.transaction(async (db) => {
    await db.query("SELECT id FROM rooms WHERE id=$1 FOR UPDATE", [roomId]);
    const room = await member(db, roomId, u.id, true);
    if (room.type === "AVAILABLE_TONIGHT") await eligible(ctx, u);
    const old = (
      await db.query(
        "SELECT id FROM messages WHERE room_id=$1 AND sender_id=$2 AND client_message_id=$3",
        [roomId, u.id, body.clientMessageId],
      )
    ).rows[0];
    if (old) return { id: old.id, duplicate: true };
    requireThat(
      !room.last_message_at ||
        Date.now() - new Date(room.last_message_at).getTime() >=
          room.slow_mode * 1000,
      429,
      "Slow mode: wait before sending again",
    );
    if (body.replyTo)
      requireThat(
        (
          await db.query("SELECT 1 FROM messages WHERE id=$1 AND room_id=$2", [
            body.replyTo,
            roomId,
          ])
        ).rows.length,
        400,
        "Reply target unavailable",
      );
    if (body.attachmentId)
      requireThat(
        (
          await db.query(
            "SELECT 1 FROM attachments WHERE id=$1 AND room_id=$2 AND uploader_id=$3 AND state='APPROVED'",
            [body.attachmentId, roomId, u.id],
          )
        ).rows.length,
        400,
        "Attachment unavailable",
      );
    const id = randomUUID();
    await db.query(
      "INSERT INTO messages(id,room_id,sender_id,client_message_id,ciphertext,reply_to,attachment_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        id,
        roomId,
        u.id,
        body.clientMessageId,
        encrypt(body.text, ctx.config.key, roomId),
        body.replyTo || null,
        body.attachmentId || null,
      ],
    );
    const p = (
      await db.query(
        "SELECT * FROM participants WHERE room_id=$1 AND user_id=$2",
        [roomId, u.id],
      )
    ).rows[0];
    const fp = fingerprint(body.text, ctx.config.key, roomId);
    let qualifies = meaningful(body.text, null, p.last_qualifying_at);
    if (qualifies)
      qualifies = !!(
        await db.query(
          "INSERT INTO message_fingerprints(room_id,user_id,fingerprint) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING fingerprint",
          [roomId, u.id, fp],
        )
      ).rows.length;
    await db.query(
      "UPDATE participants SET last_message_at=now(),meaningful_count=meaningful_count+$3,last_fingerprint=CASE WHEN $3=1 THEN $4 ELSE last_fingerprint END,last_qualifying_at=CASE WHEN $3=1 THEN now() ELSE last_qualifying_at END WHERE room_id=$1 AND user_id=$2",
      [roomId, u.id, qualifies ? 1 : 0, fp],
    );
    await db.query("UPDATE rooms SET last_activity=now() WHERE id=$1", [
      roomId,
    ]);
    if (room.type === "STRANGER" && !room.asl_revealed) {
      const counts = (
        await db.query(
          "SELECT meaningful_count FROM participants WHERE room_id=$1",
          [roomId],
        )
      ).rows.map((v) => v.meaningful_count);
      if (
        counts.length === 2 &&
        counts.every((n) => n >= cfg.minimum_messages_per_user) &&
        counts.reduce((a, b) => a + b, 0) >= cfg.asl_reveal_threshold &&
        Date.now() - new Date(room.created_at).getTime() >=
          cfg.asl_minimum_duration_seconds * 1000
      )
        await db.query("UPDATE rooms SET asl_revealed=true WHERE id=$1", [
          roomId,
        ]);
    }
    return { id, duplicate: false };
  });
  if (!result.duplicate)
    await ctx.rt.publish({
      type: "message",
      roomId,
      payload: { id: result.id },
    });
  return result;
}
export async function closeRoom(ctx: Context, roomId: string, actorId: string) {
  const cfg = await settings(ctx.db);
  await ctx.db.transaction(async (db) => {
    const changed = await db.query(
      "UPDATE rooms SET state='CLOSED',closed_at=now(),purge_at=now()+($2*interval '1 hour') WHERE id=$1 AND state='OPEN' RETURNING id",
      [roomId, cfg.conversation_retention_hours],
    );
    if (changed.rows.length) await audit(db, actorId, "room.close", roomId);
  });
  await terminateCalls(ctx, "room_id=$1", [roomId]);
  await ctx.rt.publish({ type: "room.closed", roomId });
  await ctx.rt.publish({ type: "discovery.changed" });
}
export async function match(ctx: Context, u: any) {
  const cfg = await settings(ctx.db);
  requireThat(
    u.verified || cfg.guest_access_enabled,
    403,
    "Guest matching disabled",
  );
  requireThat(await ctx.rt.get(`presence:${u.id}`), 403, "Go online first");
  const outcome = await ctx.db.transaction(async (db) => {
    // A PostgreSQL transaction lock fences matcher replicas even if a Redis lease expires.
    await db.query("SELECT pg_advisory_xact_lock(901002)");
    const active = (
      await db.query(
        "SELECT r.id FROM rooms r JOIN participants p ON p.room_id=r.id WHERE p.user_id=$1 AND p.state='JOINED' AND r.type='STRANGER' AND r.state='OPEN' ORDER BY r.created_at DESC LIMIT 1",
        [u.id],
      )
    ).rows[0];
    if (active) return { roomId: active.id };
    await ctx.rt.queue(u.id, Date.now());
    await ctx.rt.set(`match:waiting:${u.id}`, "1", 90);
    for (const id of await ctx.rt.candidates()) {
      if (id === u.id) continue;
      if (
        !(await ctx.rt.get(`presence:${id}`)) ||
        !(await ctx.rt.get(`match:waiting:${id}`))
      ) {
        await ctx.rt.dequeue(id);
        continue;
      }
      const other = (
        await db.query(
          "SELECT * FROM users WHERE id=$1 AND banned=false AND (suspended_until IS NULL OR suspended_until<=now())",
          [id],
        )
      ).rows[0];
      if (!other || (!other.verified && !cfg.guest_access_enabled)) continue;
      if (await blocked(db, u.id, id)) continue;
      const [a, b] = [u.id, id].sort();
      if (
        (
          await db.query(
            "SELECT 1 FROM match_history WHERE user_a=$1 AND user_b=$2 AND matched_at>now()-interval '30 minutes'",
            [a, b],
          )
        ).rows.length
      )
        continue;
      if (
        (
          await db.query(
            "SELECT 1 FROM rooms r JOIN participants p ON p.room_id=r.id WHERE p.user_id=$1 AND p.state='JOINED' AND r.type='STRANGER' AND r.state='OPEN'",
            [id],
          )
        ).rows.length
      )
        continue;
      const roomId = await createDirect(db, u.id, id, "STRANGER", cfg);
      await db.query(
        "INSERT INTO match_history(user_a,user_b,room_id) VALUES($1,$2,$3) ON CONFLICT(user_a,user_b) DO UPDATE SET room_id=$3,matched_at=now()",
        [a, b, roomId],
      );
      await ctx.rt.dequeue(u.id);
      await ctx.rt.dequeue(id);
      await ctx.rt.del(`match:waiting:${u.id}`);
      await ctx.rt.del(`match:waiting:${id}`);
      return { roomId, peerId: id };
    }
    return { queued: true };
  });
  if ("roomId" in outcome)
    await ctx.rt.publish({
      type: "matched",
      userIds: [u.id, ...("peerId" in outcome ? [outcome.peerId] : [])],
      payload: { roomId: outcome.roomId },
    });
  return outcome;
}
export async function cleanup(ctx: Context) {
  const cfg = await settings(ctx.db);
  for (const id of await ctx.rt.candidates()) {
    if (
      !(await ctx.rt.get(`presence:${id}`)) ||
      !(await ctx.rt.get(`match:waiting:${id}`))
    )
      await ctx.rt.dequeue(id);
  }
  const expired = (
    await ctx.db.query(
      "UPDATE rooms SET state='CLOSED',closed_at=now(),purge_at=now()+($1*interval '1 hour') WHERE state='OPEN' AND ((expires_at IS NOT NULL AND expires_at<=now()) OR (type IN ('STRANGER','PRIVATE') AND last_activity<now()-($1*interval '1 hour'))) RETURNING id",
      [cfg.conversation_retention_hours],
    )
  ).rows;
  for (const r of expired)
    await ctx.rt.publish({ type: "room.closed", roomId: r.id });
  if (expired.length) await ctx.rt.publish({ type: "discovery.changed" });
  await ctx.db.transaction(async (db) => {
    await db.query(
      "INSERT INTO object_deletions(object_key) SELECT a.object_key FROM attachments a JOIN rooms r ON r.id=a.room_id WHERE r.purge_at<=now() OR (a.state<>'APPROVED' AND a.created_at<now()-interval '1 hour') ON CONFLICT DO NOTHING",
    );
    await db.query(
      "DELETE FROM attachments WHERE state<>'APPROVED' AND created_at<now()-interval '1 hour'",
    );
    await db.query("DELETE FROM rooms WHERE purge_at<=now()");
    await db.query("DELETE FROM sessions WHERE expires_at<=now()");
    await db.query("DELETE FROM email_tokens WHERE expires_at<=now()");
    const guests = (
      await db.query(
        "SELECT u.id FROM users u WHERE verified=false AND guest_expires_at<=now() AND NOT EXISTS(SELECT 1 FROM rooms r WHERE r.creator_id=u.id) AND NOT EXISTS(SELECT 1 FROM participants p WHERE p.user_id=u.id) AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.sender_id=u.id) LIMIT 100",
      )
    ).rows;
    for (const g of guests) {
      await db.query(
        "UPDATE reports SET reporter_id=NULL WHERE reporter_id=$1",
        [g.id],
      );
      await db.query("UPDATE reports SET target_id=NULL WHERE target_id=$1", [
        g.id,
      ]);
      await db.query("UPDATE audit_logs SET actor_id=NULL WHERE actor_id=$1", [
        g.id,
      ]);
      await db.query("DELETE FROM blocks WHERE user_id=$1 OR target_id=$1", [
        g.id,
      ]);
      await db.query("DELETE FROM match_history WHERE user_a=$1 OR user_b=$1", [
        g.id,
      ]);
      await db.query("DELETE FROM users WHERE id=$1", [g.id]);
    }

    await db.query(
      "UPDATE social_requests SET state='REJECTED' WHERE state='PENDING' AND expires_at<=now()",
    );
    await db.query(
      "UPDATE calls SET state='ENDED' WHERE state<>'ENDED' AND expires_at<=now()",
    );
  });
}

export async function terminateCalls(
  ctx: Context,
  condition: string,
  params: string[],
) {
  const rows = (
    await ctx.db.query(
      `UPDATE calls SET state='ENDED' WHERE state<>'ENDED' AND (${condition}) RETURNING id,caller_id,target_id`,
      params,
    )
  ).rows;
  for (const c of rows) {
    if (ctx.endCall) {
      try {
        await ctx.endCall(c.id);
        await ctx.db.query(
          "UPDATE calls SET media_terminated=true WHERE id=$1",
          [c.id],
        );
      } catch {
        console.error(
          JSON.stringify({
            event: "call.termination.retry",
            code: "PROVIDER_UNAVAILABLE",
          }),
        );
      }
    }
    await ctx.rt.publish({
      type: "call.changed",
      userIds: [c.caller_id, c.target_id],
    });
  }
}
