#!/usr/bin/env node
/**
 * Point d'entree de la commande `lcf`.
 *
 * L'analyse d'arguments est ecrite a la main : une dependance de plus pour
 * decouper un tableau de chaines serait une dette de quinze ans pour une
 * economie de trente lignes.
 */
import * as path from "node:path";
import { describeUnknown, LcfError } from "@lcf/kernel";

import {
  CONFIG_FILENAME,
  type LcfConfig,
} from "./config.js";
import {
  commandHelp,
  commandInit,
  commandReindex,
  commandRun,
  commandSourceAdd,
  commandSourceList,
  commandSourceResume,
  commandDaemon,
  commandServe,
  commandStatus,
  commandVerify,
  type CommandContext,
  type CommandResult,
} from "./commands.js";

export interface ParsedArgv {
  readonly command: readonly string[];
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

export function parseArgv(argv: readonly string[]): ParsedArgv {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] as string;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      index++;
    } else {
      flags[name] = true;
    }
  }

  // La commande peut comporter deux mots (`source add`), jamais plus.
  const command = positionals.slice(0, positionals[0] === "source" ? 2 : 1);
  return { command, positionals: positionals.slice(command.length), flags };
}

export async function main(
  argv: readonly string[],
  out: (line: string) => void = console.log,
  cwd: string = process.cwd(),
): Promise<number> {
  const parsed = parseArgv(argv);
  // `--config` designe la configuration d'une SOURCE (`source add`) ; le
  // fichier de configuration du Framework a son propre drapeau, pour qu'aucune
  // des deux notions n'ait a se deviner au contexte.
  const configFlag = parsed.flags["config-file"];
  const configPath =
    typeof configFlag === "string"
      ? path.resolve(cwd, configFlag)
      : path.resolve(cwd, CONFIG_FILENAME);

  const ctx: CommandContext = {
    cwd,
    configPath,
    args: parsed.positionals,
    flags: parsed.flags,
    out,
  };

  if (parsed.flags["help"] === true || parsed.command.length === 0) {
    return commandHelp(ctx).exitCode;
  }

  const command = parsed.command.join(" ");
  const handlers: Record<string, (context: CommandContext) => Promise<CommandResult> | CommandResult> = {
    init: commandInit,
    "source add": commandSourceAdd,
    "source list": commandSourceList,
    "source resume": commandSourceResume,
    run: commandRun,
    daemon: commandDaemon,
    serve: commandServe,
    status: commandStatus,
    reindex: commandReindex,
    verify: commandVerify,
    help: commandHelp,
  };

  const handler = handlers[command];
  if (handler === undefined) {
    out(`commande inconnue : ${command}`);
    commandHelp(ctx);
    return 2;
  }

  try {
    return (await handler(ctx)).exitCode;
  } catch (error) {
    // Une erreur du domaine est deja formulee pour un exploitant : on
    // n'y ajoute pas une pile d'appels qui la rendrait moins lisible.
    if (error instanceof LcfError) {
      out(`echec : ${error.message}`);
      if (Object.keys(error.context).length > 0) {
        out(`  contexte : ${JSON.stringify(error.context)}`);
      }
    } else {
      out(`echec : ${describeUnknown(error)}`);
    }
    return 1;
  }
}

export type { LcfConfig };

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]));

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(describeUnknown(error));
      process.exitCode = 1;
    });
}
