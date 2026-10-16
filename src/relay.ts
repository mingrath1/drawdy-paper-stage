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

const PING_MS = 20_000;
const SILENCE_MS = 50_000;
const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000];

function cutoutHashes(items: readonly StageItem[]): AssetHash[] {
    return items.flatMap((item) => (item.kind === "cutout" ? [item.asset.hash] : []));
}

export class Relay {
    readonly session = new WriterSession();
    welcomed = false;
    private current: Socket | null = null;
    private attempt = 0;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private lastHeard = 0;
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
        for (const message of this.session.plan(epoch, desired)) this.send(message);
    }

    sendCursors(cursors: Cursor[]): void {
        const epoch = this.writerEpoch;
        if (epoch !== null) this.send({ type: "cursors", epoch, cursors });
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
            this.lastHeard = Date.now();
            this.send({
                type: "hello",
                v: PROTOCOL_VERSION,
                stageId: this.stageId,
                token: this.token,
                role: "driver",
                participant: this.participant,
            });
            this.pingTimer = setInterval(() => this.keepAlive(), PING_MS);
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
            case "ack":
                if (!message.ok) {
                    this.handlers.rejected(message.error, message.message);
                    if (this.session.onRejected(message.error)) this.handlers.syncNeeded();
                }
                return;
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
        if (this.session.onWriter(writer, entry.connectionId, this.storedAssets)) this.handlers.syncNeeded();
    }

    private keepAlive(): void {
        if (Date.now() - this.lastHeard > SILENCE_MS) {
            this.current?.socket.close();
            return;
        }
        this.send({ type: "ping", t: Date.now() });
    }

    private drop(): void {
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = null;
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
