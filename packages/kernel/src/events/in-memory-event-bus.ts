/**
 * Event Bus en memoire — Volume II, chapitre 4.
 *
 * Deux garanties structurent l'implementation :
 *
 * 1. L'echec d'un abonne n'interrompt jamais la publication ni les autres
 *    abonnes. Le principe d'isolement du Volume II, chapitre 11 (« erreur
 *    plugin n'est pas erreur Kernel ») serait sinon viole a chaque emission.
 * 2. Les abonnes sont appeles dans leur ordre d'inscription, sequentiellement.
 *    Un ordre non deterministe rendrait les tests d'integration instables sans
 *    rien apporter : le bus n'est pas un chemin de performance.
 */
import { ulid } from "../domain/ids.js";
import type { DomainEvent, EventType, TypedEvent } from "../domain/events.js";
import { describeUnknown } from "../domain/errors.js";
import type { Logger } from "../domain/contract.js";
import {
  matchesFilter,
  matchesPattern,
  type EventBus,
  type EventFilter,
  type EventHandler,
  type EventJournal,
  type Subscription,
} from "./event-bus.js";

interface Registration {
  readonly id: string;
  readonly pattern: string;
  readonly handler: EventHandler<EventType>;
}

export interface HandlerFailure {
  readonly subscriptionId: string;
  readonly event: DomainEvent;
  readonly error: unknown;
}

export interface InMemoryEventBusOptions {
  readonly journal?: EventJournal;
  readonly logger?: Logger;
  /** Rapporte les echecs d'abonnes sans les propager a l'emetteur. */
  readonly onHandlerError?: (failure: HandlerFailure) => void;
}

export class InMemoryEventBus implements EventBus {
  readonly #registrations: Registration[] = [];
  readonly #journal: EventJournal;
  readonly #logger: Logger | undefined;
  readonly #onHandlerError: ((failure: HandlerFailure) => void) | undefined;

  constructor(options: InMemoryEventBusOptions = {}) {
    this.#journal = options.journal ?? new RingBufferEventJournal();
    this.#logger = options.logger;
    this.#onHandlerError = options.onHandlerError;
  }

  subscribe<T extends EventType>(pattern: T | string, handler: EventHandler<T>): Subscription {
    const registration: Registration = {
      id: ulid(),
      pattern,
      handler: handler as EventHandler<EventType>,
    };
    this.#registrations.push(registration);

    const subscription: Subscription = {
      id: registration.id,
      pattern,
      unsubscribe: () => this.unsubscribe(subscription),
    };
    return subscription;
  }

  unsubscribe(subscription: Subscription): void {
    const index = this.#registrations.findIndex((entry) => entry.id === subscription.id);
    if (index >= 0) this.#registrations.splice(index, 1);
  }

  async publish<T extends EventType>(event: TypedEvent<T>): Promise<void> {
    // Le journal precede la diffusion : un evenement non distribue reste
    // rejouable, alors qu'un evenement non journalise est perdu sans trace.
    await this.#journal.append(event);

    for (const registration of [...this.#registrations]) {
      if (!matchesPattern(registration.pattern, event.type)) continue;
      try {
        await registration.handler(event as TypedEvent<EventType>);
      } catch (error) {
        this.#logger?.error("abonne en echec", {
          subscriptionId: registration.id,
          eventType: event.type,
          error: describeUnknown(error),
        });
        this.#onHandlerError?.({ subscriptionId: registration.id, event, error });
      }
    }
  }

  async publishAll(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      await this.publish(event as TypedEvent<EventType>);
    }
  }

  async getEventHistory(filter?: EventFilter): Promise<DomainEvent[]> {
    return this.#journal.list(filter);
  }

  get subscriberCount(): number {
    return this.#registrations.length;
  }
}

/**
 * Journal borne en memoire.
 *
 * Suffisant pour le rejeu de fin d'execution et l'observation locale. Un
 * journal durable relevera du Volume VII (observabilite) ; il n'est pas
 * introduit ici, car le schema du Volume IV ne comporte volontairement aucune
 * table d'evenements et l'inventer serait une decision de noyau.
 */
export class RingBufferEventJournal implements EventJournal {
  readonly #capacity: number;
  #events: DomainEvent[] = [];

  constructor(capacity = 10_000) {
    this.#capacity = capacity;
  }

  async append(event: DomainEvent): Promise<void> {
    this.#events.push(event);
    if (this.#events.length > this.#capacity) {
      this.#events = this.#events.slice(this.#events.length - this.#capacity);
    }
  }

  async list(filter?: EventFilter): Promise<DomainEvent[]> {
    const matching = this.#events.filter((event) => matchesFilter(event, filter));
    const limit = filter?.limit;
    return limit === undefined ? matching : matching.slice(-limit);
  }

  get size(): number {
    return this.#events.length;
  }
}
