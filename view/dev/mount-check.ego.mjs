// Checks that the 3D view draws after it starts in a 0x0 iframe that later grows without a resize event reaching it,
// which Drawdy's floating element can do on a second open.
// Run `npm run dev:view`, then: ego-browser nodejs < view/dev/mount-check.ego.mjs
// For a dev server on another port: ego-browser nodejs -e 'globalThis.VIEW_ORIGIN = "http://localhost:5281"; await import("file:///<repo>/view/dev/mount-check.ego.mjs")'

const origin = globalThis.VIEW_ORIGIN ?? "http://localhost:5180";
const task = await taskSpace("paper-stage-view");
const page = task.page("p1");
await page.goto(`${origin}/?stage=demo-mount&me=mount-check&name=Mount`);
await page.waitForSelector("iframe");

const result = await page.evaluate(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const muteResize =
        "<script>const add = window.addEventListener;" +
        "window.addEventListener = (type, ...rest) => type === 'resize' ? undefined : add.call(window, type, ...rest);</script>";
    const frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;left:20px;top:40px;width:0;height:0;border:0;z-index:9";
    frame.srcdoc = document.querySelector("iframe").getAttribute("srcdoc").replace("<body>", `<body>${muteResize}`);
    document.body.appendChild(frame);
    await wait(2000);
    const view = () => frame.contentWindow;
    const buffer = () => {
        const canvas = view().document.getElementById("stage");
        return [canvas.width, canvas.height];
    };
    const atZero = buffer();
    frame.style.width = "600px";
    frame.style.height = "400px";
    await wait(2000);
    const grown = buffer();
    const ratio = Math.min(view().devicePixelRatio, 2);
    return {
        atZero,
        grown,
        expected: [Math.floor(600 * ratio), Math.floor(400 * ratio)],
        stage: { ...view().paperStage },
    };
});

const pass = result.grown[0] === result.expected[0] && result.grown[1] === result.expected[1];
console.log(JSON.stringify({ pass, ...result }));
console.log(await page.screenshot({ path: "/tmp/paper-stage-view/mount-check.png" }));
