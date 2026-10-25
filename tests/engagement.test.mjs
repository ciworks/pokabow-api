import { test } from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = "test-secret-with-at-least-thirty-two-bytes";
const { buildApp } = await import("../dist/app.js");
const { db } = await import("../dist/db.js");
const { calculateActiveDayProgress } = await import("../dist/services/engagement-service.js");
const playerId = "11111111-1111-4111-8111-111111111111";

test("UTC streak counts distinct consecutive days and expires after a missed day", () => {
  assert.deepEqual(calculateActiveDayProgress([], "2026-10-20"), { totalDays: 0, consecutiveDays: 0 });
  assert.deepEqual(calculateActiveDayProgress([
    "2026-10-18", "2026-10-19", "2026-10-19", "2026-10-17"
  ], "2026-10-20"), { totalDays: 3, consecutiveDays: 3 });
  assert.deepEqual(calculateActiveDayProgress([
    "2026-10-17", "2026-10-18"
  ], "2026-10-20"), { totalDays: 2, consecutiveDays: 0 });
  assert.deepEqual(calculateActiveDayProgress([
    "2026-10-19", "2026-10-20", "2026-10-01"
  ], "2026-10-20"), { totalDays: 3, consecutiveDays: 2 });
  assert.deepEqual(calculateActiveDayProgress([
    "2025-12-31", "2026-01-01"
  ], "2026-01-01"), { totalDays: 2, consecutiveDays: 2 });
});

test("authenticated check-ins unlock first visit, seven-day streak, and 100 active days once", async () => {
  const app = buildApp();
  await app.ready();
  const originalQuery = db.query;
  const originalConnect = db.connect;
  const activeDays = new Set();
  const unlocked = new Set();
  let today = "2026-10-20";
  const definitions = [
    { id: "first_login", name: "First Login", description: "First visit", metric: "active_days", target: 1 },
    { id: "streak_starter", name: "Streak Starter", description: "Seven days", metric: "login_streak", target: 7 },
    { id: "loyal_user", name: "Loyal User", description: "100 days", metric: "active_days", target: 100 }
  ];
  db.query = async sql => {
    if (sql.includes("FROM users WHERE id")) return { rows: [{ id: playerId }] };
    throw new Error(`Unexpected query: ${sql}`);
  };
  db.connect = async () => ({
    query: async (sql, params = []) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (sql.includes("FROM users WHERE id") && sql.includes("FOR UPDATE")) return { rows: [{ id: playerId }] };
      if (sql.includes("AS day") && sql.includes("NOW()")) return { rows: [{ day: today }] };
      if (sql.includes("INSERT INTO account_active_days")) {
        activeDays.add(params[1]);
        return { rows: [] };
      }
      if (sql.includes("FROM account_active_days")) {
        return { rows: [...activeDays].sort().reverse().map(day => ({ day })) };
      }
      if (sql.includes("INSERT INTO user_achievements")) {
        const rows = definitions.filter(item => {
          const progress = item.metric === "active_days" ? params[1] : params[2];
          if (progress < item.target || unlocked.has(item.id)) return false;
          unlocked.add(item.id);
          return true;
        }).map(item => ({ achievement_id: item.id }));
        return { rows };
      }
      if (sql.includes("FROM achievements WHERE id = ANY")) {
        return { rows: definitions.filter(item => params[0].includes(item.id)) };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {}
  });
  const headers = { authorization: `Bearer ${app.jwt.sign({ sub: playerId })}` };
  const checkIn = async () => app.inject({ method: "POST", url: "/achievements/check-in", headers });
  try {
    assert.equal((await app.inject({ method: "POST", url: "/achievements/check-in" })).statusCode, 401);
    const first = await checkIn();
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json().unlocked, ["first_login"]);
    assert.equal(first.json().unlockedDetails[0].description, "First visit");
    assert.equal(first.json().totalDays, 1);
    assert.deepEqual((await checkIn()).json().unlocked, []);
    assert.equal(activeDays.size, 1);

    for (let offset = 1; offset <= 5; offset += 1) {
      activeDays.add(new Date(Date.UTC(2026, 9, 20 - offset)).toISOString().slice(0, 10));
    }
    today = "2026-10-21";
    const seventh = (await checkIn()).json();
    assert.equal(seventh.consecutiveDays, 7);
    assert.deepEqual(seventh.unlocked, ["streak_starter"]);

    for (let offset = 7; offset < 100; offset += 1) {
      activeDays.add(new Date(Date.UTC(2026, 9, 21 - offset)).toISOString().slice(0, 10));
    }
    assert.equal(activeDays.size, 100);
    const hundredth = (await checkIn()).json();
    assert.equal(hundredth.totalDays, 100);
    assert.deepEqual(hundredth.unlocked, ["loyal_user"]);
    assert.deepEqual((await checkIn()).json().unlocked, []);
  } finally {
    db.query = originalQuery;
    db.connect = originalConnect;
    await app.close();
  }
});
