import type {
    CollaborationUserPresence,
    DriverModule,
    DriverSubscriptionEvent,
    SubscribedDrawdyElement,
} from "@drawdy/driver-protocol";
import {
    CURSOR_HZ,
    MAX_CUTOUTS_PER_STAGE,
    MAX_ITEMS_PER_STAGE,
    type AssetHash,
    type ElementId,
    type Participant,
    type Rect,
    type StageItem,
} from "../shared/protocol";
import { BACKEND_URL } from "./config";
import { captureCutout, contentHash, CutoutCache, exportBounds, meets, turnedBox, type CutoutAsset } from "./cutouts";
import { Host, type CommandType, type RequestArgs } from "./host";
import { cursorsOf, participantOf, throttle } from "./presence";
import { Relay } from "./relay";
import { findFreeSpot, findStageFrame, newStageMeta, STAGE_SIZE, starterStage, type StageMeta } from "./stage-frame";
import {
    ELEMENT_PROPERTIES,
    projectStage,
    rectOf,
    reduceScene,
    stageItemOf,
    type BoardItem,
    type SceneEvent,
    type SceneState,
} from "./stage-model";
import { buildViewHtml } from "./view-html";
import { canToggle, CLOSE_ID, otherMode, RESIZE_ID, VIEW_ID, viewLayout, viewSchema, type ViewMode } from "./view-window";
import { WalkerMarkers } from "./walkers";

const BUTTON_ID = "paper-stage-button";
const ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 4l9 6.5"/><path d="M5 9.5V20h14V9.5"/><path d="M10 20v-5h4v5"/></svg>';
const STARTER_COLORS = { ink: "#1e1e1e", wall: "#e8dcc4", pawn: "#e8590c" };
/** At most 10 commits per second while things move; each commit is persisted. */
const FLUSH_MS = 100;
const RETRY_MS = 2_000;
/** A window drag fires many resizes; the view is refitted once they stop. */
const RESIZE_SETTLE_MS = 200;
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
    walkers: WalkerMarkers;
    cutouts: CutoutCache;
    sendCursors: (users: readonly CollaborationUserPresence[]) => void;
    viewHtml: string;
    viewWanted: boolean;
    viewOpen: boolean;
    dropped: { cutouts: number; items: number; tooBig: number };
};

type DriverState =
    | { phase: "idle" }
    | { phase: "starting" }
    | { phase: "running"; stage: Stage }
    | { phase: "stopped" };

/**
 * Drawdy reloads a driver by loading the new bundle into the same worker, with no hook to stop the old one, and may
 * activate one bundle more than once. Each activation registers its stop here by driverId, and the next activation's
 * host sends nothing until that stop has finished.
 */
const LIVE_DRIVERS = Symbol.for("paper-stage.live-drivers");

/** The latest activation of this bundle, which hears Drawdy's events. */
let active: Driver | null = null;

export const activate: DriverModule["activate"] = async (ctx) => {
    const live = ((globalThis as { [LIVE_DRIVERS]?: Map<string, () => unknown> })[LIVE_DRIVERS] ??= new Map());
    const previousStopped = Promise.resolve(live.get(ctx.manifest.driverId)?.());
    const host = new Host(ctx.issueCommand, ctx.manifest.driverId, ctx.styling, previousStopped);
    const driver = new Driver(host, ctx.generateId);
    live.set(ctx.manifest.driverId, () => driver.stop());
    active = driver;
    await driver.start();
};

export const onEvent: DriverModule["onEvent"] = async (event) => active?.onEvent(event);

const ids = (elements: readonly SubscribedDrawdyElement[]) => elements.map((element) => element.id);

const boardBoxes = (scene: SceneState): Rect[] =>
    [...scene.elements.values()].flatMap((element) => {
        const rect = rectOf(element);
        return rect ? [turnedBox(rect, element.rotation ?? 0)] : [];
    });

type CutoutBoardItem = Extract<BoardItem, { kind: "cutout" }>;

/**
 * What a cutout's picture shows: its own drawing, and where every other element drawn into its capture area sits and
 * how it looks. The stage frame is left out, since its background is cut away.
 */
const pictureKey = (scene: SceneState, item: CutoutBoardItem): string =>
    JSON.stringify([
        item.contentHash,
        [...scene.elements.values()]
            .flatMap((element) => {
                const rect = rectOf(element);
                if (!rect || element.id === item.id || element.id === scene.frameId) return [];
                if (!meets(turnedBox(rect, element.rotation ?? 0), item.rect)) return [];
                return [[element.id, Math.round(rect.x), Math.round(rect.y), contentHash(element)]];
            })
            .sort(),
    ]);

/** What a capture of a cutout depends on: its picture, where it sits, and the box Drawdy exports around it. */
const captureKey = (scene: SceneState, item: BoardItem | null): string | null =>
    item?.kind === "cutout"
        ? JSON.stringify([item.rect, pictureKey(scene, item), exportBounds(item.rect, boardBoxes(scene))])
        : null;

/** One activation of Paper Stage. Everything it does to the board goes through its own host. */
class Driver {
    private state: DriverState = { phase: "idle" };
    private readonly subscribed = new Set<string>();
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private flushDue = 0;
    private flushing = false;
    /** When a flush asked for while one runs should start; null when none was asked for. */
    private flushAgainAt: number | null = null;
    private lastFlush = 0;
    private viewQueue = Promise.resolve();
    private resizeTimer: ReturnType<typeof setTimeout> | null = null;
    /** Kept across closing and reopening the view. */
    private viewMode: ViewMode = "docked";

    constructor(
        private readonly host: Host,
        private readonly generateId: () => string,
    ) {}

    async start(): Promise<void> {
        // Only these two run before the first click: neither opens a permission prompt.
        for (const result of [
            await this.host.call("command:dom:create-action-button", { domElementId: BUTTON_ID, svg: ICON }),
            await this.host.call("subscription:dom:element-clicked", { domElementId: BUTTON_ID }),
        ]) {
            if (!result.ok) console.warn(`[paper-stage] activate: ${result.error} ${result.message}`);
        }
    }

    stop(): Promise<void> {
        if (this.state.phase === "running") this.stopStage(this.state.stage);
        this.state = { phase: "stopped" };
        if (this.flushTimer) clearTimeout(this.flushTimer);
        if (this.resizeTimer) clearTimeout(this.resizeTimer);
        return this.host.stop();
    }

    async onEvent(event: DriverSubscriptionEvent): Promise<void> {
        switch (event.type) {
            case "subscription:dom:element-clicked":
                if (event.body.domElementId === BUTTON_ID) return this.onButton();
                if (this.state.phase !== "running") return;
                if (event.body.domElementId === CLOSE_ID) return this.setViewWanted(this.state.stage, false);
                if (event.body.domElementId === RESIZE_ID) return this.toggleViewMode(this.state.stage);
                return;
            case "subscription:scene:elements-added":
            case "subscription:scene:elements-updated":
                return this.onScene({ type: "changed", upserted: event.body.drawdyElements, removed: [] });
            case "subscription:scene:elements-removed":
                return this.onScene({ type: "changed", upserted: [], removed: ids(event.body.drawdyElements) });
            case "subscription:scene:elements-replaced":
                return this.onScene({
                    type: "changed",
                    upserted: event.body.drawdyElements,
                    removed: ids(event.body.replaced),
                });
            case "subscription:collaboration:presence-changed":
                if (this.state.phase === "running") this.state.stage.sendCursors(event.body.users);
                return;
            case "subscription:dom:screen-resized":
                if (this.state.phase === "running") this.onResize(this.state.stage, event.body);
                return;
        }
    }

    private async subscribe<T extends CommandType>(type: T, ...args: RequestArgs<T>): Promise<boolean> {
        const key = `${type} ${JSON.stringify(args)}`;
        if (this.subscribed.has(key)) return true;
        const result = await this.host.run(type, ...args);
        if (result.ok) this.subscribed.add(key);
        return result.ok;
    }

    private async onButton(): Promise<void> {
        if (this.state.phase === "starting" || this.state.phase === "stopped") return;
        if (this.state.phase === "running") return this.setViewWanted(this.state.stage, !this.state.stage.viewWanted);
        const starting: DriverState = { phase: "starting" };
        this.state = starting;
        const stage = await this.openStage().catch((err: unknown) => {
            console.error("[paper-stage] could not open the stage", err);
            return null;
        });
        if (this.state !== starting) return;
        if (!stage) {
            this.state = { phase: "idle" };
            return;
        }
        this.state = { phase: "running", stage };
        stage.relay.start();
        this.scheduleFlush();
        setTimeout(() => {
            if (this.state.phase === "running" && this.state.stage === stage && !stage.relay.welcomed) {
                void this.host.hint("Can't reach the stage server", [
                    "Paper Stage keeps trying. The 3D view opens once it connects.",
                ]);
            }
        }, WELCOME_WAIT_MS);
    }

    private async openStage(): Promise<Stage | null> {
        for (const topic of SCENE_TOPICS)
            if (!(await this.subscribe(topic, { properties: ELEMENT_PROPERTIES }))) return null;
        const board = await this.host.run("command:scene:get-drawdy-elements", { properties: ELEMENT_PROPERTIES });
        if (!board.ok) return null;
        const frame =
            findStageFrame(board.value.drawdyElements) ?? (await this.createStage(board.value.drawdyElements));
        if (!frame) return null;

        const users = await this.host.run("command:collaboration:get-all-users-in-board");
        const self = users.ok ? users.value.users.find((user) => user.isSelf) : undefined;
        const participant = self
            ? participantOf(self)
            : { presenceId: `guest-${Math.random().toString(36).slice(2, 10)}`, name: "Walker", color: "#7c3aed" };
        if (users.ok) await this.subscribe("subscription:collaboration:presence-changed");

        // Read the board again last, so no change between the first read and now is lost.
        const latest = await this.host.run("command:scene:get-drawdy-elements", { properties: ELEMENT_PROPERTIES });
        if (!latest.ok) return null;

        const stage: Stage = {
            meta: frame.meta,
            participant,
            scene: reduceScene(
                { frameId: frame.id, elements: new Map() },
                { type: "loaded", elements: latest.value.drawdyElements },
            ),
            relay: new Relay(BACKEND_URL, frame.meta.stageId, frame.meta.token, participant, {
                welcomed: () => this.syncView(stage),
                syncNeeded: () => this.scheduleFlush(),
                walker: (walker) => stage.walkers.show(walker),
                walkerLeft: (connectionId) => stage.walkers.leave(connectionId),
                rejected: (error, message) => {
                    console.warn(`[paper-stage] commit rejected: ${error} ${message}`);
                    this.scheduleFlush(RETRY_MS);
                },
                refused: (reason) =>
                    void this.host.hint(
                        "The stage server refused this stage",
                        reason === "bad_token"
                            ? [
                                  "The key in this stage frame does not match. Delete the Paper Stage frame and click the button to make a new stage.",
                              ]
                            : ["This version of Paper Stage is out of date. Update the extension and try again."],
                    ),
            }),
            walkers: new WalkerMarkers(this.host, this.host.palette.text, Date.now, participant.presenceId),
            cutouts: new CutoutCache(),
            sendCursors: throttle(1000 / CURSOR_HZ, (users: readonly CollaborationUserPresence[]) =>
                stage.relay.sendCursors(cursorsOf(users)),
            ),
            viewHtml: buildViewHtml({
                backendUrl: BACKEND_URL,
                stageId: frame.meta.stageId,
                token: frame.meta.token,
                participant,
            }),
            viewWanted: true,
            viewOpen: false,
            dropped: { cutouts: 0, items: 0, tooBig: 0 },
        };
        // presence-changed does not fire on subscribe, so the user list read above seeds the cursors.
        if (users.ok) stage.relay.sendCursors(cursorsOf(users.value.users));
        return stage;
    }

    private async createStage(
        elements: readonly SubscribedDrawdyElement[],
    ): Promise<{ id: ElementId; meta: StageMeta } | null> {
        const viewport = await this.host.run("command:camera:get-viewport-rect");
        if (!viewport.ok) return null;
        const spot = findFreeSpot(
            viewport.value.rect,
            elements.flatMap((element) => rectOf(element) ?? []),
        );
        const meta = newStageMeta();
        const schemas = starterStage(spot, meta, STARTER_COLORS, this.generateId);
        const added = await this.host.run("command:scene:add-drawdy-elements", { elements: schemas });
        if (!added.ok) return null;
        await this.host.run("command:camera:fly-to-rect", {
            rect: { ...spot, ...STAGE_SIZE },
            flyDurationMs: 600,
            zoom: 1,
        });
        return { id: schemas[0].drawdyElementId, meta };
    }

    private onScene(event: SceneEvent): void {
        if (this.state.phase !== "running") return;
        this.state.stage.scene = reduceScene(this.state.stage.scene, event);
        this.scheduleFlush();
    }

    /** Flushes after `delay`, or sooner when an earlier flush is already due. */
    private scheduleFlush(delay = 0): void {
        if (this.state.phase !== "running") return;
        const due = Math.max(Date.now() + delay, this.lastFlush + FLUSH_MS);
        if (this.flushing) {
            this.flushAgainAt = Math.min(this.flushAgainAt ?? due, due);
            return;
        }
        if (this.flushTimer) {
            if (this.flushDue <= due) return;
            clearTimeout(this.flushTimer);
        }
        this.flushDue = due;
        this.flushTimer = setTimeout(() => void this.runFlush(), due - Date.now());
    }

    private async runFlush(): Promise<void> {
        this.flushTimer = null;
        this.flushing = true;
        this.lastFlush = Date.now();
        try {
            if (this.state.phase === "running") await this.flush(this.state.stage);
        } catch (err) {
            console.error("[paper-stage] sync failed", err);
        } finally {
            this.flushing = false;
            if (this.flushAgainAt !== null) {
                const at = this.flushAgainAt;
                this.flushAgainAt = null;
                this.scheduleFlush(at - Date.now());
            }
        }
    }

    private async flush(stage: Stage): Promise<void> {
        const scene = stage.scene;
        const projection = projectStage(scene);
        if (!projection) return this.closeStage(stage);
        this.noteDropped(stage, projection.dropped);
        const epoch = stage.relay.writerEpoch;
        if (epoch === null) return;

        const items = new Map<ElementId, StageItem>();
        const assets = new Map<AssetHash, CutoutAsset>();
        const board = boardBoxes(scene);
        let tooBig = 0;
        let retryInMs = Infinity;
        for (const item of projection.items) {
            if (item.kind !== "cutout") {
                items.set(item.id, item);
                continue;
            }
            const picture = pictureKey(scene, item);
            let result = stage.cutouts.get(item.id, picture);
            if (!result) {
                const key = captureKey(scene, item);
                const captured = await captureCutout(this.host, item.rect, board);
                // A capture that finishes after the writer changed belongs to an older epoch.
                if (stage.relay.writerEpoch !== epoch) return;
                // Drawdy exports the board as it is when it runs the command. If the cutout or what gets exported
                // with it changed since this flush began, the pixels may match neither, so they are dropped and
                // captured again.
                if (captureKey(stage.scene, stageItemOf(stage.scene, item.id)) === key) {
                    stage.cutouts.set(item.id, picture, captured);
                    result = stage.cutouts.get(item.id, picture);
                } else {
                    this.scheduleFlush();
                }
            }
            if (result && "retryInMs" in result) retryInMs = Math.min(retryInMs, result.retryInMs);
            if (result && "ok" in result && !result.ok && result.reason === "too_big") {
                tooBig++;
                continue;
            }
            // Until a fresh picture lands, the cutout keeps its last one where it now stands, so it never blinks out.
            const cutout = result && "ok" in result && result.ok ? result.cutout : stage.cutouts.latest(item.id);
            if (!cutout) continue;
            items.set(item.id, { kind: "cutout", id: item.id, rect: item.rect, asset: cutout.asset });
            assets.set(cutout.asset.hash, cutout);
        }
        stage.cutouts.retain(new Set(projection.items.map((item) => item.id)));
        this.noteDropped(stage, { ...projection.dropped, tooBig });
        stage.relay.commit(epoch, { frame: projection.frame, items, assets });
        if (retryInMs < Infinity) this.scheduleFlush(retryInMs);
    }

    private noteDropped(stage: Stage, dropped: Partial<Stage["dropped"]>): void {
        const previous = stage.dropped;
        stage.dropped = { ...previous, ...dropped };
        if ((dropped.cutouts ?? 0) > previous.cutouts) {
            void this.host.hint("Some drawings stay flat", [
                `Paper Stage stands up to ${MAX_CUTOUTS_PER_STAGE} cutouts. ${dropped.cutouts} more stay on the board only.`,
            ]);
        } else if ((dropped.items ?? 0) > previous.items) {
            void this.host.hint("The stage is full", [
                `Paper Stage holds up to ${MAX_ITEMS_PER_STAGE} walls and cutouts. ${dropped.items} more stay on the board only.`,
            ]);
        } else if ((dropped.tooBig ?? 0) > previous.tooBig) {
            void this.host.hint("A drawing is too big to stand up", [
                "Make it smaller or split it into a few drawings.",
            ]);
        }
    }

    private closeStage(stage: Stage): void {
        if (this.state.phase !== "running" || this.state.stage !== stage) return;
        this.stopStage(stage);
        void this.host.hint("The Paper Stage frame is gone", ["Click the Paper Stage button to build a new stage."]);
    }

    private stopStage(stage: Stage): void {
        this.state = { phase: "idle" };
        stage.relay.stop();
        void stage.walkers.stop();
        stage.viewWanted = false;
        this.syncView(stage);
    }

    private setViewWanted(stage: Stage, wanted: boolean): void {
        stage.viewWanted = wanted;
        if (wanted && !stage.relay.welcomed)
            void this.host.hint("Connecting to the stage", ["The 3D view opens once Paper Stage reaches its server."]);
        this.syncView(stage);
    }

    private queueView(task: () => Promise<void>): void {
        this.viewQueue = this.viewQueue
            .then(task)
            .catch((err: unknown) => console.error("[paper-stage] view failed", err));
    }

    /** Opens or closes the 3D view to match intent: open only when wanted and after the relay's first welcome. */
    private syncView(stage: Stage): void {
        this.queueView(() => this.applyView(stage));
    }

    private onResize(stage: Stage, window: { width: number; height: number }): void {
        if (this.resizeTimer) clearTimeout(this.resizeTimer);
        this.resizeTimer = setTimeout(() => {
            this.resizeTimer = null;
            this.queueView(async () => {
                if (stage.viewOpen) await this.placeView(stage, window);
            });
        }, RESIZE_SETTLE_MS);
    }

    private toggleViewMode(stage: Stage): void {
        this.queueView(async () => {
            if (!stage.viewOpen) return;
            const size = await this.host.run("command:dom:window-size");
            if (!size.ok || !canToggle(size.value)) return;
            this.viewMode = otherMode(this.viewMode);
            await this.placeView(stage, size.value);
        });
    }

    private async applyView(stage: Stage): Promise<void> {
        const current = this.state.phase === "running" && this.state.stage === stage;
        const show = current && stage.viewWanted && stage.relay.welcomed;
        if (show === stage.viewOpen) return;
        if (!show) {
            await this.host.run("command:dom:remove-floating-element", { domId: VIEW_ID });
            stage.viewOpen = false;
            return;
        }
        const size = await this.host.run("command:dom:window-size");
        stage.viewOpen = size.ok && (await this.placeView(stage, size.value));
        if (!stage.viewOpen) {
            stage.viewWanted = false;
            return;
        }
        await this.subscribe("subscription:dom:element-clicked", { domElementId: CLOSE_ID });
        await this.subscribe("subscription:dom:element-clicked", { domElementId: RESIZE_ID });
        await this.subscribe("subscription:dom:screen-resized");
    }

    /**
     * Shows the view in its mode, sized to the window. The srcDoc is the same string every time; only the size, the
     * position, and the toggle's label change.
     */
    private async placeView(stage: Stage, window: { width: number; height: number }): Promise<boolean> {
        const layout = viewLayout(window, this.viewMode);
        const placed = await this.host.run("command:dom:upsert-floating-element", {
            domId: VIEW_ID,
            position: layout.position,
            asPopover: false,
            schema: viewSchema(stage.viewHtml, this.viewMode, layout, this.host.palette, canToggle(window)),
        });
        return placed.ok;
    }
}
