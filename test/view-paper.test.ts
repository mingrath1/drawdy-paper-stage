import { describe, expect, it } from "vitest";
import { cutOutPaper } from "../view/paper";

type Rgba = [number, number, number, number];
const SIZE = 40;

/** A ring of `ink` 3 px wide with radius 10 around the center, on `board`, like a captured doodle with padding. */
function ringDoodle(board: Rgba, ink: Rgba): Uint8ClampedArray {
    const pixels = new Uint8ClampedArray(SIZE * SIZE * 4);
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            const r = Math.hypot(x - 20, y - 20);
            pixels.set(r >= 9 && r <= 11 ? ink : board, (y * SIZE + x) * 4);
        }
    }
    return pixels;
}

const at = (pixels: Uint8ClampedArray, x: number, y: number) =>
    Array.from(pixels.slice((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 4));

describe("paper cutouts", () => {
    it("cuts a black doodle out of a white board and keeps its enclosed paper", () => {
        const pixels = ringDoodle([255, 255, 255, 255], [20, 20, 20, 255]);
        cutOutPaper(pixels, SIZE, SIZE);
        expect(at(pixels, 0, 0)[3]).toBe(0);
        expect(at(pixels, 20, 20)).toEqual([255, 255, 255, 255]);
        expect(at(pixels, 30, 20)).toEqual([20, 20, 20, 255]);
        expect(at(pixels, 33, 20)).toEqual([255, 255, 255, 255]);
        const edge = at(pixels, 35, 20);
        expect(edge[3]).toBeGreaterThan(0);
        expect(edge[0]).toBeLessThan(255);
        expect(at(pixels, 37, 20)[3]).toBe(0);
    });

    it("keeps white ink on a dark board readable by cutting from the board's own color", () => {
        const board: Rgba = [30, 30, 34, 255];
        const pixels = ringDoodle(board, [250, 250, 250, 255]);
        cutOutPaper(pixels, SIZE, SIZE);
        expect(at(pixels, 0, 0)[3]).toBe(0);
        expect(at(pixels, 30, 20)).toEqual([250, 250, 250, 255]);
        expect(at(pixels, 33, 20)).toEqual(board);
    });

    it("leaves a picture alone when its border is colorful", () => {
        const pixels = ringDoodle([250, 220, 80, 255], [20, 20, 20, 255]);
        const before = pixels.slice();
        cutOutPaper(pixels, SIZE, SIZE);
        expect(pixels).toEqual(before);
    });

    it("puts plain paper behind a picture with a transparent background", () => {
        const pixels = ringDoodle([0, 0, 0, 0], [200, 40, 40, 128]);
        cutOutPaper(pixels, SIZE, SIZE);
        expect(at(pixels, 0, 0)[3]).toBe(0);
        const stroke = at(pixels, 30, 20);
        expect(stroke[3]).toBe(255);
        expect(stroke[0]).toBeGreaterThan(200);
        expect(at(pixels, 33, 20)).toEqual([252, 250, 244, 255]);
    });
});
