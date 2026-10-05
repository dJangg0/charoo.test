export function config() {
  const production = process.env.NODE_ENV === "production";
  const origin = process.env.WEB_ORIGIN || "http://localhost:5173";
  const key = Buffer.from(process.env.MESSAGE_KEY || "", "base64");
  if (key.length !== 32)
    throw new Error("MESSAGE_KEY must be a base64 encoded 32-byte secret");
  if (production && !origin.startsWith("https://"))
    throw new Error("Production WEB_ORIGIN must use HTTPS");
  return {
    production,
    origin,
    key,
    port: Number(process.env.PORT || 3000),
    databaseUrl:
      process.env.DATABASE_URL ||
      "postgres://charoo:charoo@localhost:5432/charoo",
    redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
    smtpUrl: process.env.SMTP_URL || "",
    emailFrom: process.env.EMAIL_FROM || "Charoo <hello@localhost>",
  };
}
export type Config = ReturnType<typeof config>;
