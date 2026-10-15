// Generates the extension's PNG icons without any image dependencies.
// The logo: a ring crossed by four arrows pointing outwards, with a dot in the centre, light grey on a dark tile.
// Run with: node scripts/make-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const OUT = new URL('../src/public/icons/', import.meta.url)
const BG = [20, 20, 20]
const FG = [214, 214, 214]
const SAMPLES = 4 // supersampling per axis, for smooth edges

// Geometry in a 0..1 unit square, centred on (0.5, 0.5).
const C = 0.5
const RING_RADIUS = 0.25
const ARM = 0.4 // how far each arrow reaches from the centre
const HEAD = 0.11 // arrowhead arm length
const HEAD_ANGLE = (28 * Math.PI) / 180
const DOT_RADIUS = 0.055

/** Line segments that make up the cross and the four arrowheads. */
function segments() {
  const segs = []
  for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
    const tip = [C + dx * ARM, C + dy * ARM]
    segs.push([[C, C], tip])
    // Each arrowhead is two short strokes angled back from the tip.
    for (const side of [-1, 1]) {
      const a = Math.atan2(-dy, -dx) + side * HEAD_ANGLE
      segs.push([tip, [tip[0] + Math.cos(a) * HEAD, tip[1] + Math.sin(a) * HEAD]])
    }
  }
  return segs
}

function distToSegment(px, py, [[ax, ay], [bx, by]]) {
  const vx = bx - ax
  const vy = by - ay
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)))
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy))
}

function isForeground(x, y, halfStroke, segs) {
  const r = Math.hypot(x - C, y - C)
  if (r <= DOT_RADIUS) return true
  if (Math.abs(r - RING_RADIUS) <= halfStroke) return true
  return segs.some((s) => distToSegment(x, y, s) <= halfStroke)
}

function inTile(x, y, cornerRadius) {
  const dx = Math.max(Math.abs(x - C) - (C - cornerRadius), 0)
  const dy = Math.max(Math.abs(y - C) - (C - cornerRadius), 0)
  return Math.hypot(dx, dy) <= cornerRadius
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function icon(size) {
  const segs = segments()
  // Thicker strokes at small sizes so the 16px icon doesn't turn into mush.
  const halfStroke = Math.max(0.022, 0.75 / size)
  const raw = Buffer.alloc(size * (size * 4 + 1))

  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) {
      let fg = 0
      let tile = 0
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const ux = (x + (sx + 0.5) / SAMPLES) / size
          const uy = (y + (sy + 0.5) / SAMPLES) / size
          if (!inTile(ux, uy, 0.2)) continue
          tile++
          if (isForeground(ux, uy, halfStroke, segs)) fg++
        }
      }
      const mix = tile ? fg / tile : 0
      const i = y * (size * 4 + 1) + 1 + x * 4
      for (let ch = 0; ch < 3; ch++) raw[i + ch] = Math.round(BG[ch] + (FG[ch] - BG[ch]) * mix)
      raw[i + 3] = Math.round((tile / (SAMPLES * SAMPLES)) * 255)
    }
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync(OUT, { recursive: true })
for (const size of [16, 32, 48, 128, 512]) writeFileSync(new URL(`icon-${size}.png`, OUT), icon(size))
console.log('Icons written to src/public/icons/')
