import sharp from "sharp";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readSmallFile } from "./file-inspection.js";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_PIXELS = 100_000_000;
export interface Crop { x: number; y: number; width: number; height: number }
export interface ImageInput { path: string; absolutePath: string; crop?: Crop; label?: string }

function imageMime(data: Buffer): string {
  if (data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a$/.test(data.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8,12).toString("ascii") === "WEBP") return "image/webp";
  throw new Error("Unsupported image; use PNG, JPEG, GIF or WebP. SVG is not accepted.");
}

async function prepare(input: ImageInput, maxDimension?: number) {
  const bytes = await readSmallFile(input.absolutePath, input.crop || maxDimension ? 32 * 1024 * 1024 : MAX_IMAGE_BYTES);
  const mime = imageMime(bytes);
  const metadata = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  const width = metadata.width;
  const height = metadata.pageHeight ?? metadata.height;
  if (!width || !height) throw new Error("Image dimensions are unavailable.");
  const crop = input.crop ?? { x: 0, y: 0, width, height };
  if (crop.x + crop.width > width || crop.y + crop.height > height) throw new Error("Crop is outside the original image.");
  let output = bytes;
  let outputMime = mime;
  let renderedWidth = width, renderedHeight = height;
  if (input.crop || maxDimension) {
    let pipeline = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, pages: 1 })
      .extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height });
    if (maxDimension) pipeline = pipeline.resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true });
    const transformed = await pipeline.png().toBuffer({ resolveWithObject: true });
    output = transformed.data; outputMime = "image/png";
    renderedWidth = transformed.info.width; renderedHeight = transformed.info.height;
  }
  return {
    data: output, mimeType: outputMime,
    metadata: {
      path: input.path, label: input.label ?? input.path,
      original_width: width, original_height: height, crop,
      width: renderedWidth, height: renderedHeight,
      source_pixels_per_output_pixel: { x: crop.width / renderedWidth, y: crop.height / renderedHeight },
      exif_orientation: metadata.orientation ?? 1,
      coordinate_note: "Crop coordinates use the stored raster, before EXIF orientation; no implicit rotation.",
      ...(metadata.pages && metadata.pages > 1 ? { source_frames: metadata.pages, transformed_frame: input.crop || maxDimension ? 0 : null } : {}),
    },
  };
}

/** Bounded native MCP image blocks; never a textual data URL. */
export async function viewImages(inputs: ImageInput[], maxDimension?: number, difference = false): Promise<CallToolResult> {
  const prepared: Awaited<ReturnType<typeof prepare>>[] = [];
  let total = 0;
  for (const input of inputs) {
    const image = await prepare(input, maxDimension);
    total += image.data.length;
    if (total > MAX_IMAGE_BYTES) throw new Error("Combined images exceed 8 MiB; use a smaller max_dimension or crop.");
    prepared.push(image);
  }
  const content: CallToolResult["content"] = [];
  for (const image of prepared) {
    content.push({ type: "image", data: image.data.toString("base64"), mimeType: image.mimeType });
    content.push({ type: "text", text: JSON.stringify(image.metadata) });
  }
  let comparison: Record<string, unknown> | undefined;
  if (difference) {
    if (prepared.length !== 2) throw new Error("A difference view needs exactly two images.");
    const [left, right] = prepared as [typeof prepared[number], typeof prepared[number]];
    for (const key of ["original_width", "original_height", "width", "height"] as const) {
      if (left.metadata[key] !== right.metadata[key]) throw new Error("Difference inputs must have equal dimensions and the same crop.");
    }
    if ((["x", "y", "width", "height"] as const).some((key) => left.metadata.crop[key] !== right.metadata.crop[key])) {
      throw new Error("Difference inputs must use the same crop.");
    }
    const a = await sharp(left.data).ensureAlpha().raw().toBuffer();
    const b = await sharp(right.data).ensureAlpha().raw().toBuffer();
    const pixels = Buffer.alloc(a.length);
    let changed = 0;
    for (let i = 0; i < a.length; i += 4) {
      let differs = false;
      for (let channel = 0; channel < 4; channel++) {
        if (a[i + channel] !== b[i + channel]) differs = true;
        if (channel < 3) pixels[i + channel] = Math.abs(a[i + channel]! - b[i + channel]!);
      }
      // Alpha-only changes must remain visible in the diagnostic image.
      if (a[i + 3] !== b[i + 3]) pixels[i] = pixels[i + 1] = pixels[i + 2] = 255;
      pixels[i + 3] = 255;
      if (differs) changed++;
    }
    const diff = await sharp(pixels, { raw: { width: left.metadata.width, height: left.metadata.height, channels: 4 } }).png().toBuffer();
    if (total + diff.length > MAX_IMAGE_BYTES) throw new Error("Difference view exceeds 8 MiB; reduce max_dimension.");
    comparison = { changed_pixels: changed, compared_pixels: left.metadata.width * left.metadata.height,
      resolution: "rendered", note: "Absolute pixel difference at the displayed crop/scale, not a semantic change detector." };
    content.push({ type: "text", text: JSON.stringify({ difference: comparison }) });
    content.push({ type: "image", data: diff.toString("base64"), mimeType: "image/png" });
  }
  return { content, structuredContent: { images: prepared.map((image) => image.metadata), ...(comparison ? { difference: comparison } : {}) } };
}
