import type { CollaborationUserPresence, DriverModule, SubscribedDrawdyElement } from "@drawdy/driver-protocol";
import {
    CURSOR_HZ,
    MAX_CUTOUTS_PER_STAGE,
    MAX_ITEMS_PER_STAGE,
    type AssetHash,
    type ElementId,
    type Participant,
    type Pose,
    type StageItem,
} from "../shared/protocol";
import { BACKEND_URL } from "./config";
import { captureCutout, CutoutCache, type CutoutAsset } from "./cutouts";
import { Host, type CommandType, type RequestArgs } from "./host";
import { cursorsOf, participantOf, RestWatch, throttle } from "./presence";
import { Relay } from "./relay";
import { findFreeSpot, findStageFrame, newStageMeta, STAGE_SIZE, starterStage, type StageMeta } from "./stage-frame";
import { ELEMENT_PROPERTIES, projectStage, rectOf, reduceScene, type SceneEvent, type SceneState } from "./stage-model";
import { buildViewHtml } from "./view-html";
import { CLOSE_ID, VIEW_ID, viewLayout, viewSchema } from "./view-window";

const BUTTON_ID = "paper-stage-button";
const ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 4l9 6.5"/><path d="M5 9.5V20h14V9.5"/><path d="M10 20v-5h4v5"/></svg>';
const STARTER_COLORS = { ink: "#1e1e1e", wall: "#e8dcc4", pawn: "#e8590c" };
/** At most 10 commits per second while things move; each commit is persisted. */
const FLUSH_MS = 100;
const RETRY_MS = 2_000;
const WELCOME_WAIT_MS = 8_000;
const SCENE_TOPICS = [
    "subscription:scene:elements-added",
    "subscription:scene:elements-updated",
    "subscription:scene:elements-removed",
    "subscription:scene:elements-replaced",
] as const;

type Stage = {
    meta: StageMeta;
    participant: Participant;
    scene: SceneState;
    relay: Relay;
    rest: RestWatch;
    cutouts: CutoutCache;
    sendCursors: (users: readonly CollaborationUserPresence[]) => void;
    viewWanted: boolean;
    viewOpen: boolean;
    dropped: { cutouts: number; items: number; tooBig: number };
};

type DriverState = { phase: "idle" } | { phase: "starting" } | { phase: "running"; stage: Stage };

let host: Host;
let generateId: () => string;
let state: DriverState = { phase: "idle" };
const subscribed = new Set<string>();

export const activate: DriverModule["activate"] = async (ctx) => {
    host = new Host(ctx.issueCommand, ctx.manifest.driverId, ctx.styling);
    generateId = ctx.generateId;
    // Only these two run before the first click: neither opens a permission prompt.
    for (const result of [
        await host.call("command:dom:create-action-button", { domElementId: BUTTON_ID, svg: ICON }),
        await host.call("subscription:dom:element-clicked", { domElementId: BUTTON_ID }),
    ]) {
        if (!result.ok) console.warn(`[paper-stage] activate: ${result.error} ${result.message}`);
    }
};

export const onEvent: DriverModule["onEvent"] = async (event) => {
    switch (event.type) {
        case "subscription:dom:element-clicked":
            if (event.body.domElementId === BUTTON_ID) return onButton();
            if (event.body.domElementId === CLOSE_ID && state.phase === "running")
                return setViewWanted(state.stage, false);
            return;
        case "subscription:scene:elements-added":
        case "subscription:scene:elements-updated":
            return onScene({ type: "changed", upserted: event.body.drawdyElements, removed: [] });
        case "subscription:scene:elements-removed":
            return onScene({ type: "changed", upserted: [], removed: ids(event.body.drawdyElements) });
        case "subscription:scene:elements-replaced":
            return onScene({ type: "changed", upserted: event.body.drawdyElements, removed: ids(event.body.replaced) });
        case "subscription:collaboration:presence-changed":
            if (state.phase === "running") state.stage.sendCursors(event.body.users);
            return;
        case "subscription:dom:screen-resized":
            if (state.phase === "running" && state.stage.viewOpen) {
                await host.run("command:dom:move-floating-element", {
                    domId: VIEW_ID,
                    position: viewLayout(event.body).position,
                });
            }
            return;
    }
};

const ids = (elements: readonly SubscribedDrawdyElement[]) => elements.map((element) => element.id);

async function subscribe<T extends CommandType>(type: T, ...args: RequestArgs<T>): Promise<boolean> {
    const key = `${type} ${JSON.stringify(args)}`;
    if (subscribed.has(key)) return true;
    const result = await host.run(type, ...args);
    if (result.ok) subscribed.add(key);
    return result.ok;
}

async function onButton(): Promise<void> {
    if (state.phase === "starting") return;
    if (state.phase === "running") return setViewWanted(state.stage, !state.stage.viewWanted);
    state = { phase: "starting" };
    const stage = await openStage().catch((err: unknown) => {
        console.error("[paper-stage] could not open the stage", err);
        return null;
    });
    if (!stage) {
        state = { phase: "idle" };
        return;
    }
    state = { phase: "running", stage };
    stage.relay.start();
    scheduleFlush();
    setTimeout(() => {
        if (state.phase === "running" && state.stage === stage && !stage.relay.welcomed) {
            void host.hint("Can't reach the stage server", [
                "Paper Stage keeps trying. The 3D view opens once it connects.",
            ]);
        }
    }, WELCOME_WAIT_MS);
}

async function openStage(): Promise<Stage | null> {
    for (const topic of SCENE_TOPICS) if (!(await subscribe(topic, { properties: ELEMENT_PROPERTIES }))) return null;
    const board = await host.run("command:scene:get-drawdy-elements", { properties: ELEMENT_PROPERTIES });
    if (!board.ok) return null;
    const frame = findStageFrame(board.value.drawdyElements) ?? (await createStage(board.value.drawdyElements));
    if (!frame) return null;

    const users = await host.run("command:collaboration:get-all-users-in-board");
    const self = users.ok ? users.value.users.find((user) => user.isSelf) : undefined;
    const participant = self
        ? participantOf(self)
        : { presenceId: `guest-${Math.random().toString(36).slice(2, 10)}`, name: "Walker", color: "#7c3aed" };
    if (users.ok) await subscribe("subscription:collaboration:presence-changed");

    // Read the board again last, so no change between the first read and now is lost.
    const latest = await host.run("command:scene:get-drawdy-elements", { properties: ELEMENT_PROPERTIES });
    if (!latest.ok) return null;

    const stage: Stage = {
        meta: frame.meta,
        participant,
        scene: reduceScene(
            { frameId: frame.id, elements: new Map() },
            { type: "loaded", elements: latest.value.drawdyElements },
        ),
        relay: new Relay(BACKEND_URL, frame.meta.stageId, frame.meta.token, participant, {
            welcomed: () => syncView(stage),
            syncNeeded: () => scheduleFlush(),
            walker: (walker) => stage.rest.walker(walker),
            walkerLeft: (connectionId) => stage.rest.left(connectionId),
            rejected: (error, message) => {
                console.warn(`[paper-stage] commit rejected: ${error} ${message}`);
                if (error === "limit")
                    void host.hint("The stage is full", [
                        "The stage server refused more items. Remove some drawings from the frame.",
                    ]);
                scheduleFlush(RETRY_MS);
            },
            refused: (reason) =>
                void host.hint(
                    "The stage server refused this stage",
                    reason === "bad_token"
                        ? [
                              "The key in this stage frame does not match. Delete the Paper Stage frame and click the button to make a new stage.",
                          ]
                        : ["This version of Paper Stage is out of date. Update the extension and try again."],
                ),
        }),
        rest: new RestWatch(participant.presenceId, (pose) => void movePawn(stage, pose)),
        cutouts: new CutoutCache(),
        sendCursors: throttle(1000 / CURSOR_HZ, (users: readonly CollaborationUserPresence[]) =>
            stage.relay.sendCursors(cursorsOf(users)),
        ),
        viewWanted: true,
        viewOpen: false,
        dropped: { cutouts: 0, items: 0, tooBig: 0 },
    };
    return stage;
}

async function createStage(
    elements: readonly SubscribedDrawdyElement[],
): Promise<{ id: ElementId; meta: StageMeta } | null> {
    const viewport = await host.run("command:camera:get-viewport-rect");
    if (!viewport.ok) return null;
    const spot = findFreeSpot(
        viewport.value.rect,
        elements.flatMap((element) => rectOf(element) ?? []),
    );
    const meta = newStageMeta();
    const schemas = starterStage(spot, meta, STARTER_COLORS, generateId);
    const added = await host.run("command:scene:add-drawdy-elements", { elements: schemas });
    if (!added.ok) return null;
    await host.run("command:camera:fly-to-rect", { rect: { ...spot, ...STAGE_SIZE }, flyDurationMs: 600, zoom: 1 });
    return { id: schemas[0].drawdyElementId, meta };
}

function onScene(event: SceneEvent): void {
    if (state.phase !== "running") return;
    state.stage.scene = reduceScene(state.stage.scene, event);
    scheduleFlush();
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let flushAgain = false;
let lastFlush = 0;

function scheduleFlush(delay = 0): void {
    if (flushing) {
        flushAgain = true;
        return;
    }
    if (flushTimer) return;
    flushTimer = setTimeout(runFlush, Math.max(delay, lastFlush + FLUSH_MS - Date.now(), 0));
}

async function runFlush(): Promise<void> {
    flushTimer = null;
    flushing = true;
    lastFlush = Date.now();
    try {
        if (state.phase === "running") await flush(state.stage);
    } catch (err) {
        console.error("[paper-stage] sync failed", err);
    } finally {
        flushing = false;
        if (flushAgain) {
            flushAgain = false;
            scheduleFlush();
        }
    }
}

async function flush(stage: Stage): Promise<void> {
    const projection = projectStage(stage.scene);
    if (!projection) return closeStage(stage);
    noteDropped(stage, projection.dropped);
    const epoch = stage.relay.writerEpoch;
    if (epoch === null) return;

    const items = new Map<ElementId, StageItem>();
    const assets = new Map<AssetHash, CutoutAsset>();
    let tooBig = 0;
    for (const item of projection.items) {
        if (item.kind !== "cutout") {
            items.set(item.id, item);
            continue;
        }
        let result = stage.cutouts.get(item.id, item.contentHash);
        if (!result) {
            result = await captureCutout(host, item.rect);
            // A capture that finishes after the writer changed belongs to an older epoch.
            if (stage.relay.writerEpoch !== epoch) return;
            stage.cutouts.set(item.id, item.contentHash, result);
        }
        if (!result.ok) {
            if (result.reason === "too_big") tooBig++;
            continue;
        }
        items.set(item.id, { kind: "cutout", id: item.id, rect: item.rect, asset: result.cutout.asset });
        assets.set(result.cutout.asset.hash, result.cutout);
    }
    stage.cutouts.retain(new Set(projection.items.map((item) => item.id)));
    noteDropped(stage, { ...projection.dropped, tooBig });
    stage.relay.commit(epoch, { frame: projection.frame, items, assets });
}

function noteDropped(stage: Stage, dropped: Partial<Stage["dropped"]>): void {
    const previous = stage.dropped;
    stage.dropped = { ...previous, ...dropped };
    if ((dropped.cutouts ?? 0) > previous.cutouts) {
        void host.hint("Some drawings stay flat", [
            `Paper Stage stands up to ${MAX_CUTOUTS_PER_STAGE} cutouts. ${dropped.cutouts} more stay on the board only.`,
        ]);
    } else if ((dropped.items ?? 0) > previous.items) {
        void host.hint("The stage is full", [
            `Paper Stage holds up to ${MAX_ITEMS_PER_STAGE} walls and cutouts. ${dropped.items} more stay on the board only.`,
        ]);
    } else if ((dropped.tooBig ?? 0) > previous.tooBig) {
        void host.hint("A drawing is too big to stand up", ["Make it smaller or split it into a few drawings."]);
    }
}

function closeStage(stage: Stage): void {
    if (state.phase !== "running" || state.stage !== stage) return;
    state = { phase: "idle" };
    stage.relay.stop();
    stage.rest.stop();
    stage.viewWanted = false;
    syncView(stage);
    void host.hint("The Paper Stage frame is gone", ["Click the Paper Stage button to build a new stage."]);
}

async function movePawn(stage: Stage, pose: Pose): Promise<void> {
    const pawn = projectStage(stage.scene)?.items.find((item) => item.kind === "pawn");
    const element = pawn && stage.scene.elements.get(pawn.id);
    const rect = element && rectOf(element);
    if (!pawn || pawn.kind !== "pawn" || !rect || Math.hypot(pawn.x - pose.x, pawn.y - pose.y) < 1) return;
    await host.run("command:scene:update-drawdy-elements", {
        updates: [
            {
                drawdyElementId: pawn.id,
                properties: { transform: { x: pose.x - rect.width / 2, y: pose.y - rect.height / 2 } },
            },
        ],
    });
}

function setViewWanted(stage: Stage, wanted: boolean): void {
    stage.viewWanted = wanted;
    if (wanted && !stage.relay.welcomed)
        void host.hint("Connecting to the stage", ["The 3D view opens once Paper Stage reaches its server."]);
    syncView(stage);
}

let viewQueue = Promise.resolve();

/** Opens or closes the 3D view to match intent: open only when wanted and after the relay's first welcome. */
function syncView(stage: Stage): void {
    viewQueue = viewQueue
        .then(() => applyView(stage))
        .catch((err: unknown) => console.error("[paper-stage] view failed", err));
}

async function applyView(stage: Stage): Promise<void> {
    const current = state.phase === "running" && state.stage === stage;
    const show = current && stage.viewWanted && stage.relay.welcomed;
    if (show === stage.viewOpen) return;
    if (!show) {
        await host.run("command:dom:remove-floating-element", { domId: VIEW_ID });
        stage.viewOpen = false;
        return;
    }
    stage.viewOpen = await openView(stage);
    if (!stage.viewOpen) {
        stage.viewWanted = false;
        return;
    }
    await subscribe("subscription:dom:element-clicked", { domElementId: CLOSE_ID });
    await subscribe("subscription:dom:screen-resized");
}

async function openView(stage: Stage): Promise<boolean> {
    const size = await host.run("command:dom:window-size");
    if (!size.ok) return false;
    const layout = viewLayout(size.value);
    const boot = {
        backendUrl: BACKEND_URL,
        stageId: stage.meta.stageId,
        token: stage.meta.token,
        participant: stage.participant,
    };
    const opened = await host.run("command:dom:upsert-floating-element", {
        domId: VIEW_ID,
        position: layout.position,
        asPopover: false,
        schema: viewSchema(buildViewHtml(boot), layout, host.palette),
    });
    return opened.ok;
}
