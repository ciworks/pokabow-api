# Account avatars

Apply `migrations/009_user_avatars.sql` after the existing migrations, install
dependencies with `npm install`, then rebuild/restart the API. Avatars live in
PostgreSQL (`user_avatars.png`), so database backups include them and account
deletion removes them through a foreign-key cascade. No upload directory or
external storage credentials are required.

All three endpoints use `Authorization: Bearer <token>` and operate only on the
signed-in user's avatar. The download URL is relative to the API base URL and
also requires authentication. It is not a public image URL.

| Method | Path | Result |
| --- | --- | --- |
| PUT | `/auth/me/avatar` | Upload or replace; 200 with avatar metadata |
| GET | `/auth/me/avatar` | 200 with PNG bytes; 404 if no uploaded avatar |
| GET | `/auth/opponents/{userId}/avatar` | 200 with PNG bytes only while the signed-in player is paired with that opponent; otherwise 404 |
| DELETE | `/auth/me/avatar` | 204, including when already absent |

## Upload

Send `Content-Type: application/json` and this body:

```json
{
  "contentType": "image/png",
  "data": "<standard padded base64 image bytes>"
}
```

`contentType` accepts `image/png` or `image/jpeg`. `data` must contain plain
base64 without whitespace or a data-URL prefix. Additional fields (including
user IDs) are rejected. The decoded image may be at most 2 MiB, with each side
between 195 and 2048 pixels inclusive. The API fully decodes the image, checks
the claimed format, centre-crops to a square, resizes to 195 x 195, and encodes
a PNG without source metadata. Upload validation completes before replacement,
so rejected images leave the previous avatar intact.

```json
{
  "avatar": {
    "url": "/auth/me/avatar",
    "contentType": "image/png",
    "width": 195,
    "height": 195,
    "updatedAt": "2026-10-14T12:00:00.000Z"
  }
}
```

Downloads send `Cache-Control: private, no-store` and
`X-Content-Type-Options: nosniff`. Selecting a built-in avatar can remain a
client concern; delete the server avatar when reverting to a device-local
default, or upload that default's PNG to persist the same picture across devices.

## Errors

| HTTP | `error` | Meaning |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | Missing fields, unsupported contentType, or extra fields |
| 400 | `INVALID_AVATAR` | Invalid base64, corrupt image, or mismatched format |
| 400 | `INVALID_AVATAR_DIMENSIONS` | Either side outside the supported range |
| 401 | `UNAUTHORIZED` | Missing/invalid/expired token or deleted account |
| 404 | `AVATAR_NOT_FOUND` | No avatar stored; show the client default |
| 413 | `AVATAR_TOO_LARGE` | Decoded image exceeds 2 MiB |

Requests exceeding the encoded body limit (2,797,228 bytes) receive Fastify's
413 error response with `code: FST_ERR_CTP_BODY_TOO_LARGE`. Malformed JSON and
unsupported HTTP Content-Type use Fastify's normal 400/415 responses. Clients
should handle HTTP status first. Storage failures return 500; do not mark an
upload saved until receiving 200.

## Godot integration contract

The existing Pokabow profile screen still saves locally. To connect it, keep
`PlayerAvatarStore.prepare_upload()` for the preview and send the prepared PNG:

```gdscript
var body := JSON.stringify({
    "contentType": "image/png",
    "data": Marshalls.raw_to_base64(prepared_image.save_png_to_buffer())
})
http_request.request(api_base_url + "/auth/me/avatar", PackedStringArray([
    "Authorization: Bearer " + token,
    "Content-Type: application/json"
]), HTTPClient.METHOD_PUT, body)
```

After login, GET the same path with the bearer token and pass the response
bytes to `Image.load_png_from_buffer()`. Treat 404 as no cloud avatar, and keep
the existing preview/local cache when a request fails. Clear any cached account
image on logout/account changes. The opponent endpoint permits only a current
matched lobby or active online game participant to fetch the other player's
avatar. The lobby and game responses carry the opponent ID; the PNG is fetched
once per opponent and is not included in repeated polling responses. A 404 keeps
the packaged rival portrait. The existing login/profile JSON responses are unchanged.

## Verification

`npm test` runs image processing and HTTP authorization/validation tests.
For the real PostgreSQL lifecycle check, use a local database in `DATABASE_URL`:

```powershell
npm run build
$env:AVATAR_DB_TEST = '1'
node --test tests/avatars-postgres.test.mjs
Remove-Item Env:AVATAR_DB_TEST
```

This test applies the avatar migration inside a new isolated schema and rolls
back the entire transaction, including the schema. It never migrates the
application's existing tables.
