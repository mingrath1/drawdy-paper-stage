import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai";
import {
  configure,
  createRegistry,
  defineExtension,
  defineTask,
  Harness,
  ROOT_CONVERSATION_ID,
  type Storage,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { describe, expect, it } from "vitest";

const context = BACKGROUND_CONTEXT;

const openStorage = (state: DurableObjectState) => openDurableObjectSqliteStorage(state.storage);

async function openFauxHarness(
  storage: Storage,
  responses: readonly FauxResponseStep[],
): Promise<Harness> {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses([...responses]);
  return Harness.open(storage, { models, registry: createRegistry() }, context);
}

async function wake(stageId: string): Promise<void> {
  const response = await exports.default.fetch(`https://example.com/api/stages/${stageId}`, {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  response.webSocket!.accept();
  response.webSocket!.close(1000, "test setup complete");
}

/** A task the Stage has no definition for, so its scheduler reports it as blocked. */
const UnknownTask = defineTask<null, { phase: "wait" }, null>({
  name: "test.unknown-to-stage",
  version: 1,
  initial: () => ({ phase: "wait" }),
  phases: {
    wait: async (_task, runtime, context) => {
      await runtime.sleep(Date.now() + 3_600_000, context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});

describe("stage recovery", () => {
  it("resumes an interrupted in-flight generation after eviction", async () => {
    const firstRequestStarted = Promise.withResolvers<void>();
    const interrupted: FauxResponseStep = async (_request, options) => {
      firstRequestStarted.resolve();
      return new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException("Request interrupted", "AbortError"));
        if (options?.signal?.aborted) abort();
        else options?.signal?.addEventListener("abort", abort, { once: true });
      });
    };

    const stageId = "in-flight-recovery";
    const stub = env.STAGES.getByName(stageId);
    await runInDurableObject(stub, async (_instance, state) => {
      const storage = await openStorage(state);
      const harness = await openFauxHarness(storage, [interrupted]);
      try {
        const root = await harness.root(context, {
          init: (tx, conversationId) =>
            configure(tx, conversationId, {
              model: { provider: "faux", modelId: "faux-1" },
              thinkingLevel: "off",
              tools: [],
            }),
        });
        await root.submit(
          { type: "input", content: "Finish after recovery", requestId: "recovery-turn" },
          context,
        );
        await firstRequestStarted.promise;
      } finally {
        await harness.close(context);
      }
    });
    await evictDurableObject(stub);
    await wake(stageId);

    let status: string | undefined;
    for (let attempt = 0; attempt < 100 && status === undefined; attempt++) {
      status = await runInDurableObject(stub, async (_instance, state) => {
        const submission = await (
          await openStorage(state)
        ).submissionByRequest(ROOT_CONVERSATION_ID, "recovery-turn", context);
        return submission?.status === "placed" ? undefined : submission?.status;
      });
    }

    expect(status).toBe("unanswered");
  });

  it("deletes the platform alarm when no stored task can run", async () => {
    const stageId = "obsolete-platform-alarm";
    const stub = env.STAGES.getByName(stageId);
    await runInDurableObject(stub, async (_instance, state) => {
      const registry = createRegistry();
      registry.install(defineExtension({ name: "test", tasks: [UnknownTask] }));
      const harness = await Harness.open(
        await openStorage(state),
        { models: createModels(), registry },
        context,
      );
      try {
        await harness.root(context, {
          init: (tx, conversationId) =>
            configure(tx, conversationId, { thinkingLevel: "off", tools: [] }),
        });
        await harness.commit(
          (tx) =>
            tx.createTask(UnknownTask, null, {
              ownership: { kind: "conversation" },
              conversationId: ROOT_CONVERSATION_ID,
              background: true,
            }),
          context,
        );
        await state.storage.setAlarm(Date.now());
      } finally {
        await harness.close(context);
      }
    });

    await evictDurableObject(stub);
    await runDurableObjectAlarm(stub);

    expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBe(
      null,
    );
  });
});
