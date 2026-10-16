import {
    CLOSE,
    MAX_ITEMS_PER_COMMIT,
    PROTOCOL_VERSION,
    parseServerMessage,
    stageSocketUrl,
    type AckError,
    type AssetHash,
    type ClientMessage,
    type Cursor,
    type ElementId,
    type Participant,
    type Rect,
    type ServerMessage,
    type StageItem,
    type StageSnapshot,
    type Walker,
    type Writer,
} from "../shared/protocol";
import type { CutoutAsset } from "./cutouts";

export type WriterMessage = Extract<ClientMessage, { type: "scene.commit" | "asset.put" }>;

export type DesiredStage = {
    frame: Rect;
    items: ReadonlyMap<ElementId, StageItem>;
    /** PNGs for the cutouts in `items`, by asset hash. */
    assets: ReadonlyMap<AssetHash, CutoutAsset>;
};

type SyncPlan = {
    epoch: number;
    reset: boolean;
    desired: DesiredStage;
    committed: { frame: Rect | null; items: ReadonlyMap<ElementId, StageItem> };
    uploaded: ReadonlySet<AssetHash>;
    nextRequestId: () => string;
};

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The messages that move the stored stage from what this writer committed to what the board shows. */
export function planSync({ epoch, reset, desired, committed, uploaded, nextRequestId }: SyncPlan): WriterMessage[] {
    const upserts = [...desired.items.values()].filter(
        (item) => reset || !sameJson(committed.items.get(item.id), item),
    );
    const removes = reset ? [] : [...committed.items.keys()].filter((id) => !desired.items.has(id));
    const frameChanged = reset || !sameJson(committed.frame, desired.frame);

    const puts: WriterMessage[] = [];
    const queued = new Set<AssetHash>();
    for (const item of upserts) {
        if (item.kind !== "cutout" || uploaded.has(item.asset.hash) || queued.has(item.asset.hash)) continue;
        const cutout = desired.assets.get(item.asset.hash);
        if (!cutout) continue;
        queued.add(item.asset.hash);
        puts.push({
            type: "asset.put",
            requestId: nextRequestId(),
            epoch,
            ...cutout.asset,
            pngBase64: cutout.pngBase64,
        });
    }
    if (!frameChanged && upserts.length === 0 && removes.length === 0) return puts;

    const changes: ({ upsert: StageItem } | { remove: ElementId })[] = [
        ...upserts.map((upsert) => ({ upsert })),
        ...removes.map((remove) => ({ remove })),
    ];
    const commits: WriterMessage[] = [];
    for (let i = 0; i === 0 || i < changes.length; i += MAX_ITEMS_PER_COMMIT) {
        const chunk = changes.slice(i, i + MAX_ITEMS_PER_COMMIT);
        commits.push({
            type: "scene.commit",
            requestId: nextRequestId(),
            epoch,
            ...(i === 0 && reset ? { reset: true as const } : {}),
            ...(i === 0 && frameChanged ? { frame: desired.frame } : {}),
            upserts: chunk.flatMap((change) => ("upsert" in change ? [change.upsert] : [])),
            removes: chunk.flatMap((change) => ("remove" in change ? [change.remove] : [])),
        });
    }
    return [...puts, ...commits];
}

/**
 * The writer side of one connection. It holds what this connection committed under the current epoch, so each sync
 * sends only the difference. Losing or regaining the writer role resets that record, and the next sync replaces the
 * whole stage.
 */
export class WriterSession {
    epoch: number | null = null;
    private needsReset = true;
    private committed: SyncPlan["committed"] = { frame: null, items: new Map() };
    private uploaded = new Set<AssetHash>();
    private seq = 0;
    private readonly prefix = Math.random().toString(36).slice(2, 8);

    /** Returns true when this connection just became the writer. */
    onWriter(writer: Writer, connectionId: string, storedAssets: ReadonlySet<AssetHash>): boolean {
        const isMine = writer.connectionId === connectionId;
        const becameWriter = isMine && writer.epoch !== this.epoch;
        this.epoch = isMine ? writer.epoch : null;
        if (becameWriter) {
            this.needsReset = true;
            this.uploaded = new Set(storedAssets);
        }
        return becameWriter;
    }

    /** Called on a rejected ack. Returns true when a full resync could repair it. */
    onRejected(error: AckError): boolean {
        if (error === "not_writer" || error === "stale_epoch") {
            this.epoch = null;
            return false;
        }
        if (error === "missing_asset") this.uploaded.clear();
        this.needsReset = true;
        return true;
    }

    /** The stored stage no longer matches what this writer committed, so the next plan replaces it. */
    resync(): void {
        this.needsReset = true;
    }

    plan(epoch: number, desired: DesiredStage): WriterMessage[] {
        if (epoch !== this.epoch) return [];
        const messages = planSync({
            epoch,
            reset: this.needsReset,
            desired,
            committed: this.committed,
            uploaded: this.uploaded,
            nextRequestId: () => `${this.prefix}-${++this.seq}`,
        });
        for (const message of messages) if (message.type === "asset.put") this.uploaded.add(message.hash);
        this.committed = { frame: desired.frame, items: desired.items };
        this.needsReset = false;
        return messages;
    }
}

export const SEND_GAP_MS = 50;
export const ACK_TIMEOUT_MS = 5_000;
const LIMIT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000];

const isCommit = (message: WriterMessage) => message.type === "scene.commit";
const isUpload = (message: WriterMessage) => message.type === "asset.put";

/**
 * Writer messages on their way to the Stage object. The server drops a socket's messages past 60 a second, so the
 * outbox paces them, and resends unanswered or rate-limited ones in order under their original requestIds.
 *
 * Commits carry whole items, so replaying an old commit after a newer one landed would undo the newer one. When a
 * replay cannot keep that order, `settle` asks the writer to resync instead.
 */
export class Outbox {
    private queue: WriterMessage[] = [];
    private inFlight: { message: WriterMessage; sentAt: number }[] = [];
    private nextSendAt = 0;
    private limits = 0;

    constructor(private readonly now: () => number = Date.now) {}

    push(messages: readonly WriterMessage[]): void {
        this.queue.push(...messages);
    }

    /** The next message pacing allows, how long until it may go, or null when nothing waits. */
    take(): { message: WriterMessage } | { waitMs: number } | null {
        if (this.queue.length === 0) return null;
        const now = this.now();
        if (now < this.nextSendAt) return { waitMs: this.nextSendAt - now };
        const message = this.queue.shift()!;
        this.inFlight.push({ message, sentAt: now });
        this.nextSendAt = now + SEND_GAP_MS;
        return { message };
    }

    /**
     * Settles an ack and returns true when the writer must resync. The server answers a socket in order, so anything
     * sent before the acked message and still unanswered was dropped.
     */
    settle(requestId: string, limited: boolean): boolean {
        const index = this.inFlight.findIndex((entry) => entry.message.requestId === requestId);
        if (index < 0) return false;
        const dropped = this.inFlight.splice(0, index).map((entry) => entry.message);
        const answered = this.inFlight.shift()!.message;
        let resync = dropped.some(isCommit);
        const replay: WriterMessage[] = dropped.filter(isUpload);
        if (limited) {
            const later = this.inFlight.splice(0).map((entry) => entry.message);
            if (isUpload(answered) || !later.some(isCommit)) replay.push(answered, ...later);
            else {
                resync = true;
                replay.push(...[answered, ...later].filter(isUpload));
            }
            const backoff = LIMIT_BACKOFF_MS[Math.min(this.limits++, LIMIT_BACKOFF_MS.length - 1)];
            this.nextSendAt = Math.max(this.nextSendAt, this.now() + backoff);
        } else {
            this.limits = 0;
        }
        this.queue.unshift(...replay);
        return resync;
    }

    /** Once the oldest unanswered message has waited too long, puts every unanswered message back at the front. */
    retryStale(): boolean {
        const oldest = this.inFlight[0];
        if (!oldest || this.now() - oldest.sentAt < ACK_TIMEOUT_MS) return false;
        this.queue.unshift(...this.inFlight.map((entry) => entry.message));
        this.inFlight = [];
        return true;
    }

    clear(): void {
        this.queue = [];
        this.inFlight = [];
        this.limits = 0;
    }
}

export type RelayHandlers = {
    /** The first `welcome` on this relay. The stage token is registered from here on. */
    welcomed(): void;
    /** This driver became the writer, or a rejected commit needs a full resync. */
    syncNeeded(): void;
    walker(walker: Walker): void;
    walkerLeft(connectionId: string): void;
    rejected(error: AckError, message: string): void;
    /** The server refused this driver for good. */
    refused(reason: "bad_token" | "version"): void;
};

type Socket = { socket: WebSocket; connectionId: string | null };

const TICK_MS = 1_000;
/** The server treats a writer silent for 30 s as gone. */
const PING_MS = 10_000;
const SILENCE_MS = 25_000;
const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000];

function cutoutHashes(items: readonly StageItem[]): AssetHash[] {
    return items.flatMap((item) => (item.kind === "cutout" ? [item.asset.hash] : []));
}

export class Relay {
    readonly session = new WriterSession();
    private readonly outbox = new Outbox();
    welcomed = false;
    private current: Socket | null = null;
    private attempt = 0;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private tickTimer: ReturnType<typeof setInterval> | null = null;
    private pumpTimer: ReturnType<typeof setTimeout> | null = null;
    private lastHeard = 0;
    private lastPing = 0;
    private stopped = false;
    private storedAssets = new Set<AssetHash>();

    constructor(
        private readonly backendUrl: string,
        private readonly stageId: string,
        private readonly token: string,
        private readonly participant: Participant,
        private readonly handlers: RelayHandlers,
    ) {}

    get writerEpoch(): number | null {
        return this.current?.connectionId ? this.session.epoch : null;
    }

    start(): void {
        this.stopped = false;
        this.connect();
    }

    stop(): void {
        this.stopped = true;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.drop();
    }

    /** Sends what changed on the board, if this connection is still the writer for `epoch`. */
    commit(epoch: number, desired: DesiredStage): void {
        if (epoch !== this.writerEpoch) return;
        this.outbox.push(this.session.plan(epoch, desired));
        this.pump();
    }

    sendCursors(cursors: Cursor[]): void {
        const epoch = this.writerEpoch;
        if (epoch !== null) this.send({ type: "cursors", epoch, cursors });
    }

    private pump(): void {
        if (this.pumpTimer) return;
        for (let next = this.outbox.take(); next; next = this.outbox.take()) {
            if ("waitMs" in next) {
                this.pumpTimer = setTimeout(() => {
                    this.pumpTimer = null;
                    this.pump();
                }, next.waitMs);
                return;
            }
            this.send(next.message);
        }
    }

    private send(message: ClientMessage): void {
        const socket = this.current?.socket;
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    }

    private connect(): void {
        const socket = new WebSocket(stageSocketUrl(this.backendUrl, this.stageId));
        const entry: Socket = { socket, connectionId: null };
        this.current = entry;
        socket.onopen = () => {
            this.lastHeard = this.lastPing = Date.now();
            this.send({
                type: "hello",
                v: PROTOCOL_VERSION,
                stageId: this.stageId,
                token: this.token,
                role: "driver",
                participant: this.participant,
            });
            this.tickTimer = setInterval(() => this.tick(), TICK_MS);
        };
        socket.onmessage = (event) => {
            if (this.current !== entry) return;
            this.lastHeard = Date.now();
            let message: ServerMessage;
            try {
                message = parseServerMessage(String(event.data));
            } catch (err) {
                console.warn("[paper-stage] dropped a frame from the stage server", err);
                return;
            }
            this.receive(entry, message);
        };
        socket.onclose = (event) => {
            if (this.current !== entry) return;
            this.drop();
            if (event.code === CLOSE.badToken) return this.refuse("bad_token");
            if (event.code === CLOSE.badVersion) return this.refuse("version");
            this.scheduleReconnect();
        };
    }

    private receive(entry: Socket, message: ServerMessage): void {
        switch (message.type) {
            case "welcome": {
                entry.connectionId = message.connectionId;
                this.attempt = 0;
                this.trackSnapshot(message.snapshot);
                const firstWelcome = !this.welcomed;
                this.welcomed = true;
                if (firstWelcome) this.handlers.welcomed();
                this.applyWriter(entry, message.writer);
                for (const walker of message.walkers) this.handlers.walker(walker);
                return;
            }
            case "writer":
                this.applyWriter(entry, message.writer);
                return;
            case "ack": {
                const limited = !message.ok && message.error === "limit";
                if (this.outbox.settle(message.requestId, limited)) {
                    this.session.resync();
                    this.handlers.syncNeeded();
                }
                if (!message.ok && !limited) {
                    if (!this.session.onRejected(message.error)) this.outbox.clear();
                    this.handlers.rejected(message.error, message.message);
                }
                this.pump();
                return;
            }
            case "scene.patch":
                if (message.reset) this.storedAssets.clear();
                for (const hash of cutoutHashes(message.upserts)) this.storedAssets.add(hash);
                return;
            case "walker":
                this.handlers.walker(message.walker);
                return;
            case "walker.left":
                this.handlers.walkerLeft(message.connectionId);
                return;
            case "error":
                console.warn(`[paper-stage] stage server error ${message.code}: ${message.message}`);
                return;
            case "cursors":
            case "pong":
                return;
        }
    }

    private trackSnapshot(snapshot: StageSnapshot): void {
        this.storedAssets = new Set(cutoutHashes(snapshot.items));
    }

    private applyWriter(entry: Socket, writer: Writer): void {
        if (!entry.connectionId) return;
        const epoch = this.session.epoch;
        const becameWriter = this.session.onWriter(writer, entry.connectionId, this.storedAssets);
        if (this.session.epoch !== epoch) this.outbox.clear();
        if (becameWriter) this.handlers.syncNeeded();
    }

    private tick(): void {
        const now = Date.now();
        if (now - this.lastHeard > SILENCE_MS) {
            this.current?.socket.close();
            return;
        }
        if (now - this.lastPing >= PING_MS) {
            this.lastPing = now;
            this.send({ type: "ping", t: now });
        }
        if (this.outbox.retryStale()) this.pump();
    }

    private drop(): void {
        if (this.tickTimer) clearInterval(this.tickTimer);
        if (this.pumpTimer) clearTimeout(this.pumpTimer);
        this.tickTimer = this.pumpTimer = null;
        this.outbox.clear();
        const entry = this.current;
        this.current = null;
        this.session.epoch = null;
        if (entry && entry.socket.readyState <= WebSocket.OPEN) entry.socket.close();
    }

    private refuse(reason: "bad_token" | "version"): void {
        this.stopped = true;
        this.handlers.refused(reason);
    }

    private scheduleReconnect(): void {
        if (this.stopped) return;
        const base = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
        this.attempt++;
        this.retryTimer = setTimeout(() => this.connect(), base * (0.75 + Math.random() * 0.5));
    }
}
