import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.JWT_SECRET = "tournament-route-tests-only-at-least-thirty-two-bytes";
const { buildApp } = await import("../dist/app.js");
const { db } = await import("../dist/db.js");

test("tournament reads and mutations require bearer authentication", async () => {
  const app = buildApp();
  await app.ready();
  try {
    for (const [method, url] of [
      ["GET", "/tournaments"], ["GET", `/tournaments/${randomUUID()}`],
      ["GET", "/tournaments/matches/current"],
      ["POST", `/tournaments/${randomUUID()}/register`],
      ["POST", `/tournaments/matches/${randomUUID()}/commands`],
      ["GET", "/admin/api/tournaments"],
      ["POST", "/admin/api/tournaments"],
    ]) assert.equal((await app.inject({ method, url })).statusCode, 401, `${method} ${url}`);
  } finally { await app.close(); }
});

test("authenticated tournament routes reject malformed IDs and commands", async () => {
  const app = buildApp();
  await app.ready();
  const original = db.query;
  const account = randomUUID();
  db.query = async () => ({ rows: [{ id: account, email: "player@example.test" }] });
  const headers = { authorization: `Bearer ${app.jwt.sign({ sub: account })}` };
  try {
    for (const [method, url, payload] of [
      ["GET", "/tournaments/not-a-uuid"],
      ["POST", `/tournaments/${randomUUID()}/register`, { requestId: "wrong" }],
      ["POST", `/tournaments/${randomUUID()}/register`, { requestId: randomUUID(), stake: 0 }],
      ["POST", `/tournaments/matches/${randomUUID()}/commands`, { action: "resign", commandId: randomUUID(), expectedVersion: 1, score: 500 }],
      ["POST", `/tournaments/matches/${randomUUID()}/commands`, { action: "place", commandId: randomUUID(), expectedVersion: 1, placements: [{ tileId: "x", x: 12, y: 0, rotation: 0 }] }],
    ]) assert.equal((await app.inject({ method, url, payload, headers })).statusCode, 400, `${method} ${url}`);
    assert.equal((await app.inject({ method: "POST", url: `/tournaments/${randomUUID()}/withdraw`,
      headers, payload: { refund: 999 } })).statusCode, 400);
  } finally { db.query = original; await app.close(); }
});

test("admin tournament lifecycle requires an allowlisted account", async () => {
  const app = buildApp();
  await app.ready();
  const originalQuery = db.query;
  const originalAdmins = process.env.ADMIN_EMAILS;
  const account = randomUUID();
  db.query = async () => ({ rows: [{ id: account, email: "player@example.test" }] });
  const headers = { authorization: `Bearer ${app.jwt.sign({ sub: account })}` };
  try {
    process.env.ADMIN_EMAILS = "admin@example.test";
    assert.equal((await app.inject({ url: "/admin/api/tournaments", headers })).statusCode, 403);
    process.env.ADMIN_EMAILS = "player@example.test";
    assert.equal((await app.inject({ method: "POST", url: "/admin/api/tournaments",
      headers, payload: { name: "Incomplete" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: `/admin/api/tournaments/${randomUUID()}/publish`,
      headers, payload: { startsAt: "changed" } })).statusCode, 400);
  } finally {
    db.query = originalQuery;
    if (originalAdmins === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = originalAdmins;
    await app.close();
  }
});
