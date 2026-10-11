// Generates app/assets/notification-icon.png, the Android notification
// small icon that the expo-notifications config plugin installs (phase 18
// item 0). The image is drawn from the geometry below, so the asset can be
// reproduced from source without a design tool or a download:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   cd app && node scripts/make-notification-icon.mjs
//
// Requirements, from the installed expo-notifications 57.0.22 plugin
// (plugin/src/withNotifications.ts, the `icon` property: "96x96 all-white
// png with transparency") and the SDK 57 documentation
// (docs.expo.dev/versions/v57.0.0/sdk/notifications, "Custom notification
// icon and colors": "the icon must be all white with a transparent
// background"). Android draws a notification small icon from its alpha
// channel only, so the picture is carried entirely by transparency.
//
// What is drawn: a Shiba Inu head seen from the front, as one solid white
// silhouette — a wide rounded face with two upright pointed ears, a V notch
// between them and a pointed ruff of fur flaring out on each cheek — with three transparent cut-outs for the two eyes and
// the nose. The mark sits inside the central 80 of the 96 pixels (2 dp of
// padding at the 24 dp notification icon size), and the cut-outs are large
// enough to stay visible at 24 px (mdpi).
//
// Every pixel's colour channels are pure white (255, 255, 255), including
// fully transparent ones, so no resampling step can pull a dark fringe into
// the edges; only the alpha channel varies. Edges are anti-aliased by 4 x 4
// supersampling, which is deterministic.
//
// The module also exports the model and a minimal PNG reader so that
// app/scripts/check-notifications.mjs can confirm that the checked-in file
// equals what this source draws. Importing it has no side effects; the file
// is written only when the script is run directly.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

export const NOTIFICATION_ICON_SIZE = 96;
export const NOTIFICATION_ICON_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'notification-icon.png');

const SUPERSAMPLE = 4;

const insideEllipse = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

// Point-in-triangle by the signs of the three edge cross products.
const insideTriangle = (x, y, [ax, ay], [bx, by], [cx, cy]) => {
  const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
  const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
  const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
};

// The silhouette in a 96 x 96 coordinate system, y pointing down.
const LEFT_EAR = [[16, 52], [23, 9], [42, 32]];
const RIGHT_EAR = [[80, 52], [73, 9], [54, 32]];
// The ruff of fur on each cheek, a Shiba's widest point, flaring outwards.
const LEFT_CHEEK = [[17, 48], [8, 70], [30, 81]];
const RIGHT_CHEEK = [[79, 48], [88, 70], [66, 81]];

/** Whether the point (x, y) in icon coordinates is inside the white mark. */
export function insideMark(x, y) {
  const solid =
    insideEllipse(x, y, 48, 58, 33, 26) ||
    insideTriangle(x, y, ...LEFT_EAR) ||
    insideTriangle(x, y, ...RIGHT_EAR) ||
    insideTriangle(x, y, ...LEFT_CHEEK) ||
    insideTriangle(x, y, ...RIGHT_CHEEK);
  if (!solid) return false;
  const cutOut =
    insideEllipse(x, y, 35, 56, 5, 5.5) ||
    insideEllipse(x, y, 61, 56, 5, 5.5) ||
    insideEllipse(x, y, 48, 70, 6.5, 4.5);
  return !cutOut;
}

/** The icon as straight (non-premultiplied) RGBA bytes, row by row. */
export function renderNotificationIcon(size = NOTIFICATION_ICON_SIZE) {
  const scale = NOTIFICATION_ICON_SIZE / size;
  const rgba = new Uint8Array(size * size * 4);
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const x = (px + (sx + 0.5) / SUPERSAMPLE) * scale;
          const y = (py + (sy + 0.5) / SUPERSAMPLE) * scale;
          if (insideMark(x, y)) hits++;
        }
      }
      const o = (py * size + px) * 4;
      rgba[o] = 255;
      rgba[o + 1] = 255;
      rgba[o + 2] = 255;
      rgba[o + 3] = Math.round((255 * hits) / samples);
    }
  }
  return rgba;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/** Encodes 8-bit RGBA pixels as a PNG (colour type 6, no interlace, filter 0 on every row). */
export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method 0
  ihdr[12] = 0; // no interlace
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A minimal PNG reader for 8-bit RGBA, non-interlaced images (the only kind
 * this script writes). It verifies the signature and every chunk's CRC,
 * concatenates the IDAT chunks and undoes all five row filters of the PNG
 * specification, so it also reads a file re-saved by another encoder in the
 * same colour type. Anything else is refused with an error.
 */
export function decodePng(bytes) {
  const buf = Buffer.from(bytes);
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG (bad signature)');
  let offset = 8;
  let header = null;
  const idat = [];
  let ended = false;
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    const crc = buf.readUInt32BE(offset + 8 + length);
    if (crc32(buf.subarray(offset + 4, offset + 8 + length)) !== crc) throw new Error(`bad CRC in ${type}`);
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colourType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      ended = true;
      break;
    }
    offset += 12 + length;
  }
  if (!header || !ended) throw new Error('missing IHDR or IEND');
  if (header.bitDepth !== 8 || header.colourType !== 6 || header.interlace !== 0) {
    throw new Error(`unsupported PNG layout: bit depth ${header.bitDepth}, colour type ${header.colourType}, interlace ${header.interlace}`);
  }
  const { width, height } = header;
  const bpp = 4;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== (stride + 1) * height) throw new Error('decompressed size does not match the header');
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[y * stride + i - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + i] : 0;
      const c = i >= bpp && y > 0 ? out[(y - 1) * stride + i - bpp] : 0;
      let predictor;
      if (filter === 0) predictor = 0;
      else if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else throw new Error(`unknown row filter ${filter}`);
      out[y * stride + i] = (line[i] + predictor) & 0xff;
    }
  }
  return { width, height, rgba: out };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const size = NOTIFICATION_ICON_SIZE;
  const png = encodePng(size, size, renderNotificationIcon(size));
  writeFileSync(NOTIFICATION_ICON_PATH, png);
  console.log(`wrote ${NOTIFICATION_ICON_PATH} (${size} x ${size}, ${png.length} bytes)`);
}
