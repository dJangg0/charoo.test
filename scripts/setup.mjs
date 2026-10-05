import { copyFile, readFile, writeFile, access } from "node:fs/promises";
import { randomBytes } from "node:crypto";
try {
  await access(".env");
  console.info(".env exists; keeping its values.");
} catch {
  await copyFile(".env.example", ".env");
  const content = await readFile(".env", "utf8");
  await writeFile(
    ".env",
    content.replace(
      "MESSAGE_KEY=\n",
      `MESSAGE_KEY=${randomBytes(32).toString("base64")}\n`,
    ),
  );
  console.info(
    "Created .env with a new message encryption key. Keep it backed up securely.",
  );
}
