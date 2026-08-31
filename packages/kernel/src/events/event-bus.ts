/**
 * Event Bus — Volume II, chapitre 4.
 *
 * Aucun composant ne communique directement avec un autre. Tous les messages
 * passent par le bus. Le decouplage n'est pas une elegance : c'est ce qui
 * permet d'ajouter un consommateur (metriques, webhooks, indexation) sans
 * modifier une ligne du producteur.
 *
 * Un plugin n'emet jamais d'evenement (Vol. III, 1.2, interdit n. 3) : un
 * evenement est un fait constate par le Kernel, pas une declaration de la source.
 */
import { toIsoTimestamp, ulid, type RunId, type SourceId } from "../domain/ids.js";
import {
  EVENT_SPEC_VERSION,
  type DomainEvent,
  type EventMap,
  type EventType,
  type TypedEvent,
} from "../domain/events.js";

export type EventHandler<T extends EventType = EventType> = (
  event: TypedEvent<T>,
) => void | Promise<void>;

export interface Subscription {
  readonly id: string;
  readonly pattern: string;
  unsubscribe(): void;
}

export interface EventFilter {
  /** Type exact, ou motif prefixe termine par `.*`, ou `*`. */
  readonly type?: string;
  readonly sourceId?: SourceId;
  readonly runId?: RunId;
  readonly since?: string;
  readonly limit?: number;
}

/**
 * Journal des evenements. Rend possible le rejeu de l'etape E11 apres une
 * panne survenue entre le COMMIT et l'emission (Volume IV, 5.2).
 */
export interface EventJournal {
  append(event: DomainEvent): Promise<void>;
  list(filter?: EventFilter): Promise<DomainEvent[]>;
}

export interface EventBus {
  subscribe<T extends EventType>(pattern: T | string, handler: EventHandler<T>): Subscription;
  unsubscribe(subscription: Subscription): void;
  publish<T extends EventType>(event: TypedEvent<T>): Promise<void>;
  publishAll(events: readonly DomainEvent[]): Promise<void>;
  getEventHistory(filter?: EventFilter): Promise<DomainEvent[]>;
}

export interface EventOrigin {
  readonly sourceId?: SourceId;
  readonly runId?: RunId;
  readonly at?: Date | number;
}

/**
 * Fabrique l'enveloppe commune. L'identifiant est un ULID : stable, trie par le
 * temps, et suffisant pour rendre un consommateur idempotent — ce que la
 * livraison « au moins une fois » exige de lui (ADR-305).
 */
export function createEvent<T extends EventType>(
  type: T,
  data: EventMap[T],
  origin: EventOrigin = {},
): TypedEvent<T> {
  const at = origin.at ?? Date.now();
  const millis = typeof at === "number" ? at : at.getTime();
  return {
    specVersion: EVENT_SPEC_VERSION,
    id: ulid(millis),
    type,
    source: origin.sourceId === undefined ? "lcf://kernel" : `lcf://kernel/${origin.sourceId}`,
    time: toIsoTimestamp(millis),
    ...(origin.runId === undefined ? {} : { runId: origin.runId }),
    data,
  };
}

/** `*` accepte tout ; `lcf.document.*` accepte un prefixe ; sinon egalite stricte. */
export function matchesPattern(pattern: string, type: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return type.startsWith(pattern.slice(0, -1));
  return pattern === type;
}

export function matchesFilter(event: DomainEvent, filter: EventFilter | undefined): boolean {
  if (filter === undefined) return true;
  if (filter.type !== undefined && !matchesPattern(filter.type, event.type)) return false;
  if (filter.since !== undefined && event.time <= filter.since) return false;
  if (filter.runId !== undefined && event.runId !== filter.runId) return false;
  if (filter.sourceId !== undefined && !event.source.endsWith(`/${filter.sourceId}`)) return false;
  return true;
}
