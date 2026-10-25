import "dotenv/config";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client } from "pg";
import { config } from "../dist/config.js";

const admin = new Client({ connectionString: config.databaseUrl });
await admin.connect();
try {
  for (const [testFile, variable] of [
    ["tests/matchmaking.test.mjs", "MATCHMAKING_TEST_DATABASE_URL"],
    ["tests/online-play.test.mjs", "ONLINE_TEST_DATABASE_URL"],
  ]) {
    const name = `pokabow_progression_test_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(config.databaseUrl);
    url.pathname = `/${name}`;
    let created = false;
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      created = true;
      console.log(`Running ${testFile} in an isolated empty database.`);
      const result = spawnSync(process.execPath, ["--test", testFile], {
        cwd: process.cwd(), encoding: "utf8", env: { ...process.env, [variable]: url.toString() },
      });
      const report = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split(/\r?\n/)
        .filter(line => /[✔✖]|^ℹ|^  AssertionError|^  \d+ !== \d+|^test at |^  \w+Error/.test(line));
      for (const line of report) console.log(line);
      if (result.status !== 0) throw new Error(`${testFile} failed (exit ${result.status})`);
    } finally {
      if (created) {
        await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      }
    }
  }
  console.log("Progression database integration passed; disposable databases removed.");
} catch (error) {
  console.error(`Progression integration failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await admin.end();
}
