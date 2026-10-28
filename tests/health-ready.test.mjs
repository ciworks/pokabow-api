import { test } from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = "health-readiness-tests-only-at-least-thirty-two-bytes";
const { buildApp } = await import("../dist/app.js");
const { db } = await import("../dist/db.js");

test("readiness reports database reachability without leaking errors", async () => {
  const app = buildApp();
  await app.ready();
  const originalQuery = db.query;
  try {
    db.query = async () => ({ rows: [{ "?column?": 1 }] });
    const ready = await app.inject("/health/ready");
    assert.equal(ready.statusCode, 200);
    assert.deepEqual(ready.json(), { status: "ok" });
    assert.equal(ready.headers["cache-control"], "no-store");

    db.query = async () => { throw new Error("Private database detail"); };
    const unavailable = await app.inject("/health/ready");
    assert.equal(unavailable.statusCode, 503);
    assert.deepEqual(unavailable.json(), { status: "unavailable" });
    assert.equal(unavailable.body.includes("Private database detail"), false);
  } finally {
    db.query = originalQuery;
    await app.close();
  }
});
