import { PGlite } from "@electric-sql/pglite";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { app } from "../src/app.js";
import { attachGateway } from "../src/gateway.js";
import { migrate } from "../src/database.js";
import { MemoryRealtime, testDatabase } from "./helpers.js";
const pg = new PGlite(),
  db = testDatabase(pg);
await migrate(db);
const ctx = {
  db,
  rt: new MemoryRealtime(),
  config: {
    production: false,
    origin: "http://localhost:5173",
    key: randomBytes(32),
    port: 3000,
    databaseUrl: "",
    redisUrl: "",
    smtpUrl: "",
    emailFrom: "",
  },
  mail: async () => {
    throw new Error("Browser test uses guest sessions only");
  },
};
const server = createServer(app(ctx));
attachGateway(server, ctx);
server.listen(3000, () => console.log("Test API ready"));
