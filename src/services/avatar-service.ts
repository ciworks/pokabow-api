import sharp from "sharp";

export const AVATAR_SIZE = 195;
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
export const MAX_AVATAR_BASE64_LENGTH = 4 * Math.ceil(MAX_AVATAR_BYTES / 3);
const MAX_DIMENSION = 2048;

export class AvatarValidationError extends Error {
  constructor(public code: string, public statusCode = 400) {
    super(code);
  }
}

/** Decode fully, crop to match the Godot preview, and discard source metadata. */
export async function normalizeAvatar(data: string, contentType: "image/png" | "image/jpeg") {
  if (data.length > MAX_AVATAR_BASE64_LENGTH) {
    throw new AvatarValidationError("AVATAR_TOO_LARGE", 413);
  }
  const source = Buffer.from(data, "base64");
  if (!source.length || source.toString("base64") !== data) {
    throw new AvatarValidationError("INVALID_AVATAR");
  }
  if (source.length > MAX_AVATAR_BYTES) {
    throw new AvatarValidationError("AVATAR_TOO_LARGE", 413);
  }

  try {
    // Read headers before decoding pixels so either oversized side is rejected.
    const metadata = await sharp(source, { limitInputPixels: false }).metadata();
    const expectedFormat = contentType === "image/png" ? "png" : "jpeg";
    if (metadata.format !== expectedFormat || (metadata.pages ?? 1) !== 1) {
      throw new AvatarValidationError("INVALID_AVATAR");
    }
    const { width, height } = metadata;
    if (!width || !height || width < AVATAR_SIZE || height < AVATAR_SIZE ||
        width > MAX_DIMENSION || height > MAX_DIMENSION) {
      throw new AvatarValidationError("INVALID_AVATAR_DIMENSIONS");
    }
    const side = Math.min(width, height);
    return await sharp(source, { limitInputPixels: MAX_DIMENSION ** 2, failOn: "warning" })
      .extract({ left: Math.floor((width - side) / 2), top: Math.floor((height - side) / 2), width: side, height: side })
      .resize(AVATAR_SIZE, AVATAR_SIZE)
      .png()
      .toBuffer();
  } catch (error) {
    if (error instanceof AvatarValidationError) throw error;
    throw new AvatarValidationError("INVALID_AVATAR");
  }
}
