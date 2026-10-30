import { createHash } from "node:crypto";
import sharp from "sharp";
import { db } from "../db.js";
import { lockTournament, tournamentArtwork, TournamentError, transaction } from "./tournament-core.js";

export type ArtworkKind = "badge" | "background";
export const MAX_ARTWORK_BYTES = 2 * 1024 * 1024;
export const MAX_ARTWORK_BASE64_LENGTH = 4 * Math.ceil(MAX_ARTWORK_BYTES / 3);
const MAX_DIMENSION = 2048;

/** Preserve the whole illustration and alpha; remove embedded source metadata. */
export async function normalizeTournamentArtwork(data: string, contentType: "image/png" | "image/jpeg",
  kind: ArtworkKind) {
  if (data.length > MAX_ARTWORK_BASE64_LENGTH) throw new TournamentError("ARTWORK_TOO_LARGE", 413);
  const source = Buffer.from(data, "base64");
  if (!source.length || source.toString("base64") !== data) throw new TournamentError("INVALID_ARTWORK", 400);
  if (source.length > MAX_ARTWORK_BYTES) throw new TournamentError("ARTWORK_TOO_LARGE", 413);
  try {
    const metadata = await sharp(source, { limitInputPixels: false }).metadata();
    if (metadata.format !== (contentType === "image/png" ? "png" : "jpeg") ||
        (metadata.pages ?? 1) !== 1) throw new TournamentError("INVALID_ARTWORK", 400);
    if (!metadata.width || !metadata.height || metadata.width < 32 || metadata.height < 32 ||
        metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION)
      throw new TournamentError("INVALID_ARTWORK_DIMENSIONS", 400);
    const size = kind === "badge" ? 512 : 1536;
    const { data: png, info } = await sharp(source, { limitInputPixels: MAX_DIMENSION ** 2, failOn: "warning" })
      .rotate().resize(size, size, { fit: "inside", withoutEnlargement: true })
      .png().toBuffer({ resolveWithObject: true });
    if (png.length > 8 * 1024 * 1024) throw new TournamentError("ARTWORK_TOO_LARGE", 413);
    return { png, metadata: { contentType: "image/png" as const, width: info.width, height: info.height,
      version: createHash("sha256").update(png).digest("hex") } };
  } catch (error) {
    if (error instanceof TournamentError) throw error;
    throw new TournamentError("INVALID_ARTWORK", 400);
  }
}

export async function saveTournamentArtwork(actorId: string, id: string, kind: ArtworkKind,
  image: Awaited<ReturnType<typeof normalizeTournamentArtwork>> | null) {
  return transaction(async client => {
    const tour = await lockTournament(client, id);
    if (tour.status !== "draft") throw new TournamentError("PUBLISHED_RULES_LOCKED");
    if (image) {
      await client.query(`INSERT INTO tournament_artwork (tournament_id,kind,png) VALUES ($1,$2,$3)
        ON CONFLICT (tournament_id,kind) DO UPDATE SET png=EXCLUDED.png`, [id, kind, image.png]);
      await client.query(`UPDATE tournaments SET artwork=jsonb_set(artwork,ARRAY[$2]::text[],$3::jsonb)
        WHERE id=$1`, [id, kind, JSON.stringify(image.metadata)]);
    } else {
      await client.query("DELETE FROM tournament_artwork WHERE tournament_id=$1 AND kind=$2", [id, kind]);
      await client.query("UPDATE tournaments SET artwork=artwork-$2::text WHERE id=$1", [id, kind]);
    }
    await client.query(`INSERT INTO tournament_admin_audit (tournament_id,staff_actor_id,action,details)
      VALUES ($1,$2,$3,$4)`, [id, actorId, image ? "upload_artwork" : "remove_artwork",
      JSON.stringify({ kind, before: tour.artwork?.[kind] ?? null, after: image?.metadata ?? null })]);
    return { artwork: tournamentArtwork({ ...tour,
      artwork: { ...tour.artwork, [kind]: image?.metadata ?? undefined } }, true) };
  });
}

export async function findTournamentArtwork(id: string, kind: ArtworkKind, admin: boolean, version?: string) {
  const row = (await db.query<{ png: Buffer; version: string }>(`SELECT a.png,
    t.artwork->a.kind->>'version' AS version FROM tournament_artwork a
    JOIN tournaments t ON t.id=a.tournament_id
    WHERE t.id=$1 AND a.kind=$2 AND ($3::boolean OR t.status<>'draft')`, [id, kind, admin])).rows[0];
  if (!row || version && row.version !== version) throw new TournamentError("ARTWORK_NOT_FOUND", 404);
  return row.png;
}
