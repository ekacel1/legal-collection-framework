/**
 * Assemblage de l'application — Volume II, chapitre 2.2.
 *
 * C'est le seul endroit du systeme ou des implementations concretes sont
 * choisies. Toutes les couches au-dessus ne connaissent que des interfaces :
 * remplacer SQLite par PostgreSQL, ou le systeme de fichiers par un magasin
 * objet, se fait ici et nulle part ailleurs.
 */
import * as path from "node:path";

import {
  CollectionRunner,
  DownloadManager,
  FetchHttpTransport,
  FilesystemContentStore,
  InMemoryEventBus,
  IntegrityScanner,
  JsonLogger,
  MigrationRunner,
  PluginManager,
  SqlDocumentRepository,
  SqliteDriver,
  SystemClock,
  buildUserAgent,
  type Clock,
  type DiscoveredPlugin,
  type HttpTransport,
  type LoadedPlugin,
  type LogLevel,
  type Logger,
  type MigrationResult,
  type SourceId,
  ProcessLock,
  FileEventJournal,
  createFileSink,
  type LogSink,
} from "@lcf/kernel";
import { asSourceId, createEvent, toIsoTimestamp } from "@lcf/kernel";

import { loadConfig, resolvePaths, type LcfConfig, type SourceConfigEntry } from "./config.js";

/** Au-dela de ce delai, une execution `running` ne peut plus etre vivante. */
const STALE_RUN_AFTER_MS = 24 * 60 * 60 * 1000;

export interface AppOptions {
  readonly configPath: string;
  /**
   * Commande demandant le verrou exclusif du magasin.
   *
   * Toute commande qui SOLLICITE une source ou ecrit massivement le prend :
   * deux processus concurrents auraient chacun leur limiteur de debit, et la
   * source recevrait le double de la charge negociee. Les commandes de lecture
   * s'en passent.
   */
  readonly exclusive?: string;
  /** Ecrit journaux et evenements sur disque. Active par le demon. */
  readonly persistLogs?: boolean;
  readonly logLevel?: LogLevel;
  readonly clock?: Clock;
  readonly transport?: HttpTransport;
  readonly logger?: Logger;
}

export class LcfApp {
  readonly config: LcfConfig;
  readonly store: FilesystemContentStore;
  readonly driver: SqliteDriver;
  readonly repository: SqlDocumentRepository;
  readonly bus: InMemoryEventBus;
  readonly plugins: PluginManager;
  readonly downloads: DownloadManager;
  readonly runner: CollectionRunner;
  readonly scanner: IntegrityScanner;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly lock: ProcessLock | null;

  #discovered: DiscoveredPlugin[] | null = null;
  readonly #logSink: (LogSink & { close(): void }) | null;
  readonly #eventJournal: FileEventJournal | null;

  private constructor(config: LcfConfig, options: AppOptions) {
    this.config = config;
    this.clock = options.clock ?? new SystemClock();

    // Journaux durables des qu'un repertoire est connu : un demon qui tourne
    // des semaines ecrit dans le vide si personne ne conserve sa parole.
    const logDir = config.logDir ?? path.join(config.dataDir, "logs");
    this.#logSink =
      options.logger === undefined && options.persistLogs === true
        ? createFileSink({ directory: logDir, clock: this.clock, alsoStdout: true })
        : null;

    this.logger =
      options.logger ??
      new JsonLogger({
        level: options.logLevel ?? "info",
        clock: this.clock,
        ...(this.#logSink === null ? {} : { sink: this.#logSink }),
      });

    this.store = new FilesystemContentStore({ root: config.dataDir, clock: this.clock });
    this.driver = new SqliteDriver({ path: path.join(config.dataDir, "index", "lcf.db") });
    this.repository = new SqlDocumentRepository(this.driver, { clock: this.clock });
    // Journal d'evenements durable : sans lui, l'historique disparait avec le
    // processus, et l'on ne peut plus expliquer une nuit de collecte.
    this.#eventJournal =
      options.persistLogs === true
        ? new FileEventJournal({
            directory: path.join(config.dataDir, "events"),
            clock: this.clock,
          })
        : null;
    this.bus = new InMemoryEventBus({
      logger: this.logger,
      ...(this.#eventJournal === null ? {} : { journal: this.#eventJournal }),
    });

    this.plugins = new PluginManager({
      clock: this.clock,
      logger: this.logger,
      transport: options.transport ?? new FetchHttpTransport(),
      userAgent: buildUserAgent(config.contact),
    });

    this.downloads = new DownloadManager({
      store: this.store,
      clock: this.clock,
      logger: this.logger,
    });

    this.runner = new CollectionRunner({
      repository: this.repository,
      store: this.store,
      downloads: this.downloads,
      plugins: this.plugins,
      bus: this.bus,
      clock: this.clock,
      logger: this.logger,
      ...(config.blackoutWindows === undefined
        ? {}
        : { blackout: config.blackoutWindows }),
    });

    this.lock =
      options.exclusive === undefined
        ? null
        : new ProcessLock({
            dataDir: config.dataDir,
            command: options.exclusive,
            clock: this.clock,
            logger: this.logger,
          });

    this.scanner = new IntegrityScanner({
      repository: this.repository,
      store: this.store,
      bus: this.bus,
      clock: this.clock,
      logger: this.logger,
    });
  }

  static async open(options: AppOptions): Promise<LcfApp> {
    const config = resolvePaths(options.configPath, await loadConfig(options.configPath));
    const app = new LcfApp(config, options);
    // Le verrou precede l'initialisation du magasin : rien ne doit toucher
    // `tmp/` avant d'etre sur qu'aucun autre processus n'y travaille.
    if (app.lock !== null) await app.lock.acquire();
    try {
      await app.store.init();
    } catch (error) {
      await app.lock?.release();
      throw error;
    }
    return app;
  }

  /** Migrations appliquees au demarrage : le schema n'est jamais suppose. */
  async migrate(): Promise<MigrationResult> {
    const runner = new MigrationRunner(this.driver, {
      directory: this.config.migrationsDir,
      clock: this.clock,
      logger: this.logger,
      // Le sous-systeme de sauvegarde arrive au Palier 1 (Vol. IX, 4.2) ;
      // d'ici la, l'absence de garde est signalee a chaque migration.
      allowMigrationWithoutBackup: true,
    });
    const result = await runner.migrate();

    // Une execution laissee `running` par un processus tue resterait ouverte
    // pour toujours et fausserait tous les rapports. Le seuil de 24 h depasse
    // largement le budget par defaut d'une collecte (6 h) : aucune execution
    // legitime, meme celle d'un demon concurrent, ne peut etre prise pour une
    // execution morte.
    const stale = await this.repository.failStaleRuns(
      toIsoTimestamp(this.clock.nowMillis() - STALE_RUN_AFTER_MS),
      toIsoTimestamp(this.clock.now()),
    );
    if (stale > 0) {
      this.logger.warn("executions interrompues cloturees", { count: stale });
    }
    if (result.applied.length > 0) {
      await this.bus.publish(
        createEvent("lcf.schema.migrated", {
          fromVersion: result.fromVersion,
          toVersion: result.toVersion,
          appliedCount: result.applied.length,
        }),
      );
    }
    return result;
  }

  async discoverPlugins(): Promise<DiscoveredPlugin[]> {
    this.#discovered ??= await this.plugins.discover(this.config.pluginPaths);
    return this.#discovered;
  }

  findSourceEntry(sourceId: string): SourceConfigEntry | undefined {
    return this.config.sources.find((entry) => entry.sourceId === sourceId);
  }

  /** Charge un plugin et enregistre la source dans l'index. */
  async loadSource(sourceId: string): Promise<LoadedPlugin> {
    const entry = this.findSourceEntry(sourceId);
    if (entry === undefined) throw new Error(`source inconnue dans la configuration : ${sourceId}`);

    const discovered = (await this.discoverPlugins()).find(
      (candidate) => candidate.manifest.id === entry.pluginId,
    );
    if (discovered === undefined) {
      throw new Error(
        `plugin introuvable : ${entry.pluginId} (chemins explores : ${this.config.pluginPaths.join(", ")})`,
      );
    }

    const secrets: Record<string, string> = {};
    for (const [name, variable] of Object.entries(entry.secretsFromEnv ?? {})) {
      const value = process.env[variable];
      if (value !== undefined) secrets[name] = value;
    }

    const loaded = await this.plugins.load(discovered, {
      sourceId: entry.sourceId,
      config: entry.config,
      ...(entry.grant === undefined ? {} : { grant: entry.grant }),
      secrets,
    });

    await this.repository.registerSource({
      sourceId: loaded.sourceId,
      pluginId: discovered.manifest.id,
      pluginVersion: discovered.manifest.version,
      apiVersion: discovered.manifest.apiVersion,
      displayName: discovered.manifest.source?.displayName ?? discovered.manifest.name,
      config: entry.config,
    });

    const state = (await this.repository.getSource(loaded.sourceId))?.state;
    if (state === "quarantined") {
      // L'etat persiste au dela du processus : une quarantaine ne se leve pas
      // en redemarrant, seulement par une action d'exploitation explicite.
      this.plugins.quarantine(loaded.sourceId, "quarantaine persistee");
    }
    return loaded;
  }

  asSourceId(value: string): SourceId {
    return asSourceId(value);
  }

  async close(): Promise<void> {
    await this.plugins.disposeAll();
    await this.driver.close();
    await this.lock?.release();
    this.#eventJournal?.close();
    this.#logSink?.close();
  }
}
