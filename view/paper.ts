/** Paper for a picture whose background is already transparent. */
const PLAIN_PAPER: Rgb = [252, 250, 244];
/** A board color within this distance on every channel counts as background. */
const BACKGROUND_TOLERANCE = 40;
/** A border color more saturated than this is part of the picture, such as a sticky filling the capture. */
const MAX_BACKGROUND_SATURATION = 40;
const MARGIN_PX = 4;

type Rgb = [number, number, number];

/**
 * Cuts a captured picture out of its board like scissors would, in place. The board background connected to the
 * picture's border turns transparent, while background enclosed by strokes stays as paper. A thin margin of the
 * board's own color rings the drawing, with a darker, softened last pixel as the paper edge, so black ink on a light
 * board and white ink on a dark board both stay readable.
 */
export function cutOutPaper(pixels: Uint8ClampedArray, width: number, height: number): void {
    const background = borderBackground(pixels, width, height);
    if (background === "picture") return;
    const paper = background === "transparent" ? PLAIN_PAPER : background;
    const edge = edgeTone(paper);
    const isBackground =
        background === "transparent"
            ? (i: number) => pixels[i * 4 + 3] < 128
            : (i: number) => pixels[i * 4 + 3] < 128 || colorDistance(pixels, i, background) <= BACKGROUND_TOLERANCE;

    const outside = floodFromBorder(width, height, isBackground);
    const distance = marginDistances(outside, width, height, MARGIN_PX + 1);
    for (let i = 0; i < width * height; i++) {
        const o = i * 4;
        if (!outside[i]) {
            flattenOnto(pixels, o, paper);
            continue;
        }
        const d = distance[i];
        const tone = d > MARGIN_PX - 1.5 ? edge : paper;
        pixels[o] = tone[0];
        pixels[o + 1] = tone[1];
        pixels[o + 2] = tone[2];
        pixels[o + 3] = Math.round(Math.min(1, Math.max(0, MARGIN_PX + 0.5 - d)) * 255);
    }
}

function borderBackground(pixels: Uint8ClampedArray, width: number, height: number): Rgb | "transparent" | "picture" {
    const border: number[] = [];
    for (let x = 0; x < width; x++) border.push(x, (height - 1) * width + x);
    for (let y = 1; y < height - 1; y++) border.push(y * width, y * width + width - 1);
    const opaque = border.filter((i) => pixels[i * 4 + 3] >= 128);
    if (opaque.length < border.length / 2) return "transparent";
    const color: Rgb = [0, 1, 2].map((c) => median(opaque.map((i) => pixels[i * 4 + c]))) as Rgb;
    return Math.max(...color) - Math.min(...color) > MAX_BACKGROUND_SATURATION ? "picture" : color;
}

function floodFromBorder(width: number, height: number, isBackground: (i: number) => boolean): Uint8Array {
    const outside = new Uint8Array(width * height);
    const queue = new Int32Array(width * height);
    let head = 0;
    let tail = 0;
    const visit = (i: number) => {
        if (outside[i] || !isBackground(i)) return;
        outside[i] = 1;
        queue[tail++] = i;
    };
    for (let x = 0; x < width; x++) {
        visit(x);
        visit((height - 1) * width + x);
    }
    for (let y = 0; y < height; y++) {
        visit(y * width);
        visit(y * width + width - 1);
    }
    while (head < tail) {
        const i = queue[head++];
        const x = i % width;
        if (x > 0) visit(i - 1);
        if (x < width - 1) visit(i + 1);
        if (i >= width) visit(i - width);
        if (i < width * (height - 1)) visit(i + width);
    }
    return outside;
}

/**
 * For each outside pixel, its distance in pixels to the nearest picture pixel, measured only within `reach`
 * and Infinity beyond. Round distances give the margin round corners, and fractions give it a soft edge.
 */
function marginDistances(outside: Uint8Array, width: number, height: number, reach: number): Float32Array {
    const distance = new Float32Array(width * height).fill(Infinity);
    const window: [number, number, number][] = [];
    for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
            const d = Math.hypot(dx, dy);
            if (d <= reach) window.push([dx, dy, d]);
        }
    }
    const isOutside = (x: number, y: number) =>
        x >= 0 && y >= 0 && x < width && y < height && outside[y * width + x] === 1;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (outside[y * width + x]) continue;
            if (!isOutside(x - 1, y) && !isOutside(x + 1, y) && !isOutside(x, y - 1) && !isOutside(x, y + 1)) continue;
            for (const [dx, dy, d] of window) {
                if (!isOutside(x + dx, y + dy)) continue;
                const n = (y + dy) * width + x + dx;
                if (d < distance[n]) distance[n] = d;
            }
        }
    }
    return distance;
}

/** Composites a pixel over the paper so alpha testing keeps soft stroke edges. */
function flattenOnto(pixels: Uint8ClampedArray, o: number, paper: Rgb): void {
    const alpha = pixels[o + 3] / 255;
    for (let c = 0; c < 3; c++) pixels[o + c] = Math.round(pixels[o + c] * alpha + paper[c] * (1 - alpha));
    pixels[o + 3] = 255;
}

function edgeTone([r, g, b]: Rgb): Rgb {
    const light = r * 0.299 + g * 0.587 + b * 0.114 > 128;
    return light
        ? [Math.round(r * 0.8), Math.round(g * 0.8), Math.round(b * 0.8)]
        : [Math.round(r + (255 - r) * 0.3), Math.round(g + (255 - g) * 0.3), Math.round(b + (255 - b) * 0.3)];
}

function colorDistance(pixels: Uint8ClampedArray, i: number, [r, g, b]: Rgb): number {
    const o = i * 4;
    return Math.max(Math.abs(pixels[o] - r), Math.abs(pixels[o + 1] - g), Math.abs(pixels[o + 2] - b));
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}
