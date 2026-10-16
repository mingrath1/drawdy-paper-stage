import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineDoc, Harness, type TaskId } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import {
  type AssetHash,
  CLOSE,
  type ClientMessage,
  type ConnectionId,
  CURSOR_HZ,
  type ErrorCode,
  parseClientMessage,
  type Participant,
  type Pose,
  POSE_HZ,
  PROTOCOL_VERSION,
  ProtocolError,
  type ServerMessage,
  type Walker,
  type Writer,
} from "../../shared/protocol.ts";
import {
  AssetBytes,
  type AssetEntry,
  decodeBase64,
  evictionsFor,
  sha256Hex,
  verifyUpload,
} from "./assets.ts";
import {
  applyPatch,
  checkpointEvery32,
  type CommitReceipt,
  commitPayload,
  CommitReceipts,
  findReceipt,
  planCommit,
  type ReceiptsState,
  referencedAssets,
  type Refusal,
  remember,
  SceneDoc,
  type SceneState,
  sceneSnapshot,
} from "./scene.ts";
import { KeyedSerialQueue } from "./serial.ts";

/** The Worker passes the stage ID from the URL so the object can check it against each hello. */
export const STAGE_ID_HEADER = "x-paper-stage-id";

const RECOVERY_ALARM_DELAY_MS = 60_000;
const MESSAGES_PER_SECOND = 60;
/** Lets a few poses that the network delivers together through without raising the sustained rate. */
const EPHEMERAL_BURST = 5;

const reportError = (
  message: string,
  error: unknown,
  details: Readonly<Record<string, unknown>> = {},
): void => {
  console.error(
    JSON.stringify({
      message,
      ...details,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
};

type ControlState = {
  /** SHA-256 of the token the first driver presented. Every later hello must match it. */
  tokenHash: string | null;
  writer: Writer;
  assets: Record<AssetHash, AssetEntry>;
};

const ControlDoc = defineDoc<ControlState>({
  kind: "app.stage-control",
  version: 1,
  scope: "session",
  initial: () => ({ tokenHash: null, writer: { connectionId: null, epoch: 0 }, assets: {} }),
  checkpointWhen: checkpointEvery32,
});

type Member =
  | { readonly role: "driver"; readonly participant: Participant }
  | { readonly role: "view"; readonly participant: Participant; readonly pose: Pose | null };

/** Kept in the WebSocket attachment, so it survives hibernation. */
type Connection = {
  readonly connectionId: ConnectionId;
  readonly stageId: string;
  readonly connectedAt: number;
  /** Null until the socket's hello is accepted. */
  readonly member: Member | null;
};

type Joined = Connection & { readonly member: Member };

/** Errors that end the connection, and the close code each uses. */
const CLOSE_CODES = {
  bad_message: CLOSE.malformed,
  too_large: CLOSE.tooLarge,
  version: CLOSE.badVersion,
  bad_token: CLOSE.badToken,
  uninitialized: CLOSE.uninitialized,
} satisfies Partial<Record<ErrorCode, number>>;

export type AssetRead =
  | { readonly status: "found"; readonly png: Uint8Array }
  | { readonly status: "forbidden" }
  | { readonly status: "missing" };

class TokenBucket {
  readonly #perMs: number;
  readonly #burst: number;
  #tokens: number;
  #at = 0;

  constructor(perSecond: number, burst: number) {
    this.#perMs = perSecond / 1000;
    this.#burst = burst;
    this.#tokens = burst;
  }

  take(now: number): boolean {
    this.#tokens = Math.min(this.#burst, this.#tokens + (now - this.#at) * this.#perMs);
    this.#at = now;
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}

/** In memory only: hibernation means the socket was idle, so a fresh budget is correct after a wake. */
type Budget = {
  readonly messages: TokenBucket;
  readonly poses: TokenBucket;
  readonly cursors: TokenBucket;
  lastWarning: number;
};

const isReservedCloseCode = (code: number): boolean =>
  code === 1005 || code === 1006 || code === 1015;

const reciprocateClose = (socket: WebSocket, code: number, reason: string): void => {
  if (isReservedCloseCode(code)) return;
  try {
    socket.close(code, reason);
  } catch {
    // The socket is already closed or the peer is no longer reachable.
  }
};

const byJoinOrder = (left: Connection, right: Connection): number =>
  left.connectedAt - right.connectedAt || left.connectionId.localeCompare(right.connectionId);

export class Stage extends DurableObject<Env> {
  #harness!: Harness;
  /** In-memory copies of the documents. Only `#stageOperations` changes them, right after each commit. */
  #scene!: SceneState;
  #control!: ControlState;
  #receipts!: ReceiptsState;
  readonly #connections = new WeakMap<WebSocket, Connection>();
  readonly #budgets = new WeakMap<WebSocket, Budget>();
  readonly #departed = new WeakSet<WebSocket>();
  readonly #socketOperations = new KeyedSerialQueue<WebSocket>();
  /** Token claims, writer elections, commits, and uploads run one at a time, so each sees the last one's result. */
  readonly #stageOperations = new KeyedSerialQueue<"stage">();
  readonly #alarmTaskWatches = new Set<TaskId>();
  #alarmUpdate: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(() => this.#initialize());
  }

  async #initialize(): Promise<void> {
    const storage = await openDurableObjectSqliteStorage(this.ctx.storage);
    const harness = await Harness.open(
      storage,
      {
        models: createModels(),
        registry: createRegistry(),
        // Retention timers are active Durable Object references and prevent hibernation.
        settings: { documentRetentionMs: 0 },
        onReport: (error) => reportError("Harness background task failed", error),
      },
      BACKGROUND_CONTEXT,
    );

    // A storage error closes the harness. Reset the object so the next event reopens it.
    void harness.closed.then((end) => {
      if (end.reason === "failed") this.ctx.abort("Harness failed");
    });

    try {
      this.#harness = harness;
      this.#scene = structuredClone(
        (await harness.snapshot(SceneDoc, BACKGROUND_CONTEXT)) ?? SceneDoc.definition.initial(),
      );
      this.#control = structuredClone(
        (await harness.snapshot(ControlDoc, BACKGROUND_CONTEXT)) ?? ControlDoc.definition.initial(),
      );
      this.#receipts = structuredClone(
        (await harness.snapshot(CommitReceipts, BACKGROUND_CONTEXT)) ??
          CommitReceipts.definition.initial(),
      );
      // A deploy drops every socket, so the stored writer may be gone.
      await this.#electWriter();
      await this.#refreshAlarm();
    } catch (error) {
      await harness.close(BACKGROUND_CONTEXT);
      throw error;
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    this.#setConnection(server, {
      connectionId: crypto.randomUUID(),
      stageId: request.headers.get(STAGE_ID_HEADER) ?? "",
      connectedAt: Date.now(),
      member: null,
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  async readAsset(token: string, hash: AssetHash): Promise<AssetRead> {
    const tokenHash = this.#control.tokenHash;
    if (tokenHash === null || tokenHash !== (await sha256Hex(token))) {
      return { status: "forbidden" };
    }
    const asset = await this.#harness.snapshot(AssetBytes, hash, BACKGROUND_CONTEXT);
    return asset === undefined
      ? { status: "missing" }
      : { status: "found", png: decodeBase64(asset.pngBase64) };
  }

  override async alarm(): Promise<void> {
    await this.#refreshAlarm();
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      await this.#socketOperations.run(socket, () => this.#receive(socket, message));
    } catch (error) {
      reportError("Stage message failed", error);
      try {
        socket.close(1011, "internal error");
        await this.#socketOperations.run(socket, () => this.#depart(socket));
      } catch (closeError) {
        reportError("Stage message failure cleanup failed", closeError);
      }
    }
  }

  override async webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    try {
      await this.#socketOperations.run(socket, () => this.#depart(socket));
    } catch (error) {
      reportError("Stage WebSocket close failed", error);
    } finally {
      reciprocateClose(socket, code, reason);
    }
  }

  override async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
    reportError("Stage WebSocket failed", error);
    try {
      await this.#socketOperations.run(socket, () => this.#depart(socket));
    } catch (departError) {
      reportError("Stage WebSocket error cleanup failed", departError);
    }
  }

  async #receive(socket: WebSocket, frame: string | ArrayBuffer): Promise<void> {
    if (this.#departed.has(socket) || !this.#admit(socket)) return;
    if (typeof frame !== "string") {
      return this.#disconnect(socket, "bad_message", "binary frames are not supported");
    }
    let message: ClientMessage;
    try {
      message = parseClientMessage(frame);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      const code = Object.hasOwn(CLOSE_CODES, error.code)
        ? (error.code as keyof typeof CLOSE_CODES)
        : "bad_message";
      return this.#disconnect(socket, code, error.message);
    }

    const connection = this.#connection(socket);
    if (message.type === "hello") {
      if (connection.member !== null) {
        return this.#disconnect(socket, "bad_message", "hello was already accepted");
      }
      return this.#hello(socket, connection, message);
    }
    if (connection.member === null) {
      return this.#disconnect(socket, "bad_message", "send hello first");
    }
    const joined = connection as Joined;

    switch (message.type) {
      case "scene.commit":
        return this.#stageOperations.run("stage", () => this.#commit(socket, joined, message));
      case "asset.put":
        return this.#stageOperations.run("stage", () => this.#putAsset(socket, joined, message));
      case "pose":
        return this.#pose(socket, joined, message.pose);
      case "cursors":
        return this.#relayCursors(socket, joined, message);
      case "ping":
        return this.#send(socket, { type: "pong", t: message.t });
    }
  }

  /** Spends one message from the socket's budget. Dropped frames get at most one `limit` error per second. */
  #admit(socket: WebSocket): boolean {
    let budget = this.#budgets.get(socket);
    if (budget === undefined) {
      budget = {
        messages: new TokenBucket(MESSAGES_PER_SECOND, MESSAGES_PER_SECOND),
        poses: new TokenBucket(POSE_HZ, EPHEMERAL_BURST),
        cursors: new TokenBucket(CURSOR_HZ, EPHEMERAL_BURST),
        lastWarning: -Infinity,
      };
      this.#budgets.set(socket, budget);
    }
    const now = Date.now();
    if (budget.messages.take(now)) return true;
    if (now - budget.lastWarning >= 1_000) {
      budget.lastWarning = now;
      this.#send(socket, {
        type: "error",
        code: "limit",
        message: `more than ${MESSAGES_PER_SECOND} messages per second; dropping`,
      });
    }
    return false;
  }

  async #hello(
    socket: WebSocket,
    connection: Connection,
    hello: Extract<ClientMessage, { type: "hello" }>,
  ): Promise<void> {
    const log = `stage ${connection.stageId} hello ${hello.role}`;
    if (hello.stageId !== connection.stageId) {
      console.log(`${log} bad_message`);
      return this.#disconnect(socket, "bad_message", "hello.stageId does not match the URL");
    }
    const tokenHash = await sha256Hex(hello.token);
    const verdict = await this.#stageOperations.run("stage", () =>
      this.#admitToken(hello.role, tokenHash),
    );
    if (verdict !== "ok") {
      console.log(`${log} ${verdict}`);
      const message =
        verdict === "uninitialized"
          ? "no driver has opened this stage yet; retry"
          : "the token does not match this stage";
      return this.#disconnect(socket, verdict, message);
    }
    if (socket.readyState !== WebSocket.READY_STATE_OPEN) return;

    const member: Member =
      hello.role === "driver"
        ? { role: "driver", participant: hello.participant }
        : { role: "view", participant: hello.participant, pose: null };
    this.#setConnection(socket, { ...connection, member });
    // Joining and the welcome happen in one synchronous step, so every later patch reaches this socket after it.
    this.#send(socket, {
      type: "welcome",
      v: PROTOCOL_VERSION,
      connectionId: connection.connectionId,
      writer: this.#control.writer,
      snapshot: sceneSnapshot(this.#scene),
      walkers: this.#walkers(socket),
    });
    console.log(`${log} ok`);
    if (member.role === "driver") {
      await this.#stageOperations.run("stage", () => this.#electWriter());
    }
  }

  async #admitToken(
    role: Member["role"],
    tokenHash: string,
  ): Promise<"ok" | "bad_token" | "uninitialized"> {
    const stored = this.#control.tokenHash;
    if (stored !== null) return stored === tokenHash ? "ok" : "bad_token";
    if (role === "view") return "uninitialized";
    await this.#updateControl((control) => {
      control.tokenHash = tokenHash;
    });
    return "ok";
  }

  /** Keeps the writer while its socket is joined, else hands the role to the longest-connected driver. */
  async #electWriter(): Promise<void> {
    const current = this.#control.writer;
    const drivers = this.#members()
      .map(([, connection]) => connection)
      .filter((connection) => connection.member.role === "driver");
    if (drivers.some((driver) => driver.connectionId === current.connectionId)) return;
    const next = drivers.sort(byJoinOrder)[0]?.connectionId ?? null;
    if (next === null && current.connectionId === null) return;

    const writer: Writer = { connectionId: next, epoch: current.epoch + 1 };
    await this.#updateControl((control) => {
      control.writer = writer;
    });
    this.#broadcast({ type: "writer", writer });
  }

  async #commit(
    socket: WebSocket,
    connection: Joined,
    commit: Extract<ClientMessage, { type: "scene.commit" }>,
  ): Promise<void> {
    const { requestId, epoch } = commit;
    const writerRefusal = this.#writerRefusal(connection, epoch);
    if (writerRefusal !== undefined) {
      return this.#send(socket, { type: "ack", requestId, ...writerRefusal });
    }
    const digest = await sha256Hex(commitPayload(commit));
    const receipt = findReceipt(this.#receipts, epoch, requestId);
    if (receipt !== undefined) {
      return this.#send(
        socket,
        receipt.digest === digest
          ? { type: "ack", requestId, ok: true, revision: receipt.revision }
          : {
              type: "ack",
              requestId,
              ok: false,
              error: "bad_message",
              message: "this requestId already named a different commit",
            },
      );
    }
    const plan = planCommit(this.#scene, this.#control.assets, commit);
    if (!plan.ok) return this.#send(socket, { type: "ack", requestId, ...plan });

    const { patch } = plan;
    const accepted: CommitReceipt = {
      epoch,
      requestId,
      digest,
      revision: patch?.revision ?? this.#scene.revision,
    };
    await this.#harness.commit(async (tx) => {
      if (patch !== undefined) applyPatch(await tx.doc(SceneDoc), patch);
      remember(await tx.doc(CommitReceipts), accepted);
    }, BACKGROUND_CONTEXT);
    if (patch !== undefined) applyPatch(this.#scene, patch);
    remember(this.#receipts, accepted);
    this.#send(socket, { type: "ack", requestId, ok: true, revision: accepted.revision });
    if (patch !== undefined) this.#broadcast({ type: "scene.patch", ...patch }, () => true, socket);
  }

  async #putAsset(
    socket: WebSocket,
    connection: Joined,
    put: Extract<ClientMessage, { type: "asset.put" }>,
  ): Promise<void> {
    const { requestId, hash } = put;
    const accepted = { type: "ack", requestId, ok: true, revision: this.#scene.revision } as const;
    const writerRefusal = this.#writerRefusal(connection, put.epoch);
    if (writerRefusal !== undefined) {
      return this.#send(socket, { type: "ack", requestId, ...writerRefusal });
    }
    if (Object.hasOwn(this.#control.assets, hash)) return this.#send(socket, accepted);
    const invalid = await verifyUpload(put);
    if (invalid !== undefined) return this.#send(socket, { type: "ack", requestId, ...invalid });
    const evictions = evictionsFor(this.#control.assets, referencedAssets(this.#scene));

    const entry: AssetEntry = { width: put.width, height: put.height, storedAt: Date.now() };
    const update = (control: ControlState) => {
      for (const evicted of evictions) delete control.assets[evicted];
      control.assets[hash] = entry;
    };
    await this.#harness.commit(async (tx) => {
      for (const evicted of evictions) await tx.retireDoc(AssetBytes, evicted);
      await tx.doc(AssetBytes, hash, put.pngBase64);
      update(await tx.doc(ControlDoc));
    }, BACKGROUND_CONTEXT);
    update(this.#control);
    this.#send(socket, accepted);
  }

  #writerRefusal(connection: Joined, epoch: number): Refusal | undefined {
    const writer = this.#control.writer;
    if (writer.connectionId !== connection.connectionId) {
      return {
        ok: false,
        error: "not_writer",
        message: "only the elected writer changes the stage",
      };
    }
    if (writer.epoch !== epoch) {
      return { ok: false, error: "stale_epoch", message: `the writer epoch is ${writer.epoch}` };
    }
    return undefined;
  }

  #pose(socket: WebSocket, connection: Joined, pose: Pose): void {
    const { member } = connection;
    if (member.role !== "view") {
      return this.#send(socket, {
        type: "error",
        code: "bad_message",
        message: "only views send poses",
      });
    }
    if (!this.#budgets.get(socket)!.poses.take(Date.now())) return;
    this.#setConnection(socket, { ...connection, member: { ...member, pose } });
    this.#broadcast(
      {
        type: "walker",
        walker: { connectionId: connection.connectionId, participant: member.participant, pose },
      },
      () => true,
      socket,
    );
  }

  #relayCursors(
    socket: WebSocket,
    connection: Joined,
    message: Extract<ClientMessage, { type: "cursors" }>,
  ): void {
    if (this.#writerRefusal(connection, message.epoch) !== undefined) {
      return this.#send(socket, {
        type: "error",
        code: "not_writer",
        message: "only the elected writer relays cursors",
      });
    }
    if (!this.#budgets.get(socket)!.cursors.take(Date.now())) return;
    this.#broadcast(
      { type: "cursors", cursors: message.cursors },
      (member) => member.role === "view",
    );
  }

  #walkers(except: WebSocket): Walker[] {
    const walkers: Walker[] = [];
    for (const [socket, { connectionId, member }] of this.#members()) {
      if (socket === except || member.role !== "view" || member.pose === null) continue;
      walkers.push({ connectionId, participant: member.participant, pose: member.pose });
    }
    return walkers;
  }

  /** Runs once per socket, after its close, its error, or a disconnect the Stage started. */
  async #depart(socket: WebSocket): Promise<void> {
    if (this.#departed.has(socket)) return;
    this.#departed.add(socket);
    const { connectionId, member } = this.#connection(socket);
    if (member?.role === "view") this.#broadcast({ type: "walker.left", connectionId });
    if (member?.role === "driver") {
      await this.#stageOperations.run("stage", () => this.#electWriter());
    }
  }

  async #disconnect(
    socket: WebSocket,
    code: keyof typeof CLOSE_CODES,
    message: string,
  ): Promise<void> {
    this.#send(socket, { type: "error", code, message });
    try {
      socket.close(CLOSE_CODES[code], code);
    } catch {
      // The peer may have closed first.
    }
    await this.#depart(socket);
  }

  async #updateControl(update: (control: ControlState) => void): Promise<void> {
    await this.#harness.commit(async (tx) => update(await tx.doc(ControlDoc)), BACKGROUND_CONTEXT);
    update(this.#control);
  }

  #connection(socket: WebSocket): Connection {
    let connection = this.#connections.get(socket);
    if (connection === undefined) {
      connection = socket.deserializeAttachment() as Connection;
      this.#connections.set(socket, connection);
    }
    return connection;
  }

  #setConnection(socket: WebSocket, connection: Connection): void {
    socket.serializeAttachment(connection);
    this.#connections.set(socket, connection);
  }

  /** Open sockets whose hello was accepted. */
  #members(): Array<[WebSocket, Joined]> {
    const members: Array<[WebSocket, Joined]> = [];
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.READY_STATE_OPEN || this.#departed.has(socket)) continue;
      const connection = this.#connection(socket);
      if (connection.member !== null) members.push([socket, connection as Joined]);
    }
    return members;
  }

  #broadcast(
    message: ServerMessage,
    include: (member: Member) => boolean = () => true,
    except?: WebSocket,
  ): void {
    const frame = JSON.stringify(message);
    for (const [socket, { member }] of this.#members()) {
      if (socket !== except && include(member)) this.#sendFrame(socket, frame);
    }
  }

  #send(socket: WebSocket, message: ServerMessage): void {
    this.#sendFrame(socket, JSON.stringify(message));
  }

  #sendFrame(socket: WebSocket, frame: string): void {
    if (socket.readyState !== WebSocket.READY_STATE_OPEN) return;
    try {
      socket.send(frame);
    } catch {
      try {
        socket.close(1011, "Unexpected send error");
      } catch {
        // The socket may already have closed after the ready-state check.
      }
    }
  }

  #refreshAlarm(): Promise<void> {
    return this.#serializeAlarmUpdate(async () => {
      const { tasks } = await this.#harness.inspect(BACKGROUND_CONTEXT);
      const resumable = tasks
        .filter((task) => task.state.kind !== "blocked")
        .map((task) => task.record.id);
      await this.#replaceAlarm(
        resumable.length === 0 ? undefined : Date.now() + RECOVERY_ALARM_DELAY_MS,
      );
      // waitForTask starts the scheduler, so persist its recovery alarm first.
      for (const taskId of resumable) this.#refreshAlarmWhenTaskSettles(taskId);
    });
  }

  #serializeAlarmUpdate(operation: () => Promise<void>): Promise<void> {
    const update = this.#alarmUpdate.then(operation, operation);
    this.#alarmUpdate = update;
    return update;
  }

  #refreshAlarmWhenTaskSettles(taskId: TaskId): void {
    if (this.#alarmTaskWatches.has(taskId)) return;
    this.#alarmTaskWatches.add(taskId);
    void this.#harness
      .waitForTask(taskId, BACKGROUND_CONTEXT)
      .then(() => this.#refreshAlarm())
      .catch((error: unknown) =>
        reportError("Harness task alarm reconciliation failed", error, { taskId }),
      )
      .finally(() => this.#alarmTaskWatches.delete(taskId));
  }

  #replaceAlarm(timestamp: number | undefined): Promise<void> {
    return this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.getAlarm();
      if (timestamp === undefined) {
        if (current !== null) await transaction.deleteAlarm();
      } else if (current !== timestamp) {
        await transaction.setAlarm(timestamp);
      }
    });
  }
}
