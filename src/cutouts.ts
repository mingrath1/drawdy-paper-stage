import type { SubscribedDrawdyElement } from "@drawdy/driver-protocol";
import { MAX_ASSET_BASE64, MAX_ASSET_SIDE_PX, type AssetRef, type ElementId, type Rect } from "../shared/protocol";
import type { Host } from "./host";

export const CAPTURE_PAD = 4;

export type CutoutAsset = { asset: AssetRef; pngBase64: string };

export type CaptureResult = { ok: true; cutout: CutoutAsset } | { ok: false; reason: "failed" | "too_big" };

const STYLE_KEYS = [
    "strokeColor",
    "fillColor",
    "textColor",
    "strokeWidth",
    "opacity",
    "fillStyle",
    "strokeDash",
    "roughness",
    "cornerRadius",
] as const;

const round = (value: number | undefined, digits = 1) => (value === undefined ? null : Number(value.toFixed(digits)));

/** Hash of what a cutout looks like. Position is left out, so moving a doodle never triggers a recapture. */
export function contentHash(element: SubscribedDrawdyElement): string {
    const points = element.points ?? [];
    const [ox, oy] = points[0] ?? [0, 0];
    return cyrb53(
        JSON.stringify([
            element.type,
            element.componentType ?? null,
            round(element.width),
            round(element.height),
            round(element.rotation ?? 0, 3),
            element.text ?? null,
            points.map(([x, y]) => [round(x - ox), round(y - oy)]),
            STYLE_KEYS.map((key) => element[key] ?? null),
        ]),
    );
}

export function captureArea(rect: Rect, rotation: number): Rect {
    const cos = Math.abs(Math.cos(rotation));
    const sin = Math.abs(Math.sin(rotation));
    const width = rect.width * cos + rect.height * sin;
    const height = rect.width * sin + rect.height * cos;
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    return {
        x: cx - width / 2 - CAPTURE_PAD,
        y: cy - height / 2 - CAPTURE_PAD,
        width: width + CAPTURE_PAD * 2,
        height: height + CAPTURE_PAD * 2,
    };
}

function cyrb53(input: string): string {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < input.length; i++) {
        const ch = input.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/** Base64 in fixed-size chunks; spreading a large array into String.fromCharCode overflows the stack. */
export function bytesToBase64(bytes: Uint8Array): string {
    const CHUNK = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

const primes = (count: number) => {
    const found: number[] = [];
    for (let n = 2; found.length < count; n++) if (found.every((p) => n % p !== 0)) found.push(n);
    return found;
};
const fraction32 = (x: number) => ((x - Math.floor(x)) * 2 ** 32) >>> 0;
const SHA_K = Uint32Array.from(primes(64), (p) => fraction32(Math.cbrt(p)));
const SHA_H0 = Uint32Array.from(primes(8), (p) => fraction32(Math.sqrt(p)));
const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** SHA-256 in plain JS: the driver worker runs at an opaque origin, which is not a secure context, so it has no crypto.subtle. */
export function sha256Hex(bytes: Uint8Array): string {
    const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(bytes.length / 2 ** 29));
    view.setUint32(padded.length - 4, (bytes.length << 3) >>> 0);
    const h = Uint32Array.from(SHA_H0);
    const w = new Uint32Array(64);
    for (let offset = 0; offset < padded.length; offset += 64) {
        for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }
        let [a, b, c, d, e, f, g, k] = h;
        for (let i = 0; i < 64; i++) {
            const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[i] + w[i]) | 0;
            const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
            [k, g, f, e, d, c, b, a] = [g, f, e, (d + t1) | 0, c, b, a, (t1 + t2) | 0];
        }
        h[0] += a;
        h[1] += b;
        h[2] += c;
        h[3] += d;
        h[4] += e;
        h[5] += f;
        h[6] += g;
        h[7] += k;
    }
    return Array.from(h, (word) => word.toString(16).padStart(8, "0")).join("");
}

async function fitPng(png: Blob, maxSide: number): Promise<{ bytes: Uint8Array; width: number; height: number }> {
    const bitmap = await createImageBitmap(png);
    try {
        const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
        if (scale === 1)
            return { bytes: new Uint8Array(await png.arrayBuffer()), width: bitmap.width, height: bitmap.height };
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = new OffscreenCanvas(width, height);
        canvas.getContext("2d")!.drawImage(bitmap, 0, 0, width, height);
        const out = await canvas.convertToBlob({ type: "image/png" });
        return { bytes: new Uint8Array(await out.arrayBuffer()), width, height };
    } finally {
        bitmap.close();
    }
}

/** Screenshots an area of the board as a PNG small enough for one `asset.put`. */
export async function captureCutout(host: Host, area: Rect): Promise<CaptureResult> {
    const shot = await host.call("command:scene:capture-screenshot", { area });
    if (!shot.ok) return { ok: false, reason: "failed" };
    for (const side of [MAX_ASSET_SIDE_PX, MAX_ASSET_SIDE_PX / 2]) {
        const { bytes, width, height } = await fitPng(shot.value.png, side);
        const pngBase64 = bytesToBase64(bytes);
        if (pngBase64.length <= MAX_ASSET_BASE64) {
            return { ok: true, cutout: { asset: { hash: sha256Hex(bytes), width, height }, pngBase64 } };
        }
    }
    return { ok: false, reason: "too_big" };
}

/** Captures keyed by element and content hash. A failed capture is remembered so it is not retried until the element changes. */
export class CutoutCache {
    private readonly entries = new Map<ElementId, { hash: string; result: CaptureResult }>();

    get(id: ElementId, hash: string): CaptureResult | undefined {
        const entry = this.entries.get(id);
        return entry?.hash === hash ? entry.result : undefined;
    }

    set(id: ElementId, hash: string, result: CaptureResult): void {
        this.entries.set(id, { hash, result });
    }

    retain(ids: ReadonlySet<ElementId>): void {
        for (const id of this.entries.keys()) if (!ids.has(id)) this.entries.delete(id);
    }
}
