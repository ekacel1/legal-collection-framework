/**
 * Horloge — Volume III, 2.5.
 *
 * L'horloge est une dependance injectee, jamais un appel direct a Date.now().
 * Sans cela, aucune logique datee n'est testable de maniere reproductible.
 */
import type { Clock } from "./contract.js";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  nowMillis(): number {
    return Date.now();
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(signal.reason instanceof Error ? signal.reason : new Error("annule"));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal?.reason instanceof Error ? signal.reason : new Error("annule"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export interface ManualClockOptions {
  /**
   * Une attente fait avancer le temps au lieu de bloquer.
   *
   * C'est le mode a employer des qu'un composant du Kernel attend de lui-meme
   * (politesse reseau, repli exponentiel) : sans lui, le test se fige en
   * attendant une avance que personne ne declenche, et Node conclut a tort a
   * un blocage. Le temps simule reste exact — seule son avance est immediate.
   */
  readonly autoAdvance?: boolean;
}

/**
 * Horloge deterministe pour les tests : le temps n'avance que si on l'avance,
 * ou tout seul en mode `autoAdvance`. Les attentes sont resolues sans delai
 * reel, ce qui rend les tests de retry instantanes tout en verifiant les
 * durees calculees.
 */
export class ManualClock implements Clock {
  #millis: number;
  #pending: { at: number; resolve: () => void; reject: (e: Error) => void }[] = [];
  readonly #autoAdvance: boolean;

  constructor(start: Date | number = 0, options: ManualClockOptions = {}) {
    this.#millis = typeof start === "number" ? start : start.getTime();
    this.#autoAdvance = options.autoAdvance ?? false;
  }

  now(): Date {
    return new Date(this.#millis);
  }

  nowMillis(): number {
    return this.#millis;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    if (signal?.aborted === true) {
      return Promise.reject(
        signal.reason instanceof Error ? signal.reason : new Error("annule"),
      );
    }
    if (this.#autoAdvance) {
      this.advance(ms);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const entry = { at: this.#millis + ms, resolve, reject };
      this.#pending.push(entry);
      signal?.addEventListener(
        "abort",
        () => {
          this.#pending = this.#pending.filter((p) => p !== entry);
          reject(signal.reason instanceof Error ? signal.reason : new Error("annule"));
        },
        { once: true },
      );
    });
  }

  /** Avance le temps et resout toutes les attentes echues, dans l'ordre. */
  advance(ms: number): void {
    this.#millis += ms;
    const due = this.#pending.filter((p) => p.at <= this.#millis).sort((a, b) => a.at - b.at);
    this.#pending = this.#pending.filter((p) => p.at > this.#millis);
    for (const entry of due) entry.resolve();
  }

  /** Nombre d'attentes en cours : utile pour verifier qu'aucune ne fuit. */
  get pendingSleeps(): number {
    return this.#pending.length;
  }
}
