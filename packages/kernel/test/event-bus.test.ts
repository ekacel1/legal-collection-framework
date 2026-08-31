import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { InMemoryEventBus, RingBufferEventJournal } from "../src/events/in-memory-event-bus.js";
import { createEvent, matchesPattern } from "../src/events/event-bus.js";
import { PUBLIC_EVENT_TYPES, isPublicEventType } from "../src/domain/events.js";
import { RecordingLogger, redact, REDACTED, JsonLogger } from "../src/observability/logger.js";
import { ManualClock } from "../src/domain/clock.js";
import { asSourceId, computeDocumentId, newRunId } from "../src/domain/ids.js";
import type { LogRecord } from "../src/observability/logger.js";

const SOURCE = asSourceId("example.gazette");
const RUN = newRunId(1_700_000_000_000);
const DOCUMENT = computeDocumentId(SOURCE, "2024/118");

function storedEvent(at = 1_700_000_000_000): ReturnType<typeof createEvent> {
  return createEvent(
    "lcf.document.stored",
    {
      documentId: DOCUMENT,
      sourceId: SOURCE,
      contentHash: "sha256:abcd" as never,
      version: 1,
      bytes: 1024,
      mimeType: "application/pdf",
      isNewVersion: true,
    },
    { sourceId: SOURCE, runId: RUN, at },
  );
}

describe("enveloppe d'evenement (Vol. III, 11.4)", () => {
  test("l'enveloppe porte version, identifiant, origine et instant", () => {
    const event = storedEvent();
    assert.equal(event.specVersion, "1.0");
    assert.match(event.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(event.source, `lcf://kernel/${SOURCE}`);
    assert.equal(event.time, "2023-11-14T22:13:20.000Z");
    assert.equal(event.runId, RUN);
  });

  test("les identifiants sont uniques et tries par le temps", () => {
    const older = storedEvent(1_700_000_000_000);
    const newer = storedEvent(1_700_000_001_000);
    assert.notEqual(older.id, newer.id);
    assert.ok(older.id < newer.id);
  });

  test("un evenement sans source est attribue au Kernel lui-meme", () => {
    const event = createEvent("lcf.schema.migrated", {
      fromVersion: 0,
      toVersion: 2,
      appliedCount: 2,
    });
    assert.equal(event.source, "lcf://kernel");
    assert.equal(event.runId, undefined);
  });

  test("le contrat public de la version 1 comporte huit evenements", () => {
    assert.equal(PUBLIC_EVENT_TYPES.length, 8);
    assert.equal(isPublicEventType("lcf.document.stored"), true);
    assert.equal(isPublicEventType("lcf.document.unchanged"), false);
  });
});

describe("routage (Vol. II, 4.1)", () => {
  test("un abonne recoit les evenements de son type", async () => {
    const bus = new InMemoryEventBus();
    const received: string[] = [];
    bus.subscribe("lcf.document.stored", (event) => {
      received.push(event.type);
    });

    await bus.publish(storedEvent());
    await bus.publish(
      createEvent("lcf.run.started", {
        runId: RUN,
        sourceId: SOURCE,
        mode: "full",
        trigger: "manual",
      }),
    );

    assert.deepEqual(received, ["lcf.document.stored"]);
  });

  test("les motifs prefixes et l'abonnement universel fonctionnent", () => {
    assert.equal(matchesPattern("*", "lcf.document.stored"), true);
    assert.equal(matchesPattern("lcf.document.*", "lcf.document.stored"), true);
    assert.equal(matchesPattern("lcf.document.*", "lcf.run.started"), false);
    assert.equal(matchesPattern("lcf.document.stored", "lcf.document.stored"), true);
  });

  test("les abonnes sont appeles dans leur ordre d'inscription", async () => {
    const bus = new InMemoryEventBus();
    const order: number[] = [];
    bus.subscribe("*", () => {
      order.push(1);
    });
    bus.subscribe("*", async () => {
      await Promise.resolve();
      order.push(2);
    });
    bus.subscribe("*", () => {
      order.push(3);
    });

    await bus.publish(storedEvent());
    assert.deepEqual(order, [1, 2, 3]);
  });

  test("le desabonnement prend effet immediatement", async () => {
    const bus = new InMemoryEventBus();
    let calls = 0;
    const subscription = bus.subscribe("*", () => {
      calls++;
    });

    await bus.publish(storedEvent());
    subscription.unsubscribe();
    await bus.publish(storedEvent());

    assert.equal(calls, 1);
    assert.equal(bus.subscriberCount, 0);
  });
});

describe("isolement des abonnes (Vol. II, ch. 11)", () => {
  test("un abonne qui echoue n'interrompt ni la publication ni les autres", async () => {
    const failures: string[] = [];
    const logger = new RecordingLogger();
    const bus = new InMemoryEventBus({
      logger,
      onHandlerError: (failure) => failures.push(failure.subscriptionId),
    });

    let secondCalled = false;
    bus.subscribe("*", () => {
      throw new Error("abonne defaillant");
    });
    bus.subscribe("*", () => {
      secondCalled = true;
    });

    await bus.publish(storedEvent());

    assert.equal(secondCalled, true, "le second abonne doit etre appele malgre le premier");
    assert.equal(failures.length, 1);
    assert.equal(logger.records.some((r) => r.level === "error"), true);
  });

  test("un abonne asynchrone en echec est traite de meme", async () => {
    const bus = new InMemoryEventBus();
    bus.subscribe("*", async () => {
      await Promise.resolve();
      throw new Error("echec differe");
    });
    await bus.publish(storedEvent());
  });
});

describe("journal des evenements (rejeu de E11)", () => {
  test("l'historique est journalise avant diffusion", async () => {
    const journal = new RingBufferEventJournal();
    const bus = new InMemoryEventBus({ journal });

    let seenAtHandlerTime = -1;
    bus.subscribe("*", async () => {
      seenAtHandlerTime = (await journal.list()).length;
    });

    await bus.publish(storedEvent());
    // L'evenement est deja journalise quand l'abonne s'execute : une panne
    // pendant la diffusion laisse l'evenement rejouable.
    assert.equal(seenAtHandlerTime, 1);
  });

  test("l'historique se filtre par type, execution et instant", async () => {
    const bus = new InMemoryEventBus();
    await bus.publish(storedEvent(1_700_000_000_000));
    await bus.publish(
      createEvent(
        "lcf.run.completed",
        {
          runId: RUN,
          sourceId: SOURCE,
          status: "completed",
          docsDiscovered: 1,
          docsNew: 1,
          docsUpdated: 0,
          docsUnchanged: 0,
          docsFailed: 0,
          bytesDownloaded: 1024,
          durationMs: 42,
        },
        { sourceId: SOURCE, runId: RUN, at: 1_700_000_010_000 },
      ),
    );

    assert.equal((await bus.getEventHistory()).length, 2);
    assert.equal((await bus.getEventHistory({ type: "lcf.document.*" })).length, 1);
    assert.equal((await bus.getEventHistory({ runId: RUN })).length, 2);
    assert.equal((await bus.getEventHistory({ sourceId: SOURCE })).length, 2);
    assert.equal(
      (await bus.getEventHistory({ since: "2023-11-14T22:13:20.000Z" })).length,
      1,
    );
  });

  test("le journal est borne et conserve les evenements les plus recents", async () => {
    const journal = new RingBufferEventJournal(3);
    const bus = new InMemoryEventBus({ journal });
    for (let index = 0; index < 10; index++) {
      await bus.publish(storedEvent(1_700_000_000_000 + index * 1000));
    }
    const history = await bus.getEventHistory();
    assert.equal(history.length, 3);
    assert.equal(history[2]?.time, "2023-11-14T22:13:29.000Z");
  });

  test("publishAll conserve l'ordre", async () => {
    const bus = new InMemoryEventBus();
    await bus.publishAll([storedEvent(1_700_000_000_000), storedEvent(1_700_000_001_000)]);
    const history = await bus.getEventHistory();
    assert.equal(history.length, 2);
    assert.ok((history[0] as { id: string }).id < (history[1] as { id: string }).id);
  });
});

describe("journalisation structuree (Vol. II, ch. 10)", () => {
  test("chaque ligne est un objet JSON horodate", () => {
    const written: LogRecord[] = [];
    const logger = new JsonLogger({
      clock: new ManualClock(1_700_000_000_000),
      sink: (record) => written.push(record),
    });

    logger.info("collecte terminee", { sourceId: SOURCE, docs: 12 });

    assert.equal(written.length, 1);
    assert.deepEqual(written[0], {
      time: "2023-11-14T22:13:20.000Z",
      level: "info",
      message: "collecte terminee",
      sourceId: SOURCE,
      docs: 12,
    });
  });

  test("le seuil de niveau filtre les lignes moins importantes", () => {
    const written: LogRecord[] = [];
    const logger = new JsonLogger({ level: "warn", sink: (record) => written.push(record) });
    logger.debug("bruit");
    logger.info("bruit");
    logger.warn("signal");
    logger.error("signal");
    assert.equal(written.length, 2);
  });

  test("un journal derive prefixe ses lignes sans modifier le parent", () => {
    const written: LogRecord[] = [];
    const root = new JsonLogger({ sink: (record) => written.push(record) });
    root.child({ sourceId: SOURCE }).info("dans la source");
    root.info("a la racine");

    assert.equal(written[0]?.["sourceId"], SOURCE);
    assert.equal(written[1]?.["sourceId"], undefined);
  });

  test("les secrets sont masques par le journal, pas par l'appelant", () => {
    const written: LogRecord[] = [];
    const logger = new JsonLogger({ sink: (record) => written.push(record) });
    logger.info("appel API", {
      url: "https://gazette.example/api",
      apiKey: "tres-secret",
      headers: { authorization: "Bearer xyz", accept: "application/json" },
    });

    assert.equal(written[0]?.["apiKey"], REDACTED);
    assert.equal(
      (written[0]?.["headers"] as Record<string, unknown>)["authorization"],
      REDACTED,
    );
    assert.equal((written[0]?.["headers"] as Record<string, unknown>)["accept"], "application/json");
  });

  test("la redaction traverse tableaux et objets imbriques", () => {
    const redacted = redact({ items: [{ token: "abc", name: "ok" }] }) as {
      items: { token: string; name: string }[];
    };
    assert.equal(redacted.items[0]?.token, REDACTED);
    assert.equal(redacted.items[0]?.name, "ok");
  });
});
