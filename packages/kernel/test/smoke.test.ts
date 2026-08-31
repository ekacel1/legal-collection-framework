import { test } from "node:test";
import assert from "node:assert/strict";
import { PACKAGE_NAME } from "../src/index.js";

test("la chaine de build et le lanceur de tests fonctionnent", () => {
  assert.equal(PACKAGE_NAME, "@lcf/kernel");
});
