import { config } from "./config.js";
import { database, migrate } from "./database.js";
await migrate(database(config().databaseUrl));
console.info("Migrations applied");
process.exit(0);
