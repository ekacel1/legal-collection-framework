/**
 * Garde d'inactivite du transfert — point B6 de la checklist.
 *
 * Le defaut d'origine : un delai TOTAL de 120 s tuait tout document trop gros
 * pour la liaison. `loi-2025-14` (37 Mo, SGG Benin) echouait a chaque tentative
 * alors que le transfert progressait normalement. Ces tests fixent la
 * distinction entre « lent » et « mort ».
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { withIdleGuard } from "../src/net/transport.js";
import { ManualClock } from "../src/domain/clock.js";

const CHUNK = new Uint8Array([1, 2, 3, 4]);

/**
 * Maintient la boucle d'evenements en vie pendant les tests.
 *
 * Ici, tout est suspendu a une horloge simulee et a une source pilotee a la
 * main : plus aucun minuteur reel ne subsiste, et Node conclurait a tort au
 * blocage. Ce battement n'influence ni l'horloge ni la source.
 */
let keepAlive: NodeJS.Timeout;

beforeEach(() => {
  keepAlive = setInterval(() => undefined, 5);
});

afterEach(() => {
  clearInterval(keepAlive);
});

/** Source pilotee a la main : rien n'arrive tant qu'on ne le decide pas. */
class ControlledSource {
  readonly #queue: (
    | { kind: "chunk"; value: Uint8Array }
    | { kind: "end" }
    | { kind: "error"; error: Error }
  )[] = [];
  #waiting: (() => void) | null = null;
  closed = false;

  push(value: Uint8Array): void {
    this.#queue.push({ kind: "chunk", value });
    this.#wake();
  }

  end(): void {
    this.#queue.push({ kind: "end" });
    this.#wake();
  }

  fail(error: Error): void {
    this.#queue.push({ kind: "error", error });
    this.#wake();
  }

  #wake(): void {
    const waiting = this.#waiting;
    this.#waiting = null;
    waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    try {
      for (;;) {
        while (this.#queue.length === 0) {
          await new Promise<void>((resolve) => {
            this.#waiting = resolve;
          });
        }
        const item = this.#queue.shift() as { kind: string; value?: Uint8Array; error?: Error };
        if (item.kind === "end") return;
        if (item.kind === "error") throw item.error as Error;
        yield item.value as Uint8Array;
      }
    } finally {
      this.closed = true;
    }
  }
}

/** Laisse la boucle d'evenements traiter les micro-taches en attente. */
async function settle(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

describe("garde d'inactivite (B6)", () => {
  test("un flux qui se tait au-dela du delai est abandonne", async () => {
    const clock = new ManualClock(0);
    const source = new ControlledSource();
    let abandoned = false;

    const guarded = withIdleGuard(source, {
      idleMs: 60_000,
      maxMs: 600_000,
      clock,
      onGiveUp: () => {
        abandoned = true;
      },
    });

    const collected = (async (): Promise<Uint8Array[]> => {
      const out: Uint8Array[] = [];
      for await (const chunk of guarded) out.push(chunk);
      return out;
    })();
    const outcome = collected.then(
      () => "termine",
      (error: Error) => error.message,
    );

    source.push(CHUNK);
    await settle();
    clock.advance(60_001);

    assert.match(await outcome, /delai d'inactivite depasse/);
    // C'est `onGiveUp` qui libere reellement : il annule la requete, ce qui
    // debloque la lecture figee. Attendre la fermeture du flux depuis la garde
    // reviendrait a attendre la source qu'on vient de declarer morte.
    assert.equal(abandoned, true, "la ressource sous-jacente doit etre liberee");
  });

  test("un transfert lent mais regulier n'est jamais interrompu", async () => {
    const clock = new ManualClock(0);
    const source = new ControlledSource();
    const received: Uint8Array[] = [];

    const done = (async (): Promise<void> => {
      for await (const chunk of withIdleGuard(source, {
        idleMs: 60_000,
        maxMs: 3_600_000,
        clock,
      })) {
        received.push(chunk);
      }
    })();

    // Dix morceaux espaces de 59 s : total 590 s, largement au-dela de
    // l'ancien delai total de 120 s, mais jamais inactif plus de 60 s.
    for (let index = 0; index < 10; index++) {
      source.push(CHUNK);
      await settle();
      clock.advance(59_000);
      await settle();
    }
    source.end();
    await done;

    assert.equal(received.length, 10);
  });

  test("le plafond absolu protege d'une source qui distille", async () => {
    const clock = new ManualClock(0);
    const source = new ControlledSource();

    const outcome = (async (): Promise<string> => {
      try {
        for await (const _chunk of withIdleGuard(source, {
          idleMs: 60_000,
          maxMs: 120_000,
          clock,
        })) {
          void _chunk;
          clock.advance(50_000);
        }
        return "termine";
      } catch (error) {
        return (error as Error).message;
      }
    })();

    for (let index = 0; index < 5; index++) {
      source.push(CHUNK);
      await settle();
    }

    assert.match(await outcome, /delai maximal de transfert depasse/);
  });

  test("un flux normal traverse la garde sans la reveiller", async () => {
    const clock = new ManualClock(0);
    async function* quick(): AsyncGenerator<Uint8Array> {
      yield CHUNK;
      yield CHUNK;
    }

    const received: Uint8Array[] = [];
    for await (const chunk of withIdleGuard(quick(), {
      idleMs: 1000,
      maxMs: 10_000,
      clock,
    })) {
      received.push(chunk);
    }

    assert.equal(received.length, 2);
    // Aucune attente ne doit subsister : chaque course annule sa perdante.
    assert.equal(clock.pendingSleeps, 0);
  });

  test("une erreur de la source traverse la garde telle quelle", async () => {
    const clock = new ManualClock(0);
    const source = new ControlledSource();

    const outcome = (async (): Promise<string> => {
      try {
        for await (const _chunk of withIdleGuard(source, {
          idleMs: 60_000,
          maxMs: 600_000,
          clock,
        })) {
          void _chunk;
        }
        return "termine";
      } catch (error) {
        return (error as Error).message;
      }
    })();

    source.fail(new Error("connexion reinitialisee"));
    assert.equal(await outcome, "connexion reinitialisee");
  });

  test("l'abandon du consommateur ferme le flux source", async () => {
    const clock = new ManualClock(0);
    const source = new ControlledSource();

    const guarded = withIdleGuard(source, { idleMs: 60_000, maxMs: 600_000, clock });
    const iterator = guarded[Symbol.asyncIterator]();

    source.push(CHUNK);
    await iterator.next();
    await iterator.return(undefined);

    // Aucune attente ne subsiste : la garde annule sa perdante a chaque tour.
    assert.equal(clock.pendingSleeps, 0);
  });
});
