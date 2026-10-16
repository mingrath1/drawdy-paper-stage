import type { ServerMessage, ViewBoot } from "../shared/protocol";
import {
    Color,
    DirectionalLight,
    Fog,
    HemisphereLight,
    Mesh,
    MeshBasicMaterial,
    PCFSoftShadowMap,
    PerspectiveCamera,
    PlaneGeometry,
    Scene,
    WebGLRenderer,
} from "./vendor/three.module.js";
import { AssetCache, cutoutLoader, freeCutout } from "./assets";
import { Bodies } from "./bodies";
import { Hands } from "./hands";
import { Hud } from "./hud";
import { StageLink } from "./link";
import { IDLE_POSE_CLOCK, stepPoseClock } from "./pose";
import { StageModel } from "./stage";
import { WalkControls } from "./walk";

const SKY = "#e9edf1";

const boot = JSON.parse(document.getElementById("boot")!.textContent!) as ViewBoot;
const canvas = document.getElementById("stage") as HTMLCanvasElement;
const hud = new Hud();

const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFSoftShadowMap;

const scene = new Scene();
scene.background = new Color(SKY);
scene.fog = new Fog(SKY, 18, 60);
const camera = new PerspectiveCamera(70, 1, 0.05, 200);

const sun = new DirectionalLight("#fff6e8", 1.9);
sun.position.set(-6, 12, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target, new HemisphereLight("#ffffff", "#cfc6b4", 1.6));

const desk = new Mesh(
    new PlaneGeometry(400, 400).rotateX(-Math.PI / 2).translate(0, -0.01, 0),
    new MeshBasicMaterial({ color: "#dde2e8" }),
);
scene.add(desk);

const anisotropy = renderer.capabilities.getMaxAnisotropy();
const stage = new StageModel(new AssetCache(cutoutLoader(boot, anisotropy), freeCutout), sun, anisotropy);
const bodies = new Bodies();
const hands = new Hands(boot.participant.presenceId);
scene.add(stage.root, bodies.root, hands.root);

const walk = new WalkControls(canvas);
let poseClock = IDLE_POSE_CLOCK;
let connectionId = "";

const HANDLERS: { [K in ServerMessage["type"]]: (message: Extract<ServerMessage, { type: K }>) => void } = {
    welcome(message) {
        connectionId = message.connectionId;
        const before = stage.frame;
        stage.load(message.snapshot);
        walk.settle(stage, before);
        bodies.reset(
            message.walkers.filter((w) => w.connectionId !== connectionId),
            stage.frame,
            performance.now(),
        );
        poseClock = IDLE_POSE_CLOCK;
    },
    "scene.patch"(message) {
        const before = stage.frame;
        stage.apply(message);
        walk.settle(stage, before);
    },
    walker(message) {
        if (stage.frame && message.walker.connectionId !== connectionId)
            bodies.set(message.walker, stage.frame, performance.now());
    },
    "walker.left"(message) {
        bodies.remove(message.connectionId);
    },
    cursors(message) {
        if (stage.frame) hands.set(message.cursors, stage.frame);
    },
    error(message) {
        console.warn("paper-stage:", message.code, message.message);
    },
    writer() {},
    ack() {},
    pong() {},
};

const link = new StageLink(
    boot,
    (message) => (HANDLERS[message.type] as (message: ServerMessage) => void)(message),
    (status) => hud.link(status),
);

function resize(): void {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / Math.max(1, innerHeight);
    camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

/** Read by verification scripts: the last whole second's frame rate and what was on stage. */
const stats = { fps: 0, walls: 0, cutouts: 0, drawCalls: 0 };
Object.assign(globalThis, { paperStage: stats });

let frames = 0;
let windowStart = performance.now();
let last = windowStart;

renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    const frame = stage.frame;
    walk.update(dt, stage.collisionEdges, stage.bounds);
    walk.apply(camera);
    if (walk.walked) hud.walked();
    if (frame && link.live) {
        const step = stepPoseClock(poseClock, now, walk.pose(frame));
        poseClock = step.clock;
        if (step.send) link.send({ type: "pose", pose: step.send });
    }
    stage.update(dt, walk.position);
    if (frame) {
        bodies.update(dt, now, frame);
        hands.update(dt, now / 1000, frame);
    }
    renderer.render(scene, camera);

    frames++;
    if (now - windowStart >= 1000) {
        stats.fps = Math.round((frames * 1000) / (now - windowStart));
        stats.walls = stage.walls;
        stats.cutouts = stage.cutouts;
        stats.drawCalls = renderer.info.render.calls;
        frames = 0;
        windowStart = now;
        hud.frameRate(stats.fps);
        hud.count(new Set([boot.participant.presenceId, ...bodies.presenceIds(), ...hands.presenceIds()]).size);
    }
});
