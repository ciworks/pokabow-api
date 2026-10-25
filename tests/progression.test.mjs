import { test } from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = "progression-tests-only-at-least-thirty-two-bytes";
const { levelFromExperience, experienceForLevel, rateMatch, tierForSkill, INITIAL_SKILL } =
  await import("../dist/services/player-progression.js");
const { buildApp } = await import("../dist/app.js");

test("Table Level is monotonic and has explicit next-level thresholds", () => {
  assert.equal(levelFromExperience(0), 1);
  assert.equal(levelFromExperience(99), 1);
  assert.equal(levelFromExperience(100), 2);
  assert.equal(levelFromExperience(299), 2);
  assert.equal(levelFromExperience(300), 3);
  for (let level = 1; level <= 40; level += 1) {
    assert.equal(levelFromExperience(experienceForLevel(level)), level);
    assert.equal(levelFromExperience(experienceForLevel(level + 1) - 1), level);
  }
});

test("equal-skill online results update Glicko-2 symmetrically", () => {
  const win = rateMatch(INITIAL_SKILL, INITIAL_SKILL, 1);
  const loss = rateMatch(INITIAL_SKILL, INITIAL_SKILL, 0);
  const draw = rateMatch(INITIAL_SKILL, INITIAL_SKILL, 0.5);
  assert.ok(win.rating > 1500 && loss.rating < 1500);
  assert.ok(Math.abs((win.rating + loss.rating) - 3000) < 0.001);
  assert.ok(Math.abs(draw.rating - 1500) < 0.001);
  assert.ok(win.deviation < INITIAL_SKILL.deviation);
  assert.equal(win.ratedMatches, 1);
  assert.equal(tierForSkill(win), "Provisional");
});

test("progression endpoint requires an account", async () => {
  const app = buildApp();
  await app.ready();
  try {
    assert.equal((await app.inject({ method: "GET", url: "/progression/me" })).statusCode, 401);
  } finally {
    await app.close();
  }
});
