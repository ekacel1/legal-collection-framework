/**
 * @lcf/plugin-testkit — harnais de test pour auteurs de plugins.
 *
 * Un contrat qui n'est pas testable hors ligne n'est pas testable du tout :
 * ce paquet existe pour que tester un plugin coute moins cher que ne pas le
 * tester (Volume VIII, chapitre 3).
 */
export { FixtureHttpTransport } from "@lcf/kernel";
export type { FixturePlan, FixtureResponse, FixtureTransportOptions, RecordedCall } from "@lcf/kernel";
export * from "./context.js";
