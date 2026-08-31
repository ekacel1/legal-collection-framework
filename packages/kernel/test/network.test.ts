import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { FixtureHttpTransport } from "../src/net/testing.js";
import { ScopedHttpClient, buildUserAgent } from "../src/net/scoped-http-client.js";
import {
  BudgetTracker,
  CircuitBreaker,
  HostRateLimiter,
  backoffDelayMs,
  isRetryableStatus,
  normalizeNetworkCapability,
  parseRetryAfter,
} from "../src/net/policy.js";
import { RobotsPolicy, isAllowed, parseRobots } from "../src/net/robots.js";
import { ManualClock } from "../src/domain/clock.js";
import { asSourceId } from "../src/domain/ids.js";
import {
  BudgetExceeded,
  CapabilityViolation,
  PolicyViolation,
  RateLimited,
  SourceUnavailable,
  UnexpectedHttpStatus,
} from "../src/domain/errors.js";
import type { FixturePlan } from "../src/net/testing.js";

const SOURCE = asSourceId("example.gazette");
const UA = buildUserAgent("ops@example.org");

interface Harness {
  readonly client: ScopedHttpClient;
  readonly transport: FixtureHttpTransport;
  readonly clock: ManualClock;
  readonly breaker: CircuitBreaker;
}

function harness(
  fixtures: FixturePlan,
  overrides: {
    allowedHosts?: readonly string[];
    politenessDelayMs?: number;
    maxRequestsPerMinute?: number;
    robots?: RobotsPolicy;
    respectRobotsTxt?: boolean;
    budget?: BudgetTracker;
    clock?: ManualClock;
  } = {},
): Harness {
  const clock = overrides.clock ?? new ManualClock(1_700_000_000_000);
  const transport = new FixtureHttpTransport(fixtures, { now: () => clock.nowMillis() });
  const breaker = new CircuitBreaker(clock);
  const capability = normalizeNetworkCapability({
    allowedHosts: overrides.allowedHosts ?? ["gazette.example"],
    politenessDelayMs: overrides.politenessDelayMs ?? 100,
    maxRequestsPerMinute: overrides.maxRequestsPerMinute ?? 60,
    respectRobotsTxt: overrides.respectRobotsTxt ?? false,
  });

  const client = new ScopedHttpClient({
    sourceId: SOURCE,
    capability,
    transport,
    limiter: new HostRateLimiter(clock),
    breaker,
    clock,
    userAgent: UA,
    random: () => 0.5,
    ...(overrides.robots === undefined ? {} : { robots: overrides.robots }),
    ...(overrides.budget === undefined ? {} : { budget: overrides.budget }),
  });

  return { client, transport, clock, breaker };
}

/** Le temps avance tout seul : la ManualClock resout les attentes en boucle. */
async function drive<T>(clock: ManualClock, work: Promise<T>): Promise<T> {
  let settled = false;
  const wrapped = work.finally(() => {
    settled = true;
  });
  for (let step = 0; step < 1000 && !settled; step++) {
    await Promise.resolve();
    if (!settled) clock.advance(1000);
  }
  return wrapped;
}

describe("filtre de capacite reseau (AC-3.2)", () => {
  test("un hote hors liste est refuse avant toute resolution DNS", async () => {
    const { client, transport } = harness({});
    await assert.rejects(
      client.get("https://autre.example/doc.pdf"),
      (error: unknown) => error instanceof CapabilityViolation,
    );
    // Aucun paquet n'a ete emis : le transport n'a jamais ete sollicite.
    assert.equal(transport.calls.length, 0);
  });

  test("l'incident nomme l'hote refuse", async () => {
    const { client } = harness({});
    await assert.rejects(client.get("https://autre.example/x"), (error: unknown) => {
      assert.ok(error instanceof CapabilityViolation);
      assert.equal(error.context["subject"], "autre.example");
      return true;
    });
  });

  test("un protocole non http est refuse", async () => {
    const { client } = harness({}, { allowedHosts: ["gazette.example"] });
    await assert.rejects(
      client.get("ftp://gazette.example/doc.pdf"),
      (error: unknown) => error instanceof CapabilityViolation,
    );
  });

  test("l'en-tete d'identification est toujours present", async () => {
    const { client, transport } = harness({
      "https://gazette.example/index": { body: "ok" },
    });
    await client.getText("https://gazette.example/index");
    assert.equal(transport.calls[0]?.headers["user-agent"], UA);
    assert.match(UA, /^LCF\/1\.0 \(Legal Collection Framework;.*ops@example\.org\)$/);
  });
});

describe("politesse et quota (Vol. VI, 7.2)", () => {
  test("le delai de politesse separe deux requetes vers le meme hote", async () => {
    const { client, transport, clock } = harness(
      {
        "https://gazette.example/a": { body: "a" },
        "https://gazette.example/b": { body: "b" },
      },
      { politenessDelayMs: 1000 },
    );

    await client.getText("https://gazette.example/a");
    await drive(clock, client.getText("https://gazette.example/b"));

    const [first, second] = transport.calls;
    assert.ok(
      (second?.at ?? 0) - (first?.at ?? 0) >= 1000,
      "le second appel doit attendre le delai de politesse",
    );
  });

  test("le plancher de politesse est de 100 ms, meme si le manifeste demande moins", () => {
    const capability = normalizeNetworkCapability({
      allowedHosts: ["a.example"],
      politenessDelayMs: 5,
    });
    assert.equal(capability.politenessDelayMs, 100);
  });

  test("la concurrence par hote est plafonnee a dix", () => {
    const capability = normalizeNetworkCapability({
      allowedHosts: ["a.example"],
      maxConcurrentPerHost: 50,
    });
    assert.equal(capability.maxConcurrentPerHost, 10);
  });
});

describe("repli exponentiel (Vol. II, 6.3)", () => {
  test("les delais suivent immediat, 1 s, 4 s, 16 s", () => {
    const half = (): number => 0.5;
    assert.equal(backoffDelayMs(1, undefined, half), 0);
    assert.equal(backoffDelayMs(2, undefined, half), 1000);
    assert.equal(backoffDelayMs(3, undefined, half), 4000);
    assert.equal(backoffDelayMs(4, undefined, half), 16_000);
  });

  test("le jitter ecarte les reessais simultanes", () => {
    const low = backoffDelayMs(3, undefined, () => 0);
    const high = backoffDelayMs(3, undefined, () => 1);
    assert.ok(low < 4000 && high > 4000, "le delai doit varier autour de la base");
  });

  test("une panne passagere est reessayee puis reussit", async () => {
    const { client, transport, clock } = harness({
      "https://gazette.example/doc": [
        { status: 503 },
        { status: 503 },
        { status: 200, body: "enfin" },
      ],
    });

    const text = await drive(clock, client.getText("https://gazette.example/doc"));
    assert.equal(text, "enfin");
    assert.equal(transport.callsTo("https://gazette.example/doc"), 3);
  });

  test("cinq tentatives au maximum, puis l'erreur est levee", async () => {
    const { client, transport, clock } = harness({
      "https://gazette.example/doc": { status: 503 },
    });

    await assert.rejects(
      drive(clock, client.getText("https://gazette.example/doc")),
      (error: unknown) => error instanceof SourceUnavailable,
    );
    assert.equal(transport.callsTo("https://gazette.example/doc"), 5);
  });

  test("un 429 produit une erreur de limitation de debit", async () => {
    const { client, clock } = harness({
      "https://gazette.example/doc": { status: 429, headers: { "retry-after": "2" } },
    });
    await assert.rejects(
      drive(clock, client.getText("https://gazette.example/doc")),
      (error: unknown) => error instanceof RateLimited,
    );
  });

  test("Retry-After est lu en secondes comme en date", () => {
    assert.equal(parseRetryAfter("3", 0), 3000);
    assert.equal(parseRetryAfter(undefined, 0), undefined);
    assert.equal(parseRetryAfter("Tue, 14 Nov 2023 22:13:30 GMT", 1_700_000_000_000), 10_000);
  });

  test("un statut definitif n'est jamais reessaye", async () => {
    const { client, transport, clock } = harness({
      "https://gazette.example/doc": { status: 404 },
    });
    await assert.rejects(
      drive(clock, client.getText("https://gazette.example/doc")),
      (error: unknown) => error instanceof UnexpectedHttpStatus,
    );
    assert.equal(transport.callsTo("https://gazette.example/doc"), 1);
    assert.equal(isRetryableStatus(404), false);
    assert.equal(isRetryableStatus(503), true);
  });

  test("une panne de transport est classee comme erreur transitoire", async () => {
    const { client, clock } = harness({
      "https://gazette.example/doc": { error: new Error("ECONNRESET") },
    });
    await assert.rejects(
      drive(clock, client.getText("https://gazette.example/doc")),
      (error: unknown) => error instanceof SourceUnavailable,
    );
  });
});

describe("disjoncteur", () => {
  test("il s'ouvre apres cinq echecs et protege la source", async () => {
    const { client, transport, clock, breaker } = harness({
      "https://gazette.example/doc": { status: 503 },
    });

    await assert.rejects(drive(clock, client.getText("https://gazette.example/doc")));
    assert.equal(breaker.isOpen, true);

    const before = transport.calls.length;
    await assert.rejects(
      drive(clock, client.getText("https://gazette.example/doc")),
      (error: unknown) => error instanceof SourceUnavailable,
    );
    assert.equal(transport.calls.length, before, "aucune requete tant que le circuit est ouvert");
  });

  test("il repasse en demi-ouvert apres la periode de refroidissement", () => {
    const clock = new ManualClock(0);
    const breaker = new CircuitBreaker(clock, { failureThreshold: 2, cooldownMs: 1000 });
    breaker.recordFailure();
    breaker.recordFailure();
    assert.equal(breaker.state, "open");
    clock.advance(1000);
    assert.equal(breaker.state, "half-open");
    breaker.recordSuccess();
    assert.equal(breaker.state, "closed");
  });
});

describe("budget de decouverte (AC-3.6)", () => {
  test("le depassement interrompt l'enumeration et declenche l'annulation", async () => {
    // Une seule horloge pour le budget, le limiteur et le pilote de test :
    // deux horloges distinctes feraient attendre une avance qui n'arrive jamais.
    const clock = new ManualClock(1_700_000_000_000);
    const budget = new BudgetTracker(
      { maxRequests: 2, maxBytes: 1_000_000, maxDurationMs: 60_000 },
      clock,
    );
    const { client } = harness(
      {
        "https://gazette.example/a": { body: "a" },
        "https://gazette.example/b": { body: "b" },
        "https://gazette.example/c": { body: "c" },
      },
      { budget, politenessDelayMs: 100, clock },
    );

    await client.getText("https://gazette.example/a");
    await drive(clock, client.getText("https://gazette.example/b"));
    await assert.rejects(
      drive(clock, client.getText("https://gazette.example/c")),
      (error: unknown) => error instanceof BudgetExceeded,
    );
    assert.equal(budget.signal.aborted, true);
  });

  test("le budget d'octets est applique sur le volume recu", async () => {
    const clock = new ManualClock(1_700_000_000_000);
    const budget = new BudgetTracker(
      { maxRequests: 100, maxBytes: 5, maxDurationMs: 60_000 },
      clock,
    );
    const { client } = harness(
      { "https://gazette.example/gros": { body: "contenu trop long" } },
      { budget, clock },
    );
    await assert.rejects(
      client.getText("https://gazette.example/gros"),
      (error: unknown) => error instanceof BudgetExceeded,
    );
  });
});

describe("robots.txt (AC-6.6)", () => {
  test("une regle Disallow refuse la requete avant emission", async () => {
    const transport = new FixtureHttpTransport({
      "https://gazette.example/robots.txt": {
        body: "User-agent: *\nDisallow: /prive/\n",
      },
      "https://gazette.example/prive/doc.pdf": { body: "%PDF-1.7" },
    });
    const robots = new RobotsPolicy(transport, { userAgent: UA });
    const clock = new ManualClock(0);
    const client = new ScopedHttpClient({
      sourceId: SOURCE,
      capability: normalizeNetworkCapability({
        allowedHosts: ["gazette.example"],
        politenessDelayMs: 100,
        respectRobotsTxt: true,
      }),
      transport,
      limiter: new HostRateLimiter(clock),
      breaker: new CircuitBreaker(clock),
      clock,
      userAgent: UA,
      robots,
    });

    await assert.rejects(
      client.getText("https://gazette.example/prive/doc.pdf"),
      (error: unknown) => error instanceof PolicyViolation,
    );
    assert.equal(transport.callsTo("https://gazette.example/prive/doc.pdf"), 0);
  });

  test("la regle la plus longue l'emporte, Allow gagnant a longueur egale", () => {
    const ruleset = parseRobots("User-agent: *\nDisallow: /docs/\nAllow: /docs/public/\n");
    assert.equal(isAllowed(ruleset, UA, "/docs/prive.pdf"), false);
    assert.equal(isAllowed(ruleset, UA, "/docs/public/acte.pdf"), true);
    assert.equal(isAllowed(ruleset, UA, "/autre.pdf"), true);
  });

  test("un robots.txt absent autorise tout, une panne serveur interdit tout", async () => {
    const absent = new RobotsPolicy(
      new FixtureHttpTransport({ "https://a.example/robots.txt": { status: 404 } }),
      { userAgent: UA },
    );
    assert.equal(await absent.allows("https://a.example/x"), true);

    const enPanne = new RobotsPolicy(
      new FixtureHttpTransport({ "https://b.example/robots.txt": { status: 500 } }),
      { userAgent: UA },
    );
    assert.equal(await enPanne.allows("https://b.example/x"), false);
  });

  test("un groupe specifique prime sur le groupe generique", () => {
    const ruleset = parseRobots(
      "User-agent: *\nDisallow: /\n\nUser-agent: LCF\nDisallow: /prive/\n",
    );
    assert.equal(isAllowed(ruleset, "LCF/1.0", "/documents/a.pdf"), true);
    assert.equal(isAllowed(ruleset, "LCF/1.0", "/prive/a.pdf"), false);
    assert.equal(isAllowed(ruleset, "AutreBot", "/documents/a.pdf"), false);
  });

  test("un Disallow vide autorise tout", () => {
    assert.equal(isAllowed(parseRobots("User-agent: *\nDisallow:\n"), UA, "/quoi"), true);
  });
});
