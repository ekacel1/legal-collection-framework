import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { asSourceId } from "../src/domain/ids.js";
import { ManualClock } from "../src/domain/clock.js";
import {
  CURRENT_API_VERSION,
  detectCapabilities,
  isDescribable,
  isHealthReporting,
  isIncremental,
  type CheckpointState,
  type DocumentRef,
  type DiscoveryScope,
  type FetchPlan,
  type PluginContext,
  type SourceMetadata,
  type SourcePlugin,
} from "../src/domain/contract.js";

const SOURCE = asSourceId("example.paginated.portal");

/** Plugin minimal : les quatre methodes obligatoires, rien de plus. */
class MinimalPlugin implements SourcePlugin {
  readonly id = SOURCE;
  readonly apiVersion = CURRENT_API_VERSION;
  async init(_ctx: PluginContext): Promise<void> {}
  async *discover(_scope: DiscoveryScope): AsyncIterable<DocumentRef> {
    yield { nativeId: "2024/118" };
  }
  async resolve(_ref: DocumentRef): Promise<FetchPlan> {
    return { kind: "http", url: "https://example.test/a.pdf" };
  }
  async dispose(): Promise<void> {}
}

class RichPlugin extends MinimalPlugin {
  async describe(_ref: DocumentRef): Promise<SourceMetadata> {
    return { raw: {}, provenance: [] };
  }
  async checkpoint(): Promise<CheckpointState> {
    return { version: 1 };
  }
  async restore(_state: CheckpointState): Promise<void> {}
}

describe("detection structurelle des capacites (ADR-302)", () => {
  test("un plugin minimal n'annonce aucune capacite optionnelle", () => {
    const caps = detectCapabilities(new MinimalPlugin());
    assert.deepEqual(caps, {
      describable: false,
      paged: false,
      incremental: false,
      healthReporting: false,
      browserAssisted: false,
    });
  });

  test("les capacites sont deduites du code, jamais d'une declaration", () => {
    const plugin = new RichPlugin();
    assert.equal(isDescribable(plugin), true);
    assert.equal(isIncremental(plugin), true);
    assert.equal(isHealthReporting(plugin), false);
  });

  test("checkpoint sans restore ne suffit pas a rendre un plugin incremental", () => {
    const partial = Object.assign(new MinimalPlugin(), {
      checkpoint: async (): Promise<CheckpointState> => ({ version: 1 as const }),
    });
    assert.equal(isIncremental(partial as unknown as SourcePlugin), false);
  });
});

describe("horloge injectee (Vol. III, 2.5)", () => {
  test("le temps n'avance que si on l'avance", async () => {
    const clock = new ManualClock(1_700_000_000_000);
    let resolved = false;
    const waiting = clock.sleep(5000).then(() => {
      resolved = true;
    });

    clock.advance(4999);
    await Promise.resolve();
    assert.equal(resolved, false);

    clock.advance(1);
    await waiting;
    assert.equal(resolved, true);
    assert.equal(clock.pendingSleeps, 0);
    assert.equal(clock.nowMillis(), 1_700_000_005_000);
  });

  test("une attente annulee ne fuit pas", async () => {
    const clock = new ManualClock(0);
    const controller = new AbortController();
    const waiting = clock.sleep(1000, controller.signal);
    controller.abort(new Error("arret demande"));
    await assert.rejects(waiting, /arret demande/);
    assert.equal(clock.pendingSleeps, 0);
  });
});
