import { createServer } from "node:http";
import { WebSocket } from "ws";
import { attachGateway } from "../src/gateway.js";
import { MemoryRealtime, testDatabase } from "./helpers.js";
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import request from "supertest";
import { randomBytes, randomUUID } from "node:crypto";
import { app } from "../src/app.js";
import { migrate, type Database } from "../src/database.js";
import { defaultSettings, type Event } from "@charoo/contracts";
import { type Realtime } from "../src/realtime.js";
import { type Context, cleanup, meaningful } from "../src/domain.js";
import { encrypt, decrypt } from "../src/crypto.js";
let pg: PGlite,
  db: Database,
  ctx: Context,
  application: ReturnType<typeof app>,
  rt: MemoryRealtime;
let sent: { email: string; url: string }[] = [];
const origin = "http://localhost:5173";
beforeAll(async () => {
  pg = new PGlite();
  db = testDatabase(pg);
  await migrate(db);
}, 30000);
beforeEach(async () => {
  await db.query("TRUNCATE users CASCADE");
  await db.query("TRUNCATE object_deletions");
  await db.query("UPDATE settings SET value=$1", [
    JSON.stringify(defaultSettings),
  ]);
  rt = new MemoryRealtime();
  sent = [];
  ctx = {
    db,
    rt,
    config: {
      production: false,
      origin,
      key: randomBytes(32),
      port: 3000,
      databaseUrl: "",
      redisUrl: "",
      smtpUrl: "smtp://test",
      emailFrom: "test@example.com",
    },
    mail: async (email, url) => {
      sent.push({ email, url });
    },
  };
  application = app(ctx);
});
afterAll(async () => pg.close());
async function guest() {
  const agent = request.agent(application);
  const result = await agent
    .post("/api/auth/guest")
    .set("Origin", origin)
    .send({ adultConsent: true });
  expect(result.status).toBe(201);
  return {
    agent,
    user: result.body.user,
    csrf: result.body.csrf,
    cookie: result.headers["set-cookie"][0].split(";")[0],
  };
}
async function verified(email = `${randomUUID()}@example.com`) {
  const g = await guest();
  expect(
    (await post(g, "/auth/email", { email, adultConsent: true })).status,
  ).toBe(200);
  const token = new URLSearchParams(sent.at(-1)!.url.split("#")[1]).get(
    "verify",
  );
  const result = await g.agent
    .post("/api/auth/verify")
    .set("Origin", origin)
    .send({ token });
  expect(result.status).toBe(200);
  g.csrf = result.body.csrf;
  g.cookie = result.headers["set-cookie"][0].split(";")[0];
  g.user = result.body.user;
  await post(g, "/presence", { status: "Online" });
  return g;
}
function post(g: any, path: string, body: any) {
  return g.agent
    .post(`/api${path}`)
    .set("Origin", origin)
    .set("X-CSRF-Token", g.csrf)
    .send(body);
}
async function room(g: any, type = "SHARED_GROUP") {
  const result = await post(g, "/rooms", {
    type,
    title: "Coffee and conversation",
    description: "Say hello",
    category: "Conversation",
    tags: ["coffee"],
  });
  expect(result.status).toBe(201);
  return result.body;
}
async function pair() {
  const a = await guest(),
    b = await guest();
  await post(a, "/presence", { status: "Online" });
  await post(b, "/presence", { status: "Online" });
  expect((await post(a, "/match", {})).body.queued).toBe(true);
  const result = await post(b, "/match", {});
  expect(result.status).toBe(200);
  return { a, b, id: result.body.roomId };
}
describe("identity and request boundaries", () => {
  it("requires an adult assertion and a trusted mutation origin", async () => {
    expect(
      (
        await request(application)
          .post("/api/auth/guest")
          .set("Origin", origin)
          .send({ adultConsent: false })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(application)
          .post("/api/auth/guest")
          .set("Origin", "https://evil.example")
          .send({ adultConsent: true })
      ).status,
    ).toBe(403);
  });
  it("upgrades a guest in place and consumes the email token once", async () => {
    const g = await guest(),
      id = g.user.id;
    await post(g, "/auth/email", {
      email: "alice@example.com",
      adultConsent: true,
    });
    const t = new URLSearchParams(sent[0].url.split("#")[1]).get("verify");
    const first = await g.agent
      .post("/api/auth/verify")
      .set("Origin", origin)
      .send({ token: t });
    expect(first.body.user.id).toBe(id);
    expect(first.body.user.verified).toBe(true);
    expect(
      (
        await g.agent
          .post("/api/auth/verify")
          .set("Origin", origin)
          .send({ token: t })
      ).status,
    ).toBe(400);
    expect((await post(g, "/presence", { status: "Online" })).status).toBe(403);
  });
  it("requires CSRF and does not let a guest set verified or admin state", async () => {
    const g = await guest();
    expect(
      (
        await g.agent
          .post("/api/presence")
          .set("Origin", origin)
          .send({ status: "Online" })
      ).status,
    ).toBe(403);
    const p = {
      displayName: "Alice",
      age: 25,
      gender: "",
      region: "Iloilo",
      bio: "",
      interests: [],
      aslVisibility: "private",
      verified: true,
      role: "ADMIN",
    };
    expect(
      (
        await g.agent
          .patch("/api/me/profile")
          .set("Origin", origin)
          .set("X-CSRF-Token", g.csrf)
          .send(p)
      ).status,
    ).toBe(200);
    const me = await g.agent.get("/api/me");
    expect(me.body.user.verified).toBe(false);
    expect(me.body.user.role).toBe("USER");
  });
  it("does not overwrite an existing verified account when another guest signs in", async () => {
    const a = await verified("owner@example.com"),
      g = await guest();
    await post(g, "/auth/email", {
      email: "owner@example.com",
      adultConsent: true,
    });
    const t = new URLSearchParams(sent.at(-1)!.url.split("#")[1]).get("verify");
    const result = await g.agent
      .post("/api/auth/verify")
      .set("Origin", origin)
      .send({ token: t });
    expect(result.body.user.id).toBe(a.user.id);
    expect(
      (await db.query("SELECT verified FROM users WHERE id=$1", [g.user.id]))
        .rows[0].verified,
    ).toBe(false);
  });
});
describe("separate public and unlisted rooms", () => {
  it("rejects guests from the public hub but permits secure-link group joins", async () => {
    const a = await guest(),
      b = await guest();
    expect((await a.agent.get("/api/rooms")).status).toBe(403);
    expect(
      (
        await post(a, "/rooms", {
          type: "AVAILABLE_TONIGHT",
          title: "Hello world",
        })
      ).status,
    ).toBe(403);
    const r = await room(a);
    expect((await b.agent.get(`/api/rooms/${r.id}`)).status).toBe(404);
    const link = new URLSearchParams(r.shareUrl.split("#")[1]).get("room");
    expect((await post(b, "/shared/join", { token: link })).status).toBe(200);
    expect((await b.agent.get(`/api/rooms/${r.id}`)).status).toBe(200);
    expect((await post(b, `/rooms/${r.id}/join`, {})).status).toBe(404);
  });
  it("keeps shared groups out of discovery and enforces verified-only links", async () => {
    const a = await verified(),
      b = await guest();
    await room(a);
    await room(a, "AVAILABLE_TONIGHT");
    const feed = await a.agent.get("/api/rooms");
    expect(feed.body.rooms).toHaveLength(1);
    expect(feed.body.rooms[0].type).toBe("AVAILABLE_TONIGHT");
    expect(feed.body.rooms[0].share_hash).toBeUndefined();
    const r = await post(a, "/rooms", {
      type: "SHARED_GROUP",
      title: "Verified room",
      verifiedOnly: true,
    });
    const t = new URLSearchParams(r.body.shareUrl.split("#")[1]).get("room");
    expect((await post(b, "/shared/join", { token: t })).status).toBe(403);
  });
  it("does not let a removed participant rejoin or send messages", async () => {
    const a = await verified(),
      b = await verified(),
      r = await room(a, "AVAILABLE_TONIGHT");
    await post(b, `/rooms/${r.id}/join`, {});
    await post(a, `/rooms/${r.id}/moderate`, {
      action: "REMOVE",
      targetId: b.user.id,
    });
    expect((await post(b, `/rooms/${r.id}/join`, {})).status).toBe(403);
    expect(
      (
        await post(b, `/rooms/${r.id}/messages`, {
          clientMessageId: randomUUID(),
          text: "Hello there",
        })
      ).status,
    ).toBe(404);
  });
  it("rejects expired rooms before a cleanup job runs", async () => {
    const a = await guest(),
      r = await room(a);
    await db.query(
      "UPDATE rooms SET expires_at=now()-interval '1 minute' WHERE id=$1",
      [r.id],
    );
    expect((await a.agent.get(`/api/rooms/${r.id}/messages`)).status).toBe(410);
  });
  it("does not renew Available Tonight status on heartbeats", async () => {
    const a = await verified();
    await post(a, "/presence", {
      status: "Available Tonight",
      heartbeat: false,
    });
    await rt.del(`available:${a.user.id}`);
    const response = await post(a, "/presence", {
      status: "Available Tonight",
      heartbeat: true,
    });
    expect(response.body.status).toBe("Online");
    expect(await rt.get(`available:${a.user.id}`)).toBeNull();
  });
});
describe("reliable private messaging and matching", () => {
  it("stores ciphertext and deduplicates a lost-ack REST retry", async () => {
    const { a, b, id } = await pair();
    const input = {
      clientMessageId: randomUUID(),
      text: "Hello, how is your evening?",
    };
    const first = await post(a, `/rooms/${id}/messages`, input),
      second = await post(a, `/rooms/${id}/messages`, input);
    expect(first.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.duplicate).toBe(true);
    const rows = (await db.query("SELECT ciphertext FROM messages")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].ciphertext).not.toContain(input.text);
    const history = await b.agent.get(`/api/rooms/${id}/messages`);
    expect(history.body.messages[0].text).toBe(input.text);
    expect(history.body.messages[0].name).toBe("Stranger");
  });
  it("returns the existing match instead of creating a simultaneous second match", async () => {
    const { a, id } = await pair();
    const repeat = await post(a, "/match", {});
    expect(repeat.body.roomId).toBe(id);
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM rooms WHERE type='STRANGER'",
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("prevents blocked users from matching or accessing private history", async () => {
    const { a, b, id } = await pair();
    await post(a, "/blocks", { targetId: b.user.id });
    expect((await b.agent.get(`/api/rooms/${id}/messages`)).status).toBe(403);
    await db.query("UPDATE rooms SET state='CLOSED' WHERE id=$1", [id]);
    expect((await post(a, "/match", {})).body.queued).toBe(true);
    expect((await post(b, "/match", {})).body.queued).toBe(true);
  });
  it("only reveals opted-in ASL after balanced qualifying participation and duration", async () => {
    const { a, b, id } = await pair();
    await db.query(
      "UPDATE rooms SET created_at=now()-interval '5 minutes',slow_mode=0 WHERE id=$1",
      [id],
    );
    await db.query("UPDATE settings SET value=$1", [
      JSON.stringify({
        ...defaultSettings,
        asl_reveal_threshold: 2,
        minimum_messages_per_user: 1,
      }),
    ]);
    const profile = {
      displayName: "My name",
      age: 26,
      gender: "Female",
      region: "Iloilo",
      bio: "",
      interests: [],
      aslVisibility: "public",
    };
    await a.agent
      .patch("/api/me/profile")
      .set("Origin", origin)
      .set("X-CSRF-Token", a.csrf)
      .send(profile);
    await post(a, `/rooms/${id}/messages`, {
      clientMessageId: randomUUID(),
      text: "hey",
    });
    expect((await a.agent.get(`/api/rooms/${id}`)).body.asl_revealed).toBe(
      false,
    );
    await post(a, `/rooms/${id}/messages`, {
      clientMessageId: randomUUID(),
      text: "What is your favorite book?",
    });
    expect((await a.agent.get(`/api/rooms/${id}`)).body.asl_revealed).toBe(
      false,
    );
    await post(b, `/rooms/${id}/messages`, {
      clientMessageId: randomUUID(),
      text: "I like science fiction novels.",
    });
    const result = await b.agent.get(`/api/rooms/${id}`);
    expect(result.body.asl_revealed).toBe(true);
    expect(
      result.body.participants.find((p: any) => p.id === a.user.id).asl.region,
    ).toBe("Iloilo");
  });
  it("rejects spam as qualifying participation", () => {
    expect(meaningful("hi", null, null)).toBe(false);
    expect(meaningful("aaaaaaaaaaaaaaaa", null, null)).toBe(false);
    expect(meaningful("Hello friend", null, new Date())).toBe(false);
    expect(meaningful("Hello friend", null, null)).toBe(true);
  });
});
describe("consent and moderation", () => {
  it("creates a private conversation only after the recipient accepts", async () => {
    const a = await verified(),
      b = await verified(),
      r = await room(a, "AVAILABLE_TONIGHT");
    await post(b, `/rooms/${r.id}/join`, {});
    const sent = await post(a, "/requests", {
      targetId: b.user.id,
      roomId: r.id,
      kind: "PRIVATE",
    });
    expect(
      (await db.query("SELECT 1 FROM rooms WHERE type='PRIVATE'")).rows,
    ).toHaveLength(0);
    expect(
      (await post(a, `/requests/${sent.body.id}/respond`, { accept: true }))
        .status,
    ).toBe(404);
    const accepted = await post(b, `/requests/${sent.body.id}/respond`, {
      accept: true,
    });
    expect(accepted.body.roomId).toBeTruthy();
    expect(
      (await a.agent.get(`/api/rooms/${accepted.body.roomId}`)).status,
    ).toBe(200);
  });
  it("enforces staff roles and audits settings changes", async () => {
    const a = await verified();
    expect((await a.agent.get("/api/admin/dashboard")).status).toBe(403);
    await db.query("UPDATE users SET role='SUPPORT' WHERE id=$1", [a.user.id]);
    expect((await a.agent.get("/api/admin/dashboard")).status).toBe(200);
    expect(
      (
        await a.agent
          .patch("/api/admin/settings")
          .set("Origin", origin)
          .set("X-CSRF-Token", a.csrf)
          .send(defaultSettings)
      ).status,
    ).toBe(403);
    await db.query("UPDATE users SET role='ADMIN' WHERE id=$1", [a.user.id]);
    expect(
      (
        await a.agent
          .patch("/api/admin/settings")
          .set("Origin", origin)
          .set("X-CSRF-Token", a.csrf)
          .send(defaultSettings)
      ).status,
    ).toBe(200);
    expect(
      (
        await db.query(
          "SELECT 1 FROM audit_logs WHERE action='settings.update'",
        )
      ).rows,
    ).toHaveLength(1);
  });
  it("fails closed for unconfigured providers", async () => {
    const { a, b, id } = await pair();
    expect(
      (await post(a, "/calls", { roomId: id, targetId: b.user.id })).status,
    ).toBe(503);
    expect(
      (await post(a, "/assistant", { roomId: id, style: "icebreaker" })).status,
    ).toBe(503);
    expect(
      (
        await post(a, "/media/init", {
          roomId: id,
          name: "photo.jpg",
          mime: "image/jpeg",
          size: 1234,
        })
      ).status,
    ).toBe(503);
  });
  it("purges expired conversations and queues object deletion server-side", async () => {
    const a = await guest(),
      r = await room(a);
    await post(a, `/rooms/${r.id}/messages`, {
      clientMessageId: randomUUID(),
      text: "Ephemeral conversation",
    });
    await db.query(
      "INSERT INTO attachments(id,room_id,uploader_id,object_key,name,mime,size,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        randomUUID(),
        r.id,
        a.user.id,
        "quarantine/test",
        "photo.jpg",
        "image/jpeg",
        1,
        "APPROVED",
      ],
    );
    await db.query(
      "UPDATE rooms SET state='CLOSED',purge_at=now()-interval '1 minute' WHERE id=$1",
      [r.id],
    );
    await cleanup(ctx);
    expect((await db.query("SELECT 1 FROM messages")).rows).toHaveLength(0);
    expect(
      (await db.query("SELECT object_key FROM object_deletions")).rows[0]
        .object_key,
    ).toBe("quarantine/test");
  });
  it("rejects tampering with ciphertext or moving it to another conversation", () => {
    const key = randomBytes(32),
      id = randomUUID(),
      body = encrypt("secret", key, id);
    expect(decrypt(body, key, id)).toBe("secret");
    expect(() => decrypt(body, key, randomUUID())).toThrow();
    expect(() => decrypt(body, randomBytes(32), id)).toThrow();
  });
});

describe("WebSocket authorization and transport retries", () => {
  it("accepts an authenticated WS send and deduplicates its REST fallback", async () => {
    const { a, id } = await pair();
    const server = createServer(application),
      gateway = attachGateway(server, ctx);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as { port: number };
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/ws`, {
      headers: { Origin: origin, Cookie: a.cookie },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      const payload = {
        clientMessageId: randomUUID(),
        text: "Reliable across transports",
      };
      const ack = new Promise<any>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("No WS ack")), 3000);
        ws.on("message", (value) => {
          const e = JSON.parse(value.toString());
          if (e.type === "ack") {
            clearTimeout(t);
            resolve(e.payload);
          }
        });
      });
      ws.send(JSON.stringify({ type: "message", roomId: id, payload }));
      const received = await ack;
      expect(received.clientMessageId).toBe(payload.clientMessageId);
      const fallback = await post(a, `/rooms/${id}/messages`, payload);
      expect(fallback.body.id).toBe(received.id);
      expect(fallback.body.duplicate).toBe(true);
    } finally {
      ws.terminate();
      gateway.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("rejects an outsider room subscription", async () => {
    const a = await guest(),
      b = await guest(),
      r = await room(a);
    const server = createServer(application),
      gateway = attachGateway(server, ctx);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as { port: number };
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/ws`, {
      headers: { Origin: origin, Cookie: b.cookie },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      const response = new Promise<any>((resolve) =>
        ws.once("message", (body) => resolve(JSON.parse(body.toString()))),
      );
      ws.send(JSON.stringify({ type: "subscribe", roomId: r.id }));
      const event = await response;
      expect(event.type).toBe("error");
      expect(event.payload.message).toBe("Conversation unavailable");
    } finally {
      ws.terminate();
      gateway.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
describe("stable paging and reveal abuse controls", () => {
  it("does not lose discovery rooms that have identical creation timestamps", async () => {
    const a = await verified();
    for (let i = 0; i < 31; i++)
      await db.query(
        "INSERT INTO rooms(id,type,creator_id,title,created_at,expires_at) VALUES($1,'AVAILABLE_TONIGHT',$2,$3,date_trunc('second',now()),now()+interval '1 hour')",
        [randomUUID(), a.user.id, `Room number ${i}`],
      );
    const first = await a.agent.get("/api/rooms");
    expect(first.body.rooms).toHaveLength(30);
    const second = await a.agent.get(
      `/api/rooms?before=${encodeURIComponent(first.body.next)}`,
    );
    expect(second.body.rooms).toHaveLength(1);
    expect(
      new Set([...first.body.rooms, ...second.body.rooms].map((r) => r.id))
        .size,
    ).toBe(31);
  });
  it("counts an identical meaningful message only once even when sent later", async () => {
    const { a, id } = await pair();
    await db.query("UPDATE rooms SET slow_mode=0 WHERE id=$1", [id]);
    for (let i = 0; i < 3; i++) {
      await db.query(
        "UPDATE participants SET last_qualifying_at=now()-interval '10 seconds' WHERE room_id=$1",
        [id],
      );
      expect(
        (
          await post(a, `/rooms/${id}/messages`, {
            clientMessageId: randomUUID(),
            text: "Meaningful but repeated message",
          })
        ).status,
      ).toBe(201);
    }
    const p = (
      await db.query(
        "SELECT meaningful_count FROM participants WHERE room_id=$1 AND user_id=$2",
        [id, a.user.id],
      )
    ).rows[0];
    expect(p.meaningful_count).toBe(1);
  });
});

describe("persistent contacts and call consent withdrawal", () => {
  it("keeps a saved contact conversation available when its chat view is left", async () => {
    const a = await verified(),
      b = await verified(),
      r = await room(a, "AVAILABLE_TONIGHT");
    await post(b, `/rooms/${r.id}/join`, {});
    const request = await post(a, "/requests", {
      targetId: b.user.id,
      roomId: r.id,
      kind: "CONTACT",
    });
    const accepted = await post(b, `/requests/${request.body.id}/respond`, {
      accept: true,
    });
    const id = accepted.body.roomId;
    expect((await post(a, `/rooms/${id}/leave`, {})).status).toBe(204);
    expect((await a.agent.get(`/api/rooms/${id}`)).status).toBe(200);
    expect((await b.agent.get("/api/contacts")).body[0].room_id).toBe(id);
  });
  it("ends the call and invokes media revocation when a participant blocks the other", async () => {
    const { a, b, id } = await pair();
    const callId = randomUUID();
    await db.query(
      "INSERT INTO calls(id,room_id,caller_id,target_id,state) VALUES($1,$2,$3,$4,'ACCEPTED')",
      [callId, id, a.user.id, b.user.id],
    );
    const ended: string[] = [];
    ctx.endCall = async (id) => {
      ended.push(id);
    };
    expect((await post(a, "/blocks", { targetId: b.user.id })).status).toBe(
      204,
    );
    expect(ended).toEqual([callId]);
    expect(
      (
        await db.query("SELECT state,media_terminated FROM calls WHERE id=$1", [
          callId,
        ])
      ).rows[0],
    ).toEqual({ state: "ENDED", media_terminated: true });
  });
});
