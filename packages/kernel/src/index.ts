/**
 * @lcf/kernel — noyau du Legal Collection Framework.
 *
 * Regle absolue (Volume I, chapitre 9) : le noyau ne contient aucune URL,
 * aucun format juridique, aucune source. Il ne connait que des Documents,
 * des Sources, des Plugins, des Evenements et des Pipelines.
 */
export const PACKAGE_NAME = "@lcf/kernel";
export const KERNEL_VERSION = "0.1.0";

export * from "./domain/index.js";
export * from "./storage/index.js";
export * from "./db/index.js";
export * from "./events/index.js";
export * from "./net/index.js";
export * from "./download/index.js";
export * from "./plugins/index.js";
export * from "./orchestration/index.js";
export * from "./scheduling/index.js";
export * from "./util/json-schema.js";
export * from "./observability/index.js";
export * from "./util/canonical-json.js";
