import {
    CLOSE,
    PROTOCOL_VERSION,
    stageSocketUrl,
    type ClientMessage,
    type ServerMessage,
    type ViewBoot,
} from "../shared/protocol";

export type LinkStatus =
    | { kind: "connecting" }
    | { kind: "live" }
    | { kind: "retrying"; note: string; at: number }
    | { kind: "stopped"; note: string };

/** Close codes that mean retrying cannot help, and what to tell the person. Every other close retries. */
const FINAL_CLOSES: Record<number, string> = {
    [CLOSE.badToken]: "This stage link is no longer valid. Reopen Paper Stage from the board.",
    [CLOSE.badVersion]: "Paper Stage was updated. Reopen it from the board.",
};

const RETRY_NOTES: Record<number, string> = {
    [CLOSE.uninitialized]: "Waiting for the board",
};

export type CloseOutcome = { retry: false; note: string } | { retry: true; note: string };

export function closeOutcome(code: number): CloseOutcome {
    const final = FINAL_CLOSES[code];
    return final ? { retry: false, note: final } : { retry: true, note: RETRY_NOTES[code] ?? "Reconnecting" };
}

export function retryDelayMs(attempt: number): number {
    return Math.min(8_000, 400 * 2 ** attempt);
}

const SERVER_TYPES: ReadonlySet<string> = new Set<ServerMessage["type"]>([
    "welcome",
    "writer",
    "ack",
    "scene.patch",
    "walker",
    "walker.left",
    "cursors",
    "pong",
    "error",
]);

/**
 * The view's side of the trust boundary. It checks only the envelope. Field shapes are the Stage object's contract,
 * and the view drops a frame whose handler throws.
 */
export function decodeServerFrame(raw: unknown): ServerMessage | null {
    if (typeof raw !== "string") return null;
    let message: unknown;
    try {
        message = JSON.parse(raw);
    } catch {
        return null;
    }
    if (typeof message !== "object" || message === null) return null;
    const type = (message as { type?: unknown }).type;
    return typeof type === "string" && SERVER_TYPES.has(type) ? (message as ServerMessage) : null;
}

const PING_EVERY_MS = 10_000;
const SILENCE_LIMIT_MS = 25_000;

/** One view's socket to its Stage object. It says hello on every open and reconnects until told to stop. */
export class StageLink {
    private socket: WebSocket | null = null;
    private attempt = 0;
    private lastHeard = 0;
    private retryTimer: ReturnType<typeof setTimeout> | undefined;
    private status: LinkStatus = { kind: "connecting" };

    constructor(
        private readonly boot: ViewBoot,
        private readonly onMessage: (message: ServerMessage) => void,
        private readonly onStatus: (status: LinkStatus) => void,
    ) {
        setInterval(() => this.heartbeat(), PING_EVERY_MS);
        this.open();
    }

    get live(): boolean {
        return this.status.kind === "live";
    }

    send(message: ClientMessage): void {
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
    }

    private open(): void {
        this.setStatus({ kind: "connecting" });
        const socket = new WebSocket(stageSocketUrl(this.boot.backendUrl, this.boot.stageId));
        this.socket = socket;
        this.lastHeard = Date.now();
        socket.onopen = () => {
            if (socket !== this.socket) return;
            this.lastHeard = Date.now();
            this.send({
                type: "hello",
                v: PROTOCOL_VERSION,
                stageId: this.boot.stageId,
                token: this.boot.token,
                role: "view",
                participant: this.boot.participant,
            });
        };
        socket.onmessage = (event) => {
            if (socket !== this.socket) return;
            this.lastHeard = Date.now();
            const message = decodeServerFrame(event.data);
            if (!message) return;
            if (message.type === "welcome") {
                this.attempt = 0;
                this.setStatus({ kind: "live" });
            }
            try {
                this.onMessage(message);
            } catch (error) {
                console.warn("paper-stage: dropped a frame", message.type, error);
            }
        };
        socket.onclose = (event) => this.closed(socket, event.code);
    }

    private closed(socket: WebSocket, code: number): void {
        if (socket !== this.socket) return;
        this.socket = null;
        const outcome = closeOutcome(code);
        if (!outcome.retry) {
            this.setStatus({ kind: "stopped", note: outcome.note });
            return;
        }
        const delay = retryDelayMs(this.attempt++) * (0.8 + Math.random() * 0.4);
        this.setStatus({ kind: "retrying", note: outcome.note, at: Date.now() + delay });
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.open(), delay);
    }

    /**
     * A socket can die without a close event, and a handshake can hang, for example when the laptop changes networks.
     * Either way the link hears nothing for SILENCE_LIMIT_MS and starts over.
     */
    private heartbeat(): void {
        const socket = this.socket;
        if (!socket) return;
        if (Date.now() - this.lastHeard > SILENCE_LIMIT_MS) {
            socket.close();
            this.closed(socket, 1006);
            return;
        }
        this.send({ type: "ping", t: Date.now() });
    }

    private setStatus(status: LinkStatus): void {
        this.status = status;
        this.onStatus(status);
    }
}
