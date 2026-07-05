import { deflateSync, inflateSync } from "node:zlib";

/**
 * A minimal, dependency-free PNG codec — just enough to support pixel-level
 * `knockout: "chroma"` on AI-generated art (`page.ts:resolveImages`). Not a
 * general-purpose PNG library: scope is deliberately narrow (see `decodePng`).
 * Uses Node's built-in `node:zlib` for the DEFLATE stream so no new dependency
 * is needed — only PNG chunk framing, CRC32, and scanline (un)filtering are
 * hand-rolled, mirroring this repo's existing hand-rolled `imageDims` header
 * parse (`svg.ts`) rather than pulling in an image library for this one path.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decoded pixels, always RGBA regardless of the source PNG's colour type. */
export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA, length === width * height * 4. */
  pixels: Uint8Array;
}

// --- CRC32 (PNG chunk checksums; independent of zlib's internal adler32) ---

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// --- Chunk framing ---

interface Chunk {
  type: string;
  data: Buffer;
}

function readChunks(buf: Buffer): Chunk[] {
  const chunks: Chunk[] = [];
  let o = PNG_SIGNATURE.length;
  while (o + 8 <= buf.length) {
    const length = buf.readUInt32BE(o);
    const type = buf.toString("ascii", o + 4, o + 8);
    const dataStart = o + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) throw new Error("PNG chunk runs past end of file (truncated).");
    chunks.push({ type, data: buf.subarray(dataStart, dataEnd) });
    o = dataEnd + 4; // skip the trailing CRC — we don't verify inbound CRCs
    if (type === "IEND") break;
  }
  return chunks;
}

function writeChunk(type: string, data: Uint8Array): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, Buffer.from(data), crcBuf]);
}

// --- Scanline filtering (PNG spec §9) ---

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Reverse per-scanline filtering in place. `raw` is (bpp-padded) filter-byte + row data, repeated per row. */
function unfilter(raw: Buffer, width: number, height: number, bpp: number): Uint8Array {
  const stride = width * bpp;
  const out = new Uint8Array(stride * height);
  let o = 0; // offset into raw (includes filter-type bytes)
  for (let y = 0; y < height; y++) {
    const filterType = raw[o++];
    const rowStart = y * stride;
    const prevRowStart = rowStart - stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[o + x];
      const a = x >= bpp ? out[rowStart + x - bpp] : 0; // left
      const b = y > 0 ? out[prevRowStart + x] : 0; // up
      const c = y > 0 && x >= bpp ? out[prevRowStart + x - bpp] : 0; // upper-left
      let value: number;
      switch (filterType) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + a;
          break;
        case 2:
          value = rawByte + b;
          break;
        case 3:
          value = rawByte + Math.floor((a + b) / 2);
          break;
        case 4:
          value = rawByte + paeth(a, b, c);
          break;
        default:
          throw new Error(`chroma knockout: unsupported PNG filter type ${filterType}.`);
      }
      out[rowStart + x] = value & 0xff;
    }
    o += stride;
  }
  return out;
}

/** Filter type "None" for every scanline — simplicity over size (images are already small). */
function filterNone(pixels: Uint8Array, width: number, height: number, bpp: number): Buffer {
  const stride = width * bpp;
  const out = Buffer.alloc((stride + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    out[o++] = 0; // filter type 0 = None
    out.set(pixels.subarray(y * stride, y * stride + stride), o);
    o += stride;
  }
  return out;
}

/**
 * Decode a PNG into RGBA pixels. Deliberately narrow scope, sufficient for
 * AI-generated art: 8-bit depth, colour type 2 (RGB) or 6 (RGBA), non-interlaced
 * only. Throws a clear, actionable error for anything else (16-bit, palette,
 * grayscale, interlaced) rather than silently mis-decoding — re-export the
 * source art as a plain 8-bit PNG to use `knockout: "chroma"` on it.
 */
export function decodePng(buf: Buffer): DecodedPng {
  if (buf.length < 8 || !PNG_SIGNATURE.equals(buf.subarray(0, 8))) {
    throw new Error("chroma knockout: not a valid PNG (bad signature).");
  }
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === "IHDR");
  if (!ihdr) throw new Error("chroma knockout: PNG has no IHDR chunk.");
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];
  if (interlace !== 0) {
    throw new Error(
      "chroma knockout requires a non-interlaced PNG — got an interlaced (Adam7) image. " +
        "Re-export the art as a plain, non-interlaced PNG.",
    );
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(
      `chroma knockout requires a plain 8-bit RGB/RGBA PNG (not interlaced/palette/grayscale) ` +
        `— got colorType=${colorType} bitDepth=${bitDepth}. Re-export the art as a plain 8-bit PNG.`,
    );
  }
  const channels = colorType === 6 ? 4 : 3;
  const idat = Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => Buffer.from(c.data)));
  if (idat.length === 0) throw new Error("chroma knockout: PNG has no IDAT data.");
  const raw = inflateSync(idat);
  const decoded = unfilter(raw, width, height, channels);
  if (channels === 4) return { width, height, pixels: decoded };
  // RGB → synthesize alpha=255.
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < decoded.length; i += 3, j += 4) {
    pixels[j] = decoded[i];
    pixels[j + 1] = decoded[i + 1];
    pixels[j + 2] = decoded[i + 2];
    pixels[j + 3] = 255;
  }
  return { width, height, pixels };
}

/** Encode RGBA pixels as an 8-bit truecolor+alpha (colour type 6) PNG. */
export function encodePng(img: DecodedPng): Buffer {
  const { width, height, pixels } = img;
  if (pixels.length !== width * height * 4) {
    throw new Error("encodePng: pixels length doesn't match width*height*4.");
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolor + alpha
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace: none
  const filtered = filterNone(pixels, width, height, 4);
  const idat = deflateSync(filtered);
  return Buffer.concat([
    PNG_SIGNATURE,
    writeChunk("IHDR", ihdr),
    writeChunk("IDAT", idat),
    writeChunk("IEND", new Uint8Array(0)),
  ]);
}

/**
 * Key a solid background colour to transparent, in place. Per-pixel: if every
 * channel is within `tolerance` of `target`, set alpha to 0. A hard cutoff — no
 * edge feathering (a real anti-aliasing decision, left as a documented v1
 * limitation rather than engineered around here).
 */
export function chromaKeyPixels(
  pixels: Uint8Array,
  target: { r: number; g: number; b: number },
  tolerance: number,
): void {
  for (let i = 0; i < pixels.length; i += 4) {
    const dr = Math.abs(pixels[i] - target.r);
    const dg = Math.abs(pixels[i + 1] - target.g);
    const db = Math.abs(pixels[i + 2] - target.b);
    if (Math.max(dr, dg, db) <= tolerance) pixels[i + 3] = 0;
  }
}
