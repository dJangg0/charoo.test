import { config } from "./config.js";
import { database } from "./database.js";
const email = process.argv[2]?.toLowerCase(),
  role = process.argv[3] || "ADMIN";
if (!email || !["ADMIN", "MODERATOR", "SUPPORT"].includes(role))
  throw new Error(
    "Usage: npm run admin:grant -- email [ADMIN|MODERATOR|SUPPORT]",
  );
const result = await database(config().databaseUrl).query(
  "UPDATE users SET role=$2 WHERE email=$1 AND verified=true RETURNING id",
  [email, role],
);
if (!result.rows.length)
  throw new Error("Verify this email account before granting a role");
console.info("Role granted");
process.exit(0);
