import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";

process.env.JWT_SECRET = "tournament-artwork-tests-at-least-thirty-two-bytes";
const { buildApp } = await import("../dist/app.js");
const { db } = await import("../dist/db.js");
const { publicTournament } = await import("../dist/services/tournament-core.js");
const { normalizeTournamentArtwork, MAX_ARTWORK_BYTES } = await import("../dist/services/tournament-artwork.js");
const image = (width, height) => sharp({ create: { width, height, channels: 4,
  background: { r: 30, g: 150, b: 150, alpha: 0.5 } } });
const png = await image(640, 320).png().toBuffer();
const payload = { contentType: "image/png", data: png.toString("base64") };

test("tournament art preserves aspect ratio/alpha, bounds size and removes source metadata", async () => {
  for (const [kind, size] of [["badge", 512], ["background", 1536]]) {
    for (const format of ["png", "jpeg"]) {
      const source = await image(2048, 1024).withMetadata().toFormat(format).toBuffer();
      const result = await normalizeTournamentArtwork(source.toString("base64"), `image/${format}`, kind);
      const metadata = await sharp(result.png).metadata();
      assert.equal(metadata.width, size);
      assert.equal(metadata.height, size / 2);
      assert.equal(metadata.format, "png");
      assert.equal(metadata.exif, undefined);
      assert.equal(metadata.icc, undefined);
      assert.equal(result.metadata.version, createHash("sha256").update(result.png).digest("hex"));
      if (format === "png") {
        assert.equal(metadata.hasAlpha, true);
        const { data, info } = await sharp(result.png).raw().toBuffer({ resolveWithObject: true });
        assert.ok(data[info.channels - 1] > 100 && data[info.channels - 1] < 150);
      }
    }
  }
  const small = await normalizeTournamentArtwork((await image(64, 32).png().toBuffer()).toString("base64"), "image/png", "badge");
  assert.equal(small.metadata.width, 64, "small art is not enlarged");
});

test("tournament art rejects malformed, oversized, mismatched and unsupported image uploads", async () => {
  for (const [data, type, code] of [
    ["not base64", "image/png", "INVALID_ARTWORK"],
    [Buffer.from("not an image").toString("base64"), "image/png", "INVALID_ARTWORK"],
    [payload.data, "image/jpeg", "INVALID_ARTWORK"],
    [Buffer.alloc(MAX_ARTWORK_BYTES + 1).toString("base64"), "image/png", "ARTWORK_TOO_LARGE"],
    [(await image(2049, 32).png().toBuffer()).toString("base64"), "image/png", "INVALID_ARTWORK_DIMENSIONS"],
    [(await image(31, 32).png().toBuffer()).toString("base64"), "image/png", "INVALID_ARTWORK_DIMENSIONS"],
    [(await image(64, 64).webp().toBuffer()).toString("base64"), "image/png", "INVALID_ARTWORK"],
  ]) await assert.rejects(normalizeTournamentArtwork(data, type, "badge"), error => error.code === code);
});

test("legacy tournaments explicitly resolve to the trophy/confetti default", () => {
  assert.deepEqual(publicTournament({}, 0).artwork,
    { fallback: "trophy-confetti", badge: null, background: null });
});

test("artwork API enforces staff/CSRF/draft boundaries and supports upload, replace, read and removal", async () => {
  const app = buildApp();
  await app.ready();
  const originalQuery = db.query, originalConnect = db.connect;
  const id = randomUUID(), actor = randomUUID();
  const tour = { id, name: "Big Cheese", status: "draft", artwork: {}, rules_version: 1,
    registration_opens_at: new Date(), starts_at: new Date(), entry_stake: "50",
    champion_prize: "500", min_gem_balance: "0" };
  const assets = new Map(), audit = [];
  let role = "operator", writes = 0;
  const query = async (sql, args = []) => {
    if (sql.includes("FROM staff_sessions")) return { rows: [{ id: actor, role, email: "staff@example.test" }] };
    if (sql.includes("FROM users")) return { rows: [{ id: actor }] };
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
    if (sql.includes("SELECT * FROM tournaments") && sql.includes("FOR UPDATE"))
      return { rows: args[0] === id ? [structuredClone(tour)] : [] };
    if (sql.includes("INSERT INTO tournament_artwork")) {
      assets.set(args[1], args[2]); writes++; return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE tournaments SET artwork=jsonb_set")) {
      tour.artwork[args[1]] = JSON.parse(args[2]); return { rows: [] };
    }
    if (sql.includes("DELETE FROM tournament_artwork")) {
      assets.delete(args[1]); writes++; return { rows: [] };
    }
    if (sql.includes("UPDATE tournaments SET artwork=artwork-")) {
      delete tour.artwork[args[1]]; return { rows: [] };
    }
    if (sql.includes("INSERT INTO tournament_admin_audit")) {
      audit.push({ action: args[2], details: JSON.parse(args[3]) }); return { rows: [] };
    }
    if (sql.includes("SELECT a.png")) {
      const art = assets.get(args[1]);
      return { rows: args[0] === id && art && (args[2] || tour.status !== "draft")
        ? [{ png: art, version: tour.artwork[args[1]].version }] : [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  db.query = query;
  db.connect = async () => ({ query, release() {} });
  const staff = { cookie: "pokabow_staff=art-test",
    "x-csrf-token": createHash("sha256").update("csrf:art-test").digest("hex") };
  const player = { authorization: `Bearer ${app.jwt.sign({ sub: actor })}` };
  const adminPath = `/admin/api/tournaments/${id}/artwork/badge`;
  const playerPath = `/tournaments/${id}/artwork/badge`;
  const inject = (method, url = adminPath, body = undefined, headers = staff) =>
    app.inject({ method, url, headers, payload: body });
  try {
    for (const method of ["GET", "PUT", "DELETE"])
      assert.equal((await inject(method, adminPath, method === "PUT" ? payload : undefined, {})).statusCode, 401);
    assert.equal((await inject("GET", playerPath, undefined, {})).statusCode, 401);
    assert.equal((await inject("PUT", adminPath, payload, { cookie: staff.cookie })).statusCode, 403);
    role = "viewer";
    assert.equal((await inject("PUT", adminPath, payload)).statusCode, 403);
    assert.equal((await inject("DELETE")).statusCode, 403);
    role = "operator";
    for (const [url, body] of [
      [adminPath.replace(id, "invalid"), payload],
      [adminPath.replace("badge", "other"), payload],
      [adminPath, { ...payload, contentType: "image/svg+xml" }],
      [adminPath, { ...payload, url: "https://example.test/image.png" }],
      [adminPath, { contentType: "image/png", data: "invalid" }],
    ]) assert.equal((await inject("PUT", url, body)).statusCode, 400);
    assert.equal(writes, 0, "invalid or forbidden requests never write");
    assert.equal((await inject("PUT", adminPath, { ...payload,
      data: "a".repeat(4 * Math.ceil(MAX_ARTWORK_BYTES / 3) + 2000) })).statusCode, 413);
    assert.equal((await inject("PUT", adminPath.replace(id, randomUUID()), payload)).statusCode, 404);

    const uploaded = await inject("PUT", adminPath, payload);
    assert.equal(uploaded.statusCode, 200, uploaded.body);
    const first = uploaded.json().artwork;
    assert.equal(first.fallback, "trophy-confetti");
    assert.equal(first.background, null);
    assert.equal(first.badge.width, 512);
    assert.ok(first.badge.url.startsWith("/admin/api/tournaments/"));
    const preview = await inject("GET", first.badge.url);
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.headers["content-type"], "image/png");
    assert.equal(preview.headers["x-content-type-options"], "nosniff");
    assert.equal(preview.headers["cache-control"], "no-store");
    assert.deepEqual(preview.rawPayload, assets.get("badge"));
    assert.equal((await inject("GET", playerPath, undefined, player)).statusCode, 404, "draft images stay private");
    assert.equal((await inject("GET", adminPath + "?v=invalid")).statusCode, 400);

    const replacement = await image(64, 64).png().toBuffer();
    const replaced = await inject("PUT", adminPath, { ...payload, data: replacement.toString("base64") });
    assert.notEqual(replaced.json().artwork.badge.version, first.badge.version);
    assert.equal((await inject("GET", first.badge.url)).statusCode, 404, "old version never serves different bytes");
    assert.equal((await inject("PUT", adminPath.replace("badge", "background"), payload)).json().artwork.background.width, 640);
    const removed = await inject("DELETE");
    assert.equal(removed.json().artwork.badge, null);
    assert.ok(removed.json().artwork.background, "removing one asset preserves its sibling");
    assert.equal((await inject("GET")).statusCode, 404);
    await inject("PUT", adminPath, payload);

    tour.status = "open";
    const meta = publicTournament(tour, 0).artwork;
    assert.ok(meta.badge.url.startsWith("/tournaments/"));
    assert.equal((await inject("GET", meta.badge.url, undefined, player)).statusCode, 200);
    for (const method of ["PUT", "DELETE"]) {
      const locked = await inject(method, adminPath, method === "PUT" ? payload : undefined);
      assert.equal(locked.statusCode, 409);
      assert.equal(locked.json().error, "PUBLISHED_RULES_LOCKED");
    }
    assert.equal(tour.rules_version, 1, "presentation uploads never alter gameplay rules");
    assert.ok(audit.some(row => row.action === "upload_artwork" && row.details.after.version));
    assert.ok(audit.some(row => row.action === "remove_artwork" && row.details.after === null));
    assert.equal((await inject("GET", playerPath, undefined, staff)).statusCode, 401);
  } finally { db.query = originalQuery; db.connect = originalConnect; await app.close(); }
});
