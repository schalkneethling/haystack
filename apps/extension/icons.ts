// Makes the extension's icons from the hay bale in art/haybale.png, and writes them into
// public/icons, which the build copies into each browser's build. See "## Extension" in
// plans/haystack-v1-implementation-plan.md. Run it with `vp run @haystack/extension#icons` after
// the art changes, and commit what it writes.
//
// Neither Vite+ nor Oxc processes images, so this uses sharp
// (https://sharp.pixelplumbing.com/api-resize/).
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp, { type Sharp } from "sharp";
import { ICON_SIZES, type IconSize, iconPath } from "./manifest.ts";

const SOURCE = fileURLToPath(new URL("./art/haybale.png", import.meta.url));
// Vite copies the public directory into the build as it is (https://vite.dev/guide/assets#the-public-directory).
const PUBLIC_DIR = new URL("./public/", import.meta.url);

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

interface IconSpec {
  /** The bale's width and height inside the icon. The rest is transparent padding. */
  art: number;
  /**
   * Draw the bale without its loose straws. Scaled down to 16 or 32 pixels, the straws become a
   * half-transparent fringe that makes the whole outline look blurred.
   */
  withoutStraws: boolean;
  /** Sharpen after scaling down, and turn the edge's partly transparent pixels solid or clear. */
  crisp: boolean;
}

// Chrome asks for 16, 32, 48 and 128, and Firefox for 48 and 96. At 128, Chrome's guidelines ask
// for 96 by 96 pixels of art with 16 pixels of padding on each side
// (https://developer.chrome.com/docs/webstore/images#icons). At 16 and 32 the bale reads as the
// yellow dot in the site's wordmark.
// Keyed by the manifest's sizes, so a size added there needs an entry here before this compiles.
const ICONS: Record<IconSize, IconSpec> = {
  16: { art: 16, withoutStraws: true, crisp: true },
  32: { art: 30, withoutStraws: true, crisp: true },
  48: { art: 44, withoutStraws: false, crisp: true },
  96: { art: 88, withoutStraws: false, crisp: false },
  128: { art: 96, withoutStraws: false, crisp: false },
};

export interface RawImage {
  data: Buffer;
  width: number;
  height: number;
}

async function raw(image: Sharp): Promise<RawImage> {
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function fromRaw({ data, width, height }: RawImage): Sharp {
  return sharp(data, { raw: { width, height, channels: 4 } });
}

// The art sits on a glow that is fully transparent but still carries color. Clearing that color
// keeps it from bleeding into the bale's edge when the image is scaled down.
function clearHiddenColor(image: RawImage): RawImage {
  const data = Buffer.from(image.data);
  for (let alpha = 3; alpha < data.length; alpha += 4) {
    if (data[alpha] === 0) data.fill(0, alpha - 3, alpha);
  }
  return { ...image, data };
}

// The least alpha a pixel needs to count as part of the bale when cropping. Fainter pixels are
// the last traces of antialiasing, which would only add empty margin.
const VISIBLE_ALPHA = 16;

// Crops to the bale, then pads the shorter side so the bale sits centered on a square.
async function squareCrop(image: RawImage): Promise<Sharp> {
  let [left, top, right, bottom] = [image.width, image.height, -1, -1];
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if ((image.data[(y * image.width + x) * 4 + 3] ?? 0) < VISIBLE_ALPHA) continue;
      [left, top] = [Math.min(left, x), Math.min(top, y)];
      [right, bottom] = [Math.max(right, x), Math.max(bottom, y)];
    }
  }
  if (right < 0) throw new Error("The art has no visible pixels.");
  const width = right - left + 1;
  const height = bottom - top + 1;
  const side = Math.max(width, height);
  const x = side - width;
  const y = side - height;
  return sharp(
    await fromRaw(image)
      .extract({ left, top, width, height })
      .extend({
        top: Math.floor(y / 2),
        bottom: Math.ceil(y / 2),
        left: Math.floor(x / 2),
        right: Math.ceil(x / 2),
        background: TRANSPARENT,
      })
      .png()
      .toBuffer(),
  );
}

// A one-channel image, the size of `image`, as sharp's input.
function grey({ width, height }: RawImage, values: Buffer): Sharp {
  return sharp(values, { raw: { width, height, channels: 1 } });
}

// Runs `pipeline` and returns its first channel, one value per pixel. sharp can write a
// one-channel result back out as sRGB, with the value in each of three channels.
async function oneChannel({ width, height }: RawImage, pipeline: Sharp): Promise<Buffer> {
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  if (info.width !== width || info.height !== height) {
    throw new Error(`A mask step returned ${info.width}x${info.height}, not ${width}x${height}.`);
  }
  if (info.channels === 1) return data;
  const values = Buffer.alloc(width * height);
  for (let pixel = 0; pixel < values.length; pixel++) {
    values[pixel] = data[pixel * info.channels] ?? 0;
  }
  return values;
}

// Removes the loose straws. Blurring the alpha channel averages a thin straw with the empty
// space around it, so it falls under the threshold, while the round body stays above it. The
// blur is a share of the image's width, so it does the same at any source size.
//
// Each step runs in a pipeline of its own. sharp keeps one setting per operation in a pipeline,
// so a second blur() or extractChannel() replaces the first, and it runs the operations in its
// own order, whatever the call order: it thresholds before it blurs, for example (`blur` in
// sharp's lib/operation.js, and the order in src/pipeline.cc).
export async function withoutStraws(image: RawImage): Promise<RawImage> {
  const alpha = await oneChannel(image, fromRaw(image).extractChannel("alpha"));
  const averaged = await oneChannel(image, grey(image, alpha).blur(image.width * 0.052));
  const body = await oneChannel(image, grey(image, averaged).threshold(160));
  const mask = await oneChannel(image, grey(image, body).blur(image.width * 0.0023));
  const data = Buffer.from(image.data);
  for (let pixel = 0; pixel < mask.length; pixel++) {
    const alpha = pixel * 4 + 3;
    data[alpha] = Math.min(data[alpha] ?? 0, mask[pixel] ?? 0);
  }
  return { ...image, data };
}

// Turns alpha under about 35% clear and over about 65% solid, with a short ramp between, so the
// edge stays smooth without a wide blurred band.
function hardenEdge(image: RawImage): RawImage {
  const data = Buffer.from(image.data);
  for (let alpha = 3; alpha < data.length; alpha += 4) {
    data[alpha] = Math.max(0, Math.min(255, Math.round(((data[alpha] ?? 0) - 90) * (255 / 75))));
  }
  return { ...image, data };
}

async function makeIcon(source: Sharp, size: IconSize): Promise<Sharp> {
  const spec = ICONS[size];
  let icon = await raw(sharp(await source.png().toBuffer()).resize(spec.art, spec.art));
  if (spec.crisp) {
    icon = hardenEdge(
      await raw(sharp(await fromRaw(icon).png().toBuffer()).sharpen({ sigma: 0.5 })),
    );
  }
  const padding = size - spec.art;
  return fromRaw(icon).extend({
    top: Math.floor(padding / 2),
    bottom: Math.ceil(padding / 2),
    left: Math.floor(padding / 2),
    right: Math.ceil(padding / 2),
    background: TRANSPARENT,
  });
}

async function writeIcons(): Promise<void> {
  const bale = await squareCrop(clearHiddenColor(await raw(sharp(SOURCE))));
  const body = await squareCrop(await withoutStraws(await raw(bale)));
  for (const size of ICON_SIZES) {
    const icon = await makeIcon(ICONS[size].withoutStraws ? body : bale, size);
    const file = fileURLToPath(new URL(iconPath(size), PUBLIC_DIR));
    await mkdir(dirname(file), { recursive: true });
    await icon.png({ compressionLevel: 9 }).toFile(file);
  }
}

if (import.meta.main) {
  try {
    await writeIcons();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
