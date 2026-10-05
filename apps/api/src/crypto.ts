import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
export const token = () => randomBytes(32).toString("base64url");
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function encrypt(text: string, key: Buffer, roomId: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(roomId));
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body]
    .map((v) => v.toString("base64"))
    .join(".");
}
export function decrypt(value: string, key: Buffer, roomId: string) {
  const [iv, tag, body] = value.split(".").map((v) => Buffer.from(v, "base64"));
  const cipher = createDecipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(roomId));
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(body), cipher.final()]).toString("utf8");
}

export const fingerprint = (text: string, key: Buffer, roomId: string) =>
  createHmac("sha256", key)
    .update(roomId)
    .update(text.toLocaleLowerCase().replace(/\s+/g, " ").trim())
    .digest("hex");
