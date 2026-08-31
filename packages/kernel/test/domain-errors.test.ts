import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { asSourceId } from "../src/domain/ids.js";
import {
  BudgetExceeded,
  CapabilityViolation,
  classify,
  ContractPluginError,
  FatalPluginError,
  LcfError,
  PolicyViolation,
  RateLimited,
  SourceStructureChanged,
  SourceUnavailable,
  TransientPluginError,
  UnexpectedPluginError,
  UnresolvableDocument,
} from "../src/domain/errors.js";

const SOURCE = asSourceId("example.gazette");

describe("taxonomie d'erreurs (Vol. III, ch. 8)", () => {
  test("une erreur transitoire est reessayable et n'affecte que le document", () => {
    const error = new SourceUnavailable(SOURCE);
    assert.ok(error instanceof TransientPluginError);
    assert.equal(error.retryable, true);
    assert.equal(error.scope, "document");
  });

  test("une erreur de contrat n'est pas reessayee et laisse la source vivante", () => {
    const error = new UnresolvableDocument(SOURCE, "2024/118");
    assert.ok(error instanceof ContractPluginError);
    assert.equal(error.retryable, false);
    assert.equal(error.scope, "document");
    assert.equal(error.context["nativeId"], "2024/118");
  });

  test("une erreur fatale porte sur la source entiere", () => {
    const error = new SourceStructureChanged(SOURCE, "selecteur h1.doc-title absent");
    assert.ok(error instanceof FatalPluginError);
    assert.equal(error.scope, "source");
    assert.equal(error.retryable, false);
  });

  test("une violation de capacite est fatale et nomme l'hote refuse", () => {
    const error = new CapabilityViolation(SOURCE, "network.host", "b.example");
    assert.equal(error.scope, "source");
    assert.equal(error.context["subject"], "b.example");
  });

  test("un refus de robots.txt abandonne le document sans mettre la source en quarantaine", () => {
    const error = new PolicyViolation(SOURCE, "robots.txt", "https://a.example/x.pdf");
    assert.equal(error.scope, "document");
    assert.equal(error.retryable, false);
  });

  test("le depassement de budget porte la dimension et la borne appliquee", () => {
    const error = new BudgetExceeded("requests", 50);
    assert.equal(error.context["dimension"], "requests");
    assert.equal(error.context["limit"], 50);
    assert.equal(error.scope, "source");
  });

  test("RateLimited transporte le delai conseille par la source", () => {
    assert.equal(new RateLimited(SOURCE, 4000).retryAfterMs, 4000);
    assert.equal(new RateLimited(SOURCE).retryAfterMs, undefined);
  });

  test("toute erreur inconnue est traitee comme fatale (defaut severe assume)", () => {
    const classified = classify(SOURCE, new TypeError("selecteur nul"));
    assert.ok(classified instanceof UnexpectedPluginError);
    assert.equal(classified.scope, "source");
    assert.equal((classified as UnexpectedPluginError).cause instanceof TypeError, true);
  });

  test("une erreur du domaine deja classee n'est pas reclassee", () => {
    const original = new SourceUnavailable(SOURCE);
    assert.equal(classify(SOURCE, original), original);
  });

  test("la serialisation journalisable expose la classe, la portee et le contexte", () => {
    const payload = new UnresolvableDocument(SOURCE, "2024/118").toJSON();
    assert.equal(payload["errorClass"], "UnresolvableDocument");
    assert.equal(payload["scope"], "document");
    assert.equal(payload["sourceId"], SOURCE);
  });

  test("toute erreur du Framework derive de LcfError", () => {
    for (const error of [
      new SourceUnavailable(SOURCE),
      new UnresolvableDocument(SOURCE, "x"),
      new CapabilityViolation(SOURCE, "browser", "n/a"),
      new BudgetExceeded("bytes", 1),
    ]) {
      assert.ok(error instanceof LcfError);
      assert.equal(error.errorClass, error.constructor.name);
    }
  });
});
