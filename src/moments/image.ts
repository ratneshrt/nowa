// Minimal header parsing for the image formats we accept as moments.
// We only need the type and the *displayed* dimensions, so no decoding —
// just enough to read PNG IHDR, JPEG SOF (+ EXIF orientation) and WebP chunks.

export type ImageInfo = {
  mime: "image/jpeg" | "image/png" | "image/webp";
  ext: "jpg" | "png" | "webp";
  width: number;
  height: number;
};

function u16be(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1];
}

function u32be(b: Uint8Array, o: number): number {
  return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}

function u24le(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
}

function ascii(b: Uint8Array, o: number, len: number): string {
  return String.fromCharCode(...b.subarray(o, o + len));
}

// Reads the EXIF orientation tag from a JPEG APP1 segment (1 = normal).
function exifOrientation(b: Uint8Array, start: number, end: number): number {
  if (ascii(b, start, 4) !== "Exif") return 1;
  const tiff = start + 6;
  const little = ascii(b, tiff, 2) === "II";
  const r16 = (o: number) => (little ? b[o] | (b[o + 1] << 8) : u16be(b, o));
  const r32 = (o: number) =>
    little
      ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
      : u32be(b, o);

  const ifd = tiff + r32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const entries = r16(ifd);
  for (let i = 0; i < entries; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) break;
    if (r16(entry) === 0x0112) return r16(entry + 8);
  }
  return 1;
}

function jpegInfo(b: Uint8Array): ImageInfo | null {
  let orientation = 1;
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) return null;
    const marker = b[o + 1];
    const len = u16be(b, o + 2);
    if (marker === 0xe1) orientation = exifOrientation(b, o + 4, o + 2 + len);
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = u16be(b, o + 5);
      const width = u16be(b, o + 7);
      // Orientations 5–8 rotate by 90°, so the displayed image is transposed.
      const rotated = orientation >= 5 && orientation <= 8;
      return {
        mime: "image/jpeg",
        ext: "jpg",
        width: rotated ? height : width,
        height: rotated ? width : height,
      };
    }
    o += 2 + len;
  }
  return null;
}

function webpInfo(b: Uint8Array): ImageInfo | null {
  const chunk = ascii(b, 12, 4);
  let width = 0;
  let height = 0;
  if (chunk === "VP8 ") {
    width = (b[26] | (b[27] << 8)) & 0x3fff;
    height = (b[28] | (b[29] << 8)) & 0x3fff;
  } else if (chunk === "VP8L") {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    width = (bits & 0x3fff) + 1;
    height = ((bits >> 14) & 0x3fff) + 1;
  } else if (chunk === "VP8X") {
    width = u24le(b, 24) + 1;
    height = u24le(b, 27) + 1;
  } else {
    return null;
  }
  return { mime: "image/webp", ext: "webp", width, height };
}

export function readImageInfo(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 32) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegInfo(bytes);
  if (ascii(bytes, 1, 3) === "PNG") {
    return { mime: "image/png", ext: "png", width: u32be(bytes, 16), height: u32be(bytes, 20) };
  }
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return webpInfo(bytes);
  return null;
}

export function toDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}
