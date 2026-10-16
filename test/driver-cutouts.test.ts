import type { DriverCommandIssuer, DriverCommandRequest, ModuleStyling } from "@drawdy/driver-protocol";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    bytesToBase64,
    captureArea,
    captureCutout,
    contentHash,
    cropInExport,
    CutoutCache,
    exportBounds,
    sha256Hex,
} from "../src/cutouts";
import { Host } from "../src/host";
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

// Measured on the board: an area inside the 900 by 560 stage frame came back as a 940 by 600 export of the frame.
describe("exportBounds and cropInExport", () => {
    const frame = { x: 125, y: -395.2, width: 900, height: 560 };
    const rect = { x: 275, y: -59.7, width: 120, height: 40 };
    const wall = { x: 185, y: -335.2, width: 780, height: 14 };
    const area = captureArea(rect, 0);

    it("takes the whole frame when the area lies inside it", () => {
        expect(exportBounds(area, [frame, rect, wall])).toEqual(frame);
    });

    it("finds the area inside the padded export", () => {
        expect(cropInExport(area, frame, { width: 940, height: 600 })).toEqual({ sx: 166, sy: 351.5, sw: 128, sh: 48 });
    });

    it("scales the crop with the export", () => {
        expect(cropInExport(area, frame, { width: 1880, height: 1200 })).toEqual({ sx: 332, sy: 703, sw: 256, sh: 96 });
    });

    it("refuses an export whose size does not fit the bounds", () => {
        expect(cropInExport(area, frame, { width: 940, height: 700 })).toBeNull();
    });

    it("joins every element the area touches when there is no frame", () => {
        const sticky = { x: 460, y: 235, width: 200, height: 193 };
        const wave = { x: 280, y: 400, width: 394, height: 80 };
        const far = { x: 2000, y: 2000, width: 10, height: 10 };
        expect(exportBounds(captureArea(sticky, 0), [sticky, wave, far])).toEqual({
            x: 280,
            y: 235,
            width: 394,
            height: 245,
        });
    });

    it("has nothing to export when the area touches nothing", () => {
        expect(exportBounds({ x: 0, y: 0, width: 10, height: 10 }, [{ x: 50, y: 50, width: 5, height: 5 }])).toBeNull();
    });
});

describe("captureCutout", () => {
    const area = { x: 0, y: 0, width: 48, height: 28 };
    const host = new Host(
        ((request: DriverCommandRequest) =>
            Promise.resolve({ ...request, res: { value: { png: new Blob(["not a png"]) } } })) as DriverCommandIssuer,
        "d",
        {} as ModuleStyling,
    );

    afterEach(() => vi.unstubAllGlobals());

    it("reports a picture it cannot decode as failed instead of throwing", async () => {
        vi.stubGlobal("createImageBitmap", () => Promise.reject(new Error("The source image could not be decoded.")));
        await expect(captureCutout(host, area, [area])).resolves.toEqual({ ok: false, reason: "failed" });
    });

    it("reports a picture it cannot encode as failed instead of throwing", async () => {
        const close = vi.fn();
        vi.stubGlobal("createImageBitmap", () => Promise.resolve({ width: 88, height: 68, close }));
        vi.stubGlobal(
            "OffscreenCanvas",
            class {
                getContext() {
                    return { drawImage() {} };
                }
                convertToBlob() {
                    return Promise.reject(new Error("canvas is too large"));
                }
            },
        );
        await expect(captureCutout(host, area, [area])).resolves.toEqual({ ok: false, reason: "failed" });
        expect(close).toHaveBeenCalledOnce();
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

    it("keeps a too-big capture, which comes out the same until the drawing changes", () => {
        const cache = new CutoutCache();
        cache.set("d", "v1", { ok: false, reason: "too_big" });
        expect(cache.get("d", "v1")).toEqual({ ok: false, reason: "too_big" });
    });

    it("retries a failed capture after a backoff that grows and stays bounded", () => {
        let now = 0;
        const cache = new CutoutCache(() => now);
        const waits: number[] = [];
        for (let i = 0; i < 8; i++) {
            cache.set("d", "v1", { ok: false, reason: "failed" });
            const pending = cache.get("d", "v1");
            if (!pending || !("retryInMs" in pending)) throw new Error(`expected a backoff, got ${JSON.stringify(pending)}`);
            waits.push(pending.retryInMs);
            now += pending.retryInMs - 1;
            expect(cache.get("d", "v1")).toEqual({ retryInMs: 1 });
            now += 1;
            expect(cache.get("d", "v1")).toBeUndefined();
        }
        expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
    });

    it("captures a changed drawing at once, even while its old version backs off", () => {
        const cache = new CutoutCache(() => 0);
        cache.set("d", "v1", { ok: false, reason: "failed" });
        expect(cache.get("d", "v2")).toBeUndefined();
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
