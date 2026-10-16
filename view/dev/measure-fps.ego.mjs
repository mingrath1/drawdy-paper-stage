// Measures the 3D view's frame rate on the perf stage (40 walls, 30 cutouts) while the walker turns in place.
// Run `npm run dev:view`, then: ego-browser nodejs < view/dev/measure-fps.ego.mjs
// Browsers may cap requestAnimationFrame below the display rate (an agent window here runs at 30 Hz), so each run
// drives frames back to back instead. Every frame first reads one pixel, which waits for the GPU to finish the
// previous frame, so a frame's time is its full CPU and GPU cost. The capped run reports what rAF delivered.

const RUNS = 5;
const SECONDS = 5;
const SIZES = [
    { width: 1200, height: 800, deviceScaleFactor: 1 },
    { width: 1152, height: 720, deviceScaleFactor: 2 },
];

const task = await taskSpace("paper-stage-view");
const page = task.page("p1");
const results = [];

function measure({ seconds, uncapped }) {
    return new Promise((resolve) => {
        const gl = document.getElementById("stage").getContext("webgl2");
        const pixel = new Uint8Array(4);
        const realFrame = window.requestAnimationFrame;
        const channel = new MessageChannel();
        const starts = [];
        let gpuWait = 0;
        let pending = null;
        channel.port1.onmessage = () => {
            const callback = pending;
            pending = null;
            const before = performance.now();
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
            const now = performance.now();
            gpuWait += now - before;
            starts.push(now);
            callback(now);
        };
        if (uncapped) {
            window.requestAnimationFrame = (callback) => {
                pending = callback;
                channel.port2.postMessage(0);
                return 0;
            };
        } else {
            const count = (now) => {
                starts.push(now);
                if (starts.length && now - starts[0] < seconds * 1000) realFrame(count);
            };
            realFrame(count);
        }
        dispatchEvent(new KeyboardEvent("keydown", { code: "KeyQ" }));
        setTimeout(() => {
            dispatchEvent(new KeyboardEvent("keyup", { code: "KeyQ" }));
            window.requestAnimationFrame = realFrame;
            const gaps = starts
                .slice(1)
                .map((t, i) => t - starts[i])
                .sort((a, b) => a - b);
            const span = starts[starts.length - 1] - starts[0];
            resolve({
                frames: starts.length,
                fps: Math.round(((starts.length - 1) * 1000) / span),
                p50Ms: +gaps[Math.floor(gaps.length * 0.5)].toFixed(2),
                p95Ms: +gaps[Math.floor(gaps.length * 0.95)].toFixed(2),
                gpuWaitMsPerFrame: uncapped ? +(gpuWait / starts.length).toFixed(2) : null,
                contextLost: gl.isContextLost(),
                stage: { ...globalThis.paperStage },
            });
        }, seconds * 1000);
    });
}

for (const size of SIZES) {
    await page.cdp("Emulation.setDeviceMetricsOverride", { ...size, mobile: false });
    await page.goto(`http://localhost:5180/bare?stage=perf-measure&me=measurer&name=Measurer`);
    await page.waitForFunction(
        () => globalThis.paperStage?.cutouts === 30 && globalThis.paperStage?.walls === 40,
        undefined,
        { timeout: 15_000 },
    );
    await page.waitForTimeout(3_000);
    const capped = await page.evaluate(measure, { seconds: SECONDS, uncapped: false });
    const runs = [];
    for (let i = 0; i < RUNS; i++) runs.push(await page.evaluate(measure, { seconds: SECONDS, uncapped: true }));
    const fps = runs.map((run) => run.fps).sort((a, b) => a - b);
    results.push({
        size,
        capped,
        uncappedMedianFps: fps[Math.floor(RUNS / 2)],
        uncappedRange: [fps[0], fps[RUNS - 1]],
        runs,
    });
}
await page.cdp("Emulation.clearDeviceMetricsOverride", {});

const { writeFile } = await import("node:fs/promises");
await writeFile("/tmp/paper-stage-view/fps.json", JSON.stringify(results, null, 2));
for (const r of results) {
    console.log(
        `${r.size.width}x${r.size.height}@${r.size.deviceScaleFactor}x: uncapped median ${r.uncappedMedianFps} fps (range ${r.uncappedRange.join("-")}), ` +
            `p95 frame ${r.runs.map((run) => run.p95Ms).join("/")} ms, gpu wait ${r.runs.map((run) => run.gpuWaitMsPerFrame).join("/")} ms; ` +
            `capped rAF ${r.capped.fps} fps p95 ${r.capped.p95Ms} ms; stage ${JSON.stringify(r.runs[0].stage)}`,
    );
}
