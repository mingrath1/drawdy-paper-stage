import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bytesToBase64, captureArea, contentHash, CutoutCache, sha256Hex } from "../src/cutouts";
import type { BoardElement } from "../src/stage-model";

const doodle: BoardElement = {
    id: "d",
    type: "freedraw",
    x: 100,
    y: 50,
    width: 40,
    height: 20,
    rotation: 0,
    points: [
        [100, 50],
        [120, 70],
        [140, 55],
    ],
    strokeColor: "oklch(0.93 0.005 260)",
    strokeWidth: 4,
};

describe("contentHash", () => {
    it("ignores where the drawing sits", () => {
        const moved = {
            ...doodle,
            x: 600,
            y: -200,
            points: doodle.points!.map(([x, y]) => [x + 500, y - 250] as [number, number]),
        };
        expect(contentHash(moved)).toBe(contentHash(doodle));
    });

    it.each([
        [
            "shape",
            {
                points: [
                    [100, 50],
                    [125, 70],
                    [140, 55],
                ],
            },
        ],
        ["size", { width: 80 }],
        ["rotation", { rotation: 0.3 }],
        ["text", { text: "ซอยฝนนีออน" }],
        ["stroke color", { strokeColor: "#ff0000" }],
        ["stroke width", { strokeWidth: 2 }],
    ])("changes with %s", (_, change) => {
        expect(contentHash({ ...doodle, ...change } as BoardElement)).not.toBe(contentHash(doodle));
    });
});

describe("captureArea", () => {
    it("pads the box by 4 px", () => {
        expect(captureArea({ x: 10, y: 20, width: 40, height: 20 }, 0)).toEqual({ x: 6, y: 16, width: 48, height: 28 });
    });

    it("covers the turned box of a rotated element", () => {
        const area = captureArea({ x: 0, y: 0, width: 40, height: 20 }, Math.PI / 2);
        expect(area.width).toBeCloseTo(28);
        expect(area.height).toBeCloseTo(48);
        expect(area.x + area.width / 2).toBeCloseTo(20);
    });
});

describe("bytesToBase64", () => {
    it("matches Node's encoding for a 2 MB buffer without overflowing the stack", () => {
        const bytes = new Uint8Array(randomBytes(2 * 1024 * 1024 + 7));
        expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    });

    it("encodes an empty buffer", () => {
        expect(bytesToBase64(new Uint8Array())).toBe("");
    });
});

describe("sha256Hex", () => {
    it.each([0, 3, 55, 56, 63, 64, 65, 1000, 1 << 20])("matches node:crypto for %i bytes", (length) => {
        const bytes = new Uint8Array(randomBytes(length));
        expect(sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
    });

    it("hashes the standard test vector", () => {
        expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        );
    });
});

describe("CutoutCache", () => {
    const captured = { ok: true as const, cutout: { asset: { hash: "h", width: 10, height: 10 }, pngBase64: "AA==" } };

    it("returns a capture only for the content hash it was taken at", () => {
        const cache = new CutoutCache();
        cache.set("d", "v1", captured);
        expect(cache.get("d", "v1")).toBe(captured);
        expect(cache.get("d", "v2")).toBeUndefined();
    });

    it("remembers a failure so an unchanged drawing is not retried", () => {
        const cache = new CutoutCache();
        cache.set("d", "v1", { ok: false, reason: "too_big" });
        expect(cache.get("d", "v1")).toEqual({ ok: false, reason: "too_big" });
    });

    it("forgets elements that left the stage", () => {
        const cache = new CutoutCache();
        cache.set("a", "v", captured);
        cache.set("b", "v", captured);
        cache.retain(new Set(["b"]));
        expect(cache.get("a", "v")).toBeUndefined();
        expect(cache.get("b", "v")).toBe(captured);
    });
});
