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
  type ErrorCode,
  parseClientMessage,
  type Participant,
  type Pose,
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
import { Inbox, MAX_PENDING_FRAMES } from "./inbox.ts";
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
/** The alarm sweep closes a socket that has not said hello by then. */
const HELLO_TIMEOUT_MS = 10_000;
/** Drivers ping every 10 s, so a writer silent this long is asleep or gone and loses its seat. */
const WRITER_TIMEOUT_MS = 30_000;
/** Also bounds the walkers a welcome lists, which keeps a welcome far under MAX_FRAME_CHARACTERS. */
const MAX_SOCKETS_PER_STAGE = 64;
const MAX_SOCKETS_PER_PRESENCE = 8;

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
  | { readonly role: "driver"; readonly participant: Participant; readonly lastSeenAt: number }
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
type Driver = Connection & { readonly member: Extract<Member, { role: "driver" }> };

/** Errors that end the connection, and the close code each uses unless the caller names another. */
const CLOSE_CODES = {
  bad_message: CLOSE.malformed,
  too_large: CLOSE.tooLarge,
  version: CLOSE.badVersion,
  bad_token: CLOSE.badToken,
  uninitialized: CLOSE.uninitialized,
  limit: CLOSE.policy,
} satisfies Partial<Record<ErrorCode, number>>;

type ClosingError = keyof typeof CLOSE_CODES;
type HelloRefusal = { code: ClosingError; message: string; closeCode?: number };

export type AssetRead =
  | { readonly status: "found"; readonly png: Uint8Array }
  | { readonly status: "forbidden" }
  | { readonly status: "missing" };

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

const isLiveDriver =
  (now: number) =>
  (connection: Joined): connection is Driver =>
    connection.member.role === "driver" && now - connection.member.lastSeenAt < WRITER_TIMEOUT_MS;

export class Stage extends DurableObject<Env> {
  #harness!: Harness;
  /** In-memory copies of the documents. Only `#stageOperations` changes them, right after each commit. */
  #scene!: SceneState;
  #control!: ControlState;
  #receipts!: ReceiptsState;
  readonly #connections = new WeakMap<WebSocket, Connection>();
  readonly #inboxes = new WeakMap<WebSocket, Inbox>();
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
    if (this.#openSockets().length >= MAX_SOCKETS_PER_STAGE) {
      server.accept();
      server.close(CLOSE.full, "the stage is full");
      return new Response(null, { status: 101, webSocket: client });
    }
    this.ctx.acceptWebSocket(server);
    const connectedAt = Date.now();
    this.#setConnection(server, {
      connectionId: crypto.randomUUID(),
      stageId: request.headers.get(STAGE_ID_HEADER) ?? "",
      connectedAt,
      member: null,
    });
    await this.#alarmBy(connectedAt + HELLO_TIMEOUT_MS);
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
    await this.#sweep();
    await this.#refreshAlarm();
  }

  /** Closes sockets that never said hello and re-runs the election, so a silent writer loses its seat. */
  async #sweep(): Promise<void> {
    const now = Date.now();
    const late = this.#openSockets().filter((socket) => {
      const { member, connectedAt } = this.#connection(socket);
      return member === null && now - connectedAt >= HELLO_TIMEOUT_MS;
    });
    // Each check waits behind the socket's own frames, so a hello that already arrived still gets its answer.
    await Promise.all(
      late.map((socket) =>
        this.#socketOperations.run(socket, async () => {
          if (this.#departed.has(socket) || this.#connection(socket).member !== null) return;
          await this.#disconnect(socket, "bad_message", "no hello within 10 s", CLOSE.policy);
        }),
      ),
    );
    await this.#stageOperations.run("stage", () => this.#electWriter());
  }

  override async webSocketMessage(socket: WebSocket, frame: string | ArrayBuffer): Promise<void> {
    try {
      await this.#arrive(socket, frame);
    } catch (error) {
      reportError("Stage message failed", error);
      try {
        socket.close(1011, "internal error");
        await this.#depart(socket);
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

  /**
   * Parses a frame and spends its budget as it arrives, then queues it behind the socket's earlier frames. A writer
   * request past the budget still gets an ack, in order, so the driver knows to retry it.
   */
  async #arrive(socket: WebSocket, frame: string | ArrayBuffer): Promise<void> {
    if (this.#departed.has(socket)) return;
    const now = Date.now();
    const connection = this.#connection(socket);
    if (connection.member?.role === "driver") {
      this.#setConnection(socket, {
        ...connection,
        member: { ...connection.member, lastSeenAt: now },
      });
    }
    if (typeof frame !== "string") {
      return this.#disconnect(socket, "bad_message", "binary frames are not supported");
    }
    let message: ClientMessage;
    try {
      message = parseClientMessage(frame);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      const code = Object.hasOwn(CLOSE_CODES, error.code)
        ? (error.code as ClosingError)
        : "bad_message";
      return this.#disconnect(socket, code, error.message);
    }

    const inbox = this.#inbox(socket);
    if (inbox.full) {
      return this.#disconnect(
        socket,
        "limit",
        `more than ${MAX_PENDING_FRAMES} frames are waiting`,
      );
    }
    const writer = this.#control.writer.connectionId === connection.connectionId;
    const handle = inbox.admit(message.type, writer, now)
      ? () => this.#handle(socket, message)
      : this.#overBudget(socket, inbox, message, now);
    if (handle !== undefined) await inbox.hold(() => this.#socketOperations.run(socket, handle));
  }

  /** How a frame past the budget is answered: poses and cursors drop silently. */
  #overBudget(
    socket: WebSocket,
    inbox: Inbox,
    message: ClientMessage,
    now: number,
  ): (() => void) | undefined {
    switch (message.type) {
      case "pose":
      case "cursors":
        return undefined;
      case "scene.commit":
      case "asset.put": {
        const { requestId } = message;
        return () =>
          this.#send(socket, {
            type: "ack",
            requestId,
            ok: false,
            error: "limit",
            message: "over the message budget; retry with backoff",
          });
      }
      case "hello":
      case "ping":
        if (!inbox.warn(now)) return undefined;
        return () =>
          this.#send(socket, {
            type: "error",
            code: "limit",
            message: "over the message budget; dropping",
          });
    }
  }

  async #handle(socket: WebSocket, message: ClientMessage): Promise<void> {
    if (this.#departed.has(socket)) return;
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
    if (joined.member.role === "driver" && this.#control.writer.connectionId === null) {
      // The seat empties when every driver went silent, so the first one heard from again takes it.
      await this.#stageOperations.run("stage", () => this.#electWriter());
    }

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
    const refusal = await this.#stageOperations.run("stage", () =>
      this.#join(socket, hello, tokenHash),
    );
    console.log(`${log} ${refusal?.code ?? "ok"}`);
    if (refusal !== undefined) {
      return this.#disconnect(socket, refusal.code, refusal.message, refusal.closeCode);
    }
  }

  /** The token check, the per-person cap, joining, the welcome, and the election, with no stage change between them. */
  async #join(
    socket: WebSocket,
    hello: Extract<ClientMessage, { type: "hello" }>,
    tokenHash: string,
  ): Promise<HelloRefusal | undefined> {
    if (socket.readyState !== WebSocket.READY_STATE_OPEN || this.#departed.has(socket)) return;
    const verdict = await this.#admitToken(hello.role, tokenHash);
    if (verdict === "uninitialized") {
      return { code: verdict, message: "no driver has opened this stage yet; retry" };
    }
    if (verdict === "bad_token") {
      return { code: verdict, message: "the token does not match this stage" };
    }
    const { presenceId } = hello.participant;
    const sockets = this.#members().filter(
      ([, { member }]) => member.participant.presenceId === presenceId,
    );
    if (sockets.length >= MAX_SOCKETS_PER_PRESENCE) {
      return {
        code: "limit",
        message: `one person holds at most ${MAX_SOCKETS_PER_PRESENCE} sockets on a stage`,
        closeCode: CLOSE.full,
      };
    }

    const member: Member =
      hello.role === "driver"
        ? { role: "driver", participant: hello.participant, lastSeenAt: Date.now() }
        : { role: "view", participant: hello.participant, pose: null };
    const connection = this.#connection(socket);
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
    if (member.role === "driver") await this.#electWriter();
    return undefined;
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

  /**
   * Keeps the writer while it is joined and heard from in the last WRITER_TIMEOUT_MS, else hands the role to the
   * longest-connected driver that is, or to nobody. Runs only inside a stage operation.
   */
  async #electWriter(): Promise<void> {
    const current = this.#control.writer;
    const drivers = this.#members()
      .map(([, connection]) => connection)
      .filter(isLiveDriver(Date.now()));
    if (drivers.some((driver) => driver.connectionId === current.connectionId)) return;
    const next = drivers.sort(byJoinOrder)[0];
    if (next === undefined && current.connectionId === null) return;

    const writer: Writer = { connectionId: next?.connectionId ?? null, epoch: current.epoch + 1 };
    await this.#updateControl((control) => {
      control.writer = writer;
    });
    this.#broadcast({ type: "writer", writer });
    if (next !== undefined) await this.#alarmBy(next.member.lastSeenAt + WRITER_TIMEOUT_MS);
  }

  async #commit(
    socket: WebSocket,
    connection: Joined,
    commit: Extract<ClientMessage, { type: "scene.commit" }>,
  ): Promise<void> {
    const { requestId, epoch } = commit;
    const writerRefusal = this.#writerRefusal(connection, epoch);
    if (writerRefusal !== undefined) {
      this.#send(socket, { type: "ack", requestId, ...writerRefusal });
      return this.#electWriter();
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
      this.#send(socket, { type: "ack", requestId, ...writerRefusal });
      return this.#electWriter();
    }
    const stored = Object.hasOwn(this.#control.assets, hash)
      ? this.#control.assets[hash]
      : undefined;
    if (stored !== undefined) {
      // A repeat upload comes right before a commit that uses the asset, so it moves to the newest place.
      await this.#updateControl((control) => {
        delete control.assets[hash];
        control.assets[hash] = { ...stored, storedAt: Date.now() };
      });
      return this.#send(socket, accepted);
    }
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
    code: ClosingError,
    message: string,
    closeCode: number = CLOSE_CODES[code],
  ): Promise<void> {
    this.#send(socket, { type: "error", code, message });
    try {
      socket.close(closeCode, code);
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

  #inbox(socket: WebSocket): Inbox {
    let inbox = this.#inboxes.get(socket);
    if (inbox === undefined) {
      inbox = new Inbox();
      this.#inboxes.set(socket, inbox);
    }
    return inbox;
  }

  #openSockets(): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter(
        (socket) => socket.readyState === WebSocket.READY_STATE_OPEN && !this.#departed.has(socket),
      );
  }

  /** Open sockets whose hello was accepted. */
  #members(): Array<[WebSocket, Joined]> {
    const members: Array<[WebSocket, Joined]> = [];
    for (const socket of this.#openSockets()) {
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
      const due = [
        ...(resumable.length === 0 ? [] : [Date.now() + RECOVERY_ALARM_DELAY_MS]),
        ...this.#sweepDeadlines(),
      ];
      await this.#replaceAlarm(due.length === 0 ? undefined : Math.min(...due));
      // waitForTask starts the scheduler, so persist its recovery alarm first.
      for (const taskId of resumable) this.#refreshAlarmWhenTaskSettles(taskId);
    });
  }

  /** When the sweep has work: a hello deadline, or the moment the writer's silence would cost it the seat. */
  #sweepDeadlines(): number[] {
    const writer = this.#control.writer.connectionId;
    return this.#openSockets().flatMap((socket) => {
      const { connectionId, connectedAt, member } = this.#connection(socket);
      if (member === null) return [connectedAt + HELLO_TIMEOUT_MS];
      if (member.role === "driver" && connectionId === writer) {
        return [member.lastSeenAt + WRITER_TIMEOUT_MS];
      }
      return [];
    });
  }

  /** Moves the alarm earlier when `deadline` comes before it. */
  #alarmBy(deadline: number): Promise<void> {
    return this.#serializeAlarmUpdate(async () => {
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > deadline) await this.ctx.storage.setAlarm(deadline);
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
