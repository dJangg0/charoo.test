import { Redis } from "ioredis";
import type { Event } from "@charoo/contracts";
export interface Realtime {
  set(key: string, value: string, ttl: number): Promise<void>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<void>;
  limit(key: string, max: number, seconds: number): Promise<boolean>;
  queue(userId: string, score: number): Promise<void>;
  dequeue(userId: string): Promise<void>;
  candidates(): Promise<string[]>;
  publish(event: Event): Promise<void>;
  subscribe(handler: (event: Event) => void): void;
  roomPresence(roomId: string, userId: string): Promise<void>;
  roomCount(roomId: string): Promise<number>;
}
export function realtime(url: string): Realtime {
  const redis = new Redis(url),
    sub = new Redis(url);
  const handlers: ((event: Event) => void)[] = [];
  sub.subscribe("charoo:events");
  sub.on("message", (_, body) => {
    try {
      const event = JSON.parse(body);
      handlers.forEach((h) => h(event));
    } catch {}
  });
  return {
    set: async (k, v, t) => {
      await redis.set(k, v, "EX", t);
    },
    get: (k) => redis.get(k),
    del: async (k) => {
      await redis.del(k);
    },
    limit: async (k, max, seconds) =>
      Number(
        await redis.eval(
          "local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end;return n",
          1,
          `limit:${k}`,
          seconds,
        ),
      ) <= max,
    queue: async (id, score) => {
      await redis.zadd("match:queue", score, id);
    },
    dequeue: async (id) => {
      await redis.zrem("match:queue", id);
    },
    candidates: () => redis.zrange("match:queue", 0, 199),
    publish: async (e) => {
      await redis.publish("charoo:events", JSON.stringify(e));
    },
    subscribe: (h) => {
      handlers.push(h);
    },
    roomPresence: async (room, id) => {
      await redis.zadd(`room:${room}:online`, Date.now(), id);
      await redis.expire(`room:${room}:online`, 120);
    },
    roomCount: async (room) => {
      await redis.zremrangebyscore(
        `room:${room}:online`,
        0,
        Date.now() - 90000,
      );
      return redis.zcard(`room:${room}:online`);
    },
  };
}
