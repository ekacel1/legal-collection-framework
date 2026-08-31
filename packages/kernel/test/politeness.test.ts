/**
 * Protections contre la surcharge d'une source — Volume VI, chapitre 7.
 *
 * Trois failles nommees le 31/08/2026 :
 *   C2 — rien n'empechait de collecter en pleine journee ouvrable ;
 *   verrou — deux processus doublaient la charge negociee ;
 *   B9 — on reagissait aux erreurs, jamais a une source qui ralentit.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";

import {
  describeWindow,
  isInBlackout,
  matchingWindow,
  validateWindows,
} from "../src/scheduling/blackout.js";
import { ProcessLock } from "../src/scheduling/process-lock.js";
import { ADAPTIVE, HostRateLimiter, normalizeNetworkCapability } from "../src/net/policy.js";
import { ManualClock } from "../src/domain/clock.js";
import { StorageError } from "../src/domain/errors.js";
import { tempDir } from "./helpers.js";

const OUVRABLES = [{ days: "mon-fri", from: "08:00", to: "18:00", tz: "utc" as const }];

/** Un instant UTC precis, pour ne dependre d'aucun fuseau. */
function utc(day: number, hour: number, minute = 0): Date {
  // 2026-08-31 est un lundi : +day donne le jour de la semaine voulu.
  return new Date(Date.UTC(2026, 7, 31 + day, hour, minute));
}

describe("fenetres d'exclusion (C2)", () => {
  test("les heures ouvrables sont exclues", () => {
    assert.equal(isInBlackout(OUVRABLES, utc(0, 10)), true, "lundi 10h");
    assert.equal(isInBlackout(OUVRABLES, utc(2, 14)), true, "mercredi 14h");
    assert.equal(isInBlackout(OUVRABLES, utc(4, 17, 59)), true, "vendredi 17h59");
  });

  test("la nuit et le week-end restent ouverts a la collecte", () => {
    assert.equal(isInBlackout(OUVRABLES, utc(0, 3)), false, "lundi 3h");
    assert.equal(isInBlackout(OUVRABLES, utc(0, 18)), false, "lundi 18h pile");
    assert.equal(isInBlackout(OUVRABLES, utc(5, 10)), false, "samedi 10h");
    assert.equal(isInBlackout(OUVRABLES, utc(6, 10)), false, "dimanche 10h");
  });

  test("une fenetre a cheval sur minuit est correctement interpretee", () => {
    const nuit = [{ days: "*", from: "22:00", to: "06:00", tz: "utc" as const }];
    assert.equal(isInBlackout(nuit, utc(0, 23)), true);
    assert.equal(isInBlackout(nuit, utc(1, 2)), true, "le lendemain matin");
    assert.equal(isInBlackout(nuit, utc(1, 7)), false);
  });

  test("une plage de jours peut enjamber la fin de semaine", () => {
    const weekend = [{ days: "fri-mon", from: "00:00", to: "23:59", tz: "utc" as const }];
    assert.equal(isInBlackout(weekend, utc(4, 12)), true, "vendredi");
    assert.equal(isInBlackout(weekend, utc(6, 12)), true, "dimanche");
    assert.equal(isInBlackout(weekend, utc(2, 12)), false, "mercredi");
  });

  test("la fenetre qui exclut est identifiable, pour pouvoir l'expliquer", () => {
    const window = matchingWindow(OUVRABLES, utc(0, 10));
    assert.notEqual(window, null);
    assert.equal(describeWindow(window as (typeof OUVRABLES)[number]), "mon-fri 08:00-18:00 (utc)");
  });

  test("une fenetre illisible n'arrete jamais la collecte en silence", () => {
    const cassee = [{ days: "mon-fri", from: "8h", to: "18:00" }];
    assert.equal(isInBlackout(cassee, utc(0, 10)), false);
    assert.deepEqual(validateWindows(cassee), ["fenetre 0 : heure de debut invalide (8h)"]);
  });

  test("aucune fenetre configuree n'exclut rien", () => {
    assert.equal(isInBlackout([], utc(0, 10)), false);
  });
});

describe("verrou de magasin entre processus", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await tempDir("lock");
  });

  afterEach(async () => {
    await fsp.rm(workspace, { recursive: true, force: true });
  });

  test("un second processus ne peut pas doubler la charge", async () => {
    const premier = new ProcessLock({ dataDir: workspace, command: "run bj.sgg.lois" });
    await premier.acquire();

    const second = new ProcessLock({ dataDir: workspace, command: "run bj.sgg.decrets" });
    await assert.rejects(second.acquire(), (error: unknown) => {
      assert.ok(error instanceof StorageError);
      // Le message doit nommer le detenteur : sinon l'exploitant cherche.
      assert.match(error.message, /run bj\.sgg\.lois/);
      assert.match(error.message, /pid \d+/);
      return true;
    });

    await premier.release();
    await second.acquire();
    assert.equal(second.held, true);
    await second.release();
  });

  test("un verrou abandonne par un processus mort est repris", async () => {
    const mort = new ProcessLock({
      dataDir: workspace,
      command: "demon",
      isAlive: () => false,
    });
    await mort.acquire();

    // Le fichier subsiste, mais son detenteur n'existe plus : un plantage ne
    // doit pas immobiliser le collecteur jusqu'a une intervention humaine.
    const vivant = new ProcessLock({
      dataDir: workspace,
      command: "run",
      isAlive: () => false,
    });
    await vivant.acquire();
    assert.equal(vivant.held, true);
    await vivant.release();
  });

  test("le detenteur est lisible de l'exterieur", async () => {
    const lock = new ProcessLock({ dataDir: workspace, command: "daemon" });
    await lock.acquire();

    const holder = await new ProcessLock({ dataDir: workspace, command: "status" }).holder();
    assert.equal(holder?.pid, process.pid);
    assert.equal(holder?.command, "daemon");
    await lock.release();

    assert.equal(await lock.holder(), null);
  });
});

describe("ralentissement adaptatif (B9)", () => {
  const capability = normalizeNetworkCapability({
    allowedHosts: ["source.example"],
    politenessDelayMs: 1000,
    maxRequestsPerMinute: 600,
  });

  test("un hote stable ne declenche aucun ralentissement", () => {
    const limiter = new HostRateLimiter(new ManualClock(0));
    for (let index = 0; index < 20; index++) limiter.observeLatency("source.example", 200);
    assert.equal(limiter.slowdownFactor("source.example"), 1);
  });

  test("un hote qui ralentit fait s'ecarter les requetes", () => {
    const limiter = new HostRateLimiter(new ManualClock(0));
    for (let index = 0; index < 20; index++) limiter.observeLatency("source.example", 200);

    // La source se degrade : 2 s au lieu de 200 ms.
    for (let index = 0; index < 10; index++) limiter.observeLatency("source.example", 2000);

    const factor = limiter.slowdownFactor("source.example");
    assert.ok(factor > 1, `facteur obtenu : ${factor}`);
    assert.ok(factor <= ADAPTIVE.maxMultiplier);
  });

  test("le ralentissement est plafonne : il ne bloque jamais la collecte", () => {
    const limiter = new HostRateLimiter(new ManualClock(0));
    for (let index = 0; index < 20; index++) limiter.observeLatency("source.example", 10);
    // Degradation extreme : 10 ms devenus 60 s.
    for (let index = 0; index < 40; index++) limiter.observeLatency("source.example", 60_000);

    const factor = limiter.slowdownFactor("source.example");
    assert.ok(factor > ADAPTIVE.slowdownRatio, `facteur obtenu : ${factor}`);
    // Le plafond garantit qu'une source degradee ralentit la collecte sans
    // jamais l'arreter : le pire cas reste borne et previsible.
    assert.ok(factor <= ADAPTIVE.maxMultiplier);
  });

  test("une degradation durable finit par devenir la nouvelle reference", () => {
    const limiter = new HostRateLimiter(new ManualClock(0));
    for (let index = 0; index < 20; index++) limiter.observeLatency("source.example", 100);
    for (let index = 0; index < 30; index++) limiter.observeLatency("source.example", 1000);
    assert.ok(limiter.slowdownFactor("source.example") > 1, "on ralentit d'abord");

    // Deux cents mesures plus tard, l'hote n'est pas en panne : il est
    // simplement plus lent qu'avant. Rester a huit fois le delai serait punir
    // une source qui fonctionne.
    for (let index = 0; index < 400; index++) limiter.observeLatency("source.example", 1000);
    assert.equal(limiter.slowdownFactor("source.example"), 1);
  });

  test("aucun jugement avant d'avoir assez de mesures", () => {
    const limiter = new HostRateLimiter(new ManualClock(0));
    limiter.observeLatency("source.example", 100);
    limiter.observeLatency("source.example", 9000);
    assert.equal(limiter.slowdownFactor("source.example"), 1);
  });

  test("le delai effectif s'allonge quand l'hote se degrade", async () => {
    const clock = new ManualClock(0, { autoAdvance: true });
    const limiter = new HostRateLimiter(clock);

    await limiter.acquire("source.example", capability);
    limiter.release("source.example");
    const normal = clock.nowMillis();
    await limiter.acquire("source.example", capability);
    limiter.release("source.example");
    const attenteNormale = clock.nowMillis() - normal;

    for (let index = 0; index < 20; index++) limiter.observeLatency("source.example", 100);
    for (let index = 0; index < 20; index++) limiter.observeLatency("source.example", 3000);

    const degrade = clock.nowMillis();
    await limiter.acquire("source.example", capability);
    limiter.release("source.example");
    const attenteDegradee = clock.nowMillis() - degrade;

    assert.ok(
      attenteDegradee > attenteNormale,
      `${attenteDegradee} ms devrait depasser ${attenteNormale} ms`,
    );
  });

  test("le ralentissement s'applique par hote, pas globalement", () => {
    const limiter = new HostRateLimiter(new ManualClock(0));
    for (let index = 0; index < 20; index++) limiter.observeLatency("lent.example", 100);
    for (let index = 0; index < 20; index++) limiter.observeLatency("lent.example", 5000);
    for (let index = 0; index < 20; index++) limiter.observeLatency("rapide.example", 100);

    assert.ok(limiter.slowdownFactor("lent.example") > 1);
    assert.equal(limiter.slowdownFactor("rapide.example"), 1);
  });
});
