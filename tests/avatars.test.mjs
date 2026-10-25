import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";

process.env.JWT_SECRET = "test-secret-with-at-least-thirty-two-bytes";
const { buildApp } = await import("../dist/app.js");
const { db } = await import("../dist/db.js");
const { normalizeAvatar, MAX_AVATAR_BYTES } = await import("../dist/services/avatar-service.js");
const playerId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const image = (width = 300, height = 250) => sharp({
  create: { width, height, channels: 4, background: { r: 20, g: 80, b: 150, alpha: 0.5 } }
});
const png = await image().png().toBuffer();
const payload = { contentType: "image/png", data: png.toString("base64") };

test("normalization accepts PNG/JPEG, strips metadata, and crops to 195 pixels", async () => {
  for (const format of ["png", "jpeg"]) {
    const source = await image(600, 300).withMetadata().toFormat(format).toBuffer();
    const result = await normalizeAvatar(source.toString("base64"), `image/${format}`);
    const metadata = await sharp(result).metadata();
    assert.equal(metadata.format, "png");
    assert.equal(metadata.width, 195);
    assert.equal(metadata.height, 195);
    assert.equal(metadata.exif, undefined);
    assert.equal(metadata.icc, undefined);
  }
  // A centre crop excludes both the red and blue outer thirds.
  const striped = await sharp({ create: { width: 600, height: 200, channels: 3, background: "green" } })
    .composite([
      { input: await sharp({ create: { width: 200, height: 200, channels: 3, background: "red" } }).png().toBuffer(), left: 0, top: 0 },
      { input: await sharp({ create: { width: 200, height: 200, channels: 3, background: "blue" } }).png().toBuffer(), left: 400, top: 0 }
    ]).png().toBuffer();
  const result = await normalizeAvatar(striped.toString("base64"), "image/png");
  const stats = await sharp(result).stats();
  assert.equal(stats.channels[0].max, 0);
  assert.equal(stats.channels[2].max, 0);
  assert.ok(stats.channels[1].min > 0);
});

test("avatar routes enforce identity, validate uploads, isolate accounts, and support replacement/removal", async () => {
  const app = buildApp();
  await app.ready();
  const originalQuery = db.query;
  const avatars = new Map();
  const deletedUsers = new Set();
  let writes = 0;
  let failSave = false;
  let deleteDuringSave = false;
  let paired = false;
  db.query = async (sql, params) => {
    if (sql.includes("INSERT INTO user_avatars")) {
      if (failSave) throw new Error("Simulated storage failure");
      if (deleteDuringSave) return { rows: [] };
      writes++;
      const avatar = { png: params[1], updated_at: new Date("2026-10-14T12:00:00Z") };
      avatars.set(params[0], avatar);
      return { rows: [avatar] };
    }
    if (sql.includes("FROM users WHERE id")) {
      return { rows: deletedUsers.has(params[0]) ? [] : [{ id: params[0] }] };
    }
    if (sql.includes("FROM matchmaking_tickets mine")) {
      return { rows: paired && params[0] === playerId && params[1] === otherId ? [{ "?column?": 1 }] : [] };
    }
    if (sql.startsWith("SELECT png")) return { rows: avatars.has(params[0]) ? [avatars.get(params[0])] : [] };
    if (sql.startsWith("DELETE FROM user_avatars")) { avatars.delete(params[0]); return { rows: [] }; }
    throw new Error(`Unexpected query: ${sql}`);
  };
  const headers = { authorization: `Bearer ${app.jwt.sign({ sub: playerId })}` };
  const otherHeaders = { authorization: `Bearer ${app.jwt.sign({ sub: otherId })}` };
  const upload = (body, extra = {}) => app.inject({ method: "PUT", url: "/auth/me/avatar", headers, payload: body, ...extra });
  const get = (auth = headers) => app.inject({ method: "GET", url: "/auth/me/avatar", headers: auth });
  try {
    for (const method of ["GET", "PUT", "DELETE"]) {
      for (const authorization of [undefined, "Bearer invalid", `Bearer ${app.jwt.sign({ sub: "not-a-uuid" })}`, `Bearer ${app.jwt.sign({ sub: playerId }, { expiresIn: -1 })}`]) {
        const response = await app.inject({ method, url: "/auth/me/avatar", headers: authorization ? { authorization } : {}, ...(method === "PUT" ? { payload } : {}) });
        assert.equal(response.statusCode, 401);
      }
    }
    assert.equal((await get()).statusCode, 404);
    const saved = await upload(payload);
    assert.equal(saved.statusCode, 200);
    assert.deepEqual(saved.json().avatar, {
      url: "/auth/me/avatar", contentType: "image/png", width: 195, height: 195, updatedAt: "2026-10-14T12:00:00.000Z"
    });
    const downloaded = await get();
    assert.equal(downloaded.statusCode, 200);
    assert.equal(downloaded.headers["content-type"], "image/png");
    assert.equal(downloaded.headers["cache-control"], "private, no-store");
    assert.equal(downloaded.headers["x-content-type-options"], "nosniff");
    assert.deepEqual(downloaded.rawPayload, avatars.get(playerId).png);
    assert.equal((await get(otherHeaders)).statusCode, 404);
    avatars.set(otherId, { png, updated_at: new Date("2026-10-14T12:00:00Z") });
    const opponentUrl = `/auth/opponents/${otherId}/avatar`;
    assert.equal((await app.inject({ method: "GET", url: opponentUrl })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: "/auth/opponents/not-a-uuid/avatar", headers })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: opponentUrl, headers })).statusCode, 404,
      "an unrelated account cannot read the avatar");
    paired = true;
    const opponentAvatar = await app.inject({ method: "GET", url: opponentUrl, headers });
    assert.equal(opponentAvatar.statusCode, 200);
    assert.deepEqual(opponentAvatar.rawPayload, png);
    assert.equal(opponentAvatar.headers["cache-control"], "private, no-store");
    avatars.delete(otherId);
    assert.equal((await app.inject({ method: "GET", url: opponentUrl, headers })).statusCode, 404,
      "a matched player without an avatar uses the client fallback");
    paired = false;
    const jpeg = await image(400, 500).jpeg().toBuffer();
    assert.equal((await upload({ contentType: "image/jpeg", data: jpeg.toString("base64") })).statusCode, 200);
    assert.equal(avatars.size, 1, "replacement does not accumulate images");
    const previous = avatars.get(playerId).png;
    const before = writes;
    const cases = [
      [{}, 400],
      [{ ...payload, userId: otherId }, 400],
      [{ ...payload, contentType: "image/svg+xml" }, 400],
      [{ ...payload, data: 123 }, 400],
      [{ ...payload, data: "" }, 400],
      [{ ...payload, data: "not base64!" }, 400],
      [{ ...payload, data: `data:image/png;base64,${payload.data}` }, 400],
      [{ ...payload, data: payload.data + "\n" }, 400],
      [{ ...payload, data: Buffer.from("not an image").toString("base64") }, 400],
      [{ ...payload, contentType: "image/jpeg" }, 400],
      [{ ...payload, data: png.subarray(0, 40).toString("base64") }, 400],
      [{ ...payload, data: Buffer.alloc(MAX_AVATAR_BYTES + 1).toString("base64") }, 413],
      [{ ...payload, data: "a".repeat(3 * 1024 * 1024) }, 413]
    ];
    for (const [width, height] of [[194, 300], [300, 194], [2049, 195], [195, 2049]]) {
      cases.push([{ ...payload, data: (await image(width, height).png().toBuffer()).toString("base64") }, 400]);
    }
    for (const [body, status] of cases) {
      assert.equal((await upload(body)).statusCode, status);
    }
    assert.equal(writes, before, "invalid uploads never reach persistence");
    assert.deepEqual(avatars.get(playerId).png, previous, "failed uploads preserve the current avatar");
    failSave = true;
    assert.equal((await upload(payload)).statusCode, 500);
    assert.deepEqual(avatars.get(playerId).png, previous);
    failSave = false;
    deleteDuringSave = true;
    assert.equal((await upload(payload)).statusCode, 401);
    deleteDuringSave = false;
    assert.equal((await app.inject({ method: "DELETE", url: "/auth/me/avatar", headers: otherHeaders })).statusCode, 204);
    assert.equal((await get()).statusCode, 200, "another account cannot delete my avatar");
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal((await app.inject({ method: "DELETE", url: "/auth/me/avatar", headers })).statusCode, 204);
    }
    assert.equal((await get()).statusCode, 404);
    deletedUsers.add(playerId);
    assert.equal((await upload(payload)).statusCode, 401);
    assert.equal((await get()).statusCode, 401);
    assert.equal((await app.inject({ method: "DELETE", url: "/auth/me/avatar", headers })).statusCode, 401);
  } finally {
    db.query = originalQuery;
    await app.close();
  }
});
