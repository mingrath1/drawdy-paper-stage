// Draws small doodles for the fake stage and encodes them as PNG with no dependencies.

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

function crc32(bytes) {
    let c = 0xffffffff;
    for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
}

export function encodePng(width, height, rgba) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 6;
    const rows = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++)
        Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(rows, y * (width * 4 + 1) + 1);
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(rows)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

/** A canvas of signed-distance shapes, painted back to front with soft edges, on a white board with padding. */
function paint(width, height, shapes) {
    const rgba = new Uint8Array(width * height * 4).fill(255);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const o = (y * width + x) * 4;
            for (const { distance, color } of shapes) {
                const cover = Math.min(1, Math.max(0, 0.5 - distance(x + 0.5, y + 0.5)));
                for (let c = 0; c < 3; c++) rgba[o + c] = Math.round(rgba[o + c] * (1 - cover) + color[c] * cover);
            }
        }
    }
    return rgba;
}

const circle = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r;
const ring = (cx, cy, r, w) => (x, y) => Math.abs(Math.hypot(x - cx, y - cy) - r) - w / 2;
const box = (x0, y0, x1, y1) => (x, y) => Math.max(x0 - x, x - x1, y0 - y, y - y1);
const outline = (shape, w) => (x, y) => Math.abs(shape(x, y)) - w / 2;
const polygon = (points) => (x, y) => {
    let inside = false;
    let nearest = Infinity;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [ax, ay] = points[j];
        const [bx, by] = points[i];
        if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
        const t = Math.max(
            0,
            Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)),
        );
        nearest = Math.min(nearest, Math.hypot(x - ax - (bx - ax) * t, y - ay - (by - ay) * t));
    }
    return inside ? -nearest : nearest;
};

const INK = [38, 34, 29];

function hueColor(hue, saturation = 0.65, light = 0.55) {
    const f = (n) => {
        const k = (n + hue / 30) % 12;
        return Math.round(
            255 * (light - saturation * Math.min(light, 1 - light) * Math.max(-1, Math.min(k - 3, 9 - k, 1))),
        );
    };
    return [f(0), f(8), f(4)];
}

const DOODLES = {
    tree(hue) {
        const leaves = circle(80, 70, 52);
        const trunk = box(70, 110, 90, 196);
        return {
            width: 160,
            height: 200,
            shapes: [
                { distance: trunk, color: [150, 100, 60] },
                { distance: outline(trunk, 4), color: INK },
                { distance: leaves, color: hueColor(hue) },
                { distance: outline(leaves, 5), color: INK },
            ],
        };
    },
    star(hue) {
        const points = Array.from({ length: 10 }, (_, i) => {
            const a = -Math.PI / 2 + (i * Math.PI) / 5;
            const r = i % 2 ? 30 : 72;
            return [80 + r * Math.cos(a), 84 + r * Math.sin(a)];
        });
        const star = polygon(points);
        return {
            width: 160,
            height: 160,
            shapes: [
                { distance: star, color: hueColor(hue, 0.9, 0.6) },
                { distance: outline(star, 5), color: INK },
            ],
        };
    },
    cart(hue) {
        const body = box(20, 50, 180, 120);
        const awning = polygon([
            [14, 50],
            [186, 50],
            [170, 18],
            [30, 18],
        ]);
        return {
            width: 200,
            height: 170,
            shapes: [
                { distance: body, color: hueColor(hue, 0.5, 0.75) },
                { distance: outline(body, 5), color: INK },
                { distance: awning, color: [220, 70, 60] },
                { distance: outline(awning, 4), color: INK },
                { distance: circle(55, 135, 22), color: [250, 250, 250] },
                { distance: ring(55, 135, 22, 5), color: INK },
                { distance: circle(145, 135, 22), color: [250, 250, 250] },
                { distance: ring(145, 135, 22, 5), color: INK },
            ],
        };
    },
};

/** A doodle PNG with its content hash, as a writer would upload it. */
export function doodle(kind, hue) {
    const { width, height, shapes } = DOODLES[kind](hue);
    const png = encodePng(width, height, paint(width, height, shapes));
    return { png, width, height, hash: createHash("sha256").update(png).digest("hex") };
}

export const DOODLE_KINDS = Object.keys(DOODLES);
