import sharp from "sharp";

export const PNG_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

let cachedPngFigure: Buffer | null = null;

export async function pngFigure(): Promise<Buffer> {
  if (cachedPngFigure) {
    return cachedPngFigure;
  }

  const width = 120;
  const height = 90;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      pixels[offset] = (x * 37 + y * 17) % 256;
      pixels[offset + 1] = (x * 11 + y * 53) % 256;
      pixels[offset + 2] = (x * 71 + y * 7) % 256;
    }
  }

  cachedPngFigure = await sharp(pixels, {
    raw: { width, height, channels: 3 },
  })
    .png()
    .toBuffer();
  return cachedPngFigure;
}
