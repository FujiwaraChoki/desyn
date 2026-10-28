/** Minimal typed event emitter (listeners run synchronously, in registration order). */
export class Emitter<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<(value: never) => void>>();

  on<K extends keyof Events>(event: K, listener: (value: Events[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as (value: never) => void);
    return () => {
      set?.delete(listener as (value: never) => void);
    };
  }

  emit<K extends keyof Events>(event: K, value: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) (listener as (value: Events[K]) => void)(value);
  }

  clear(): void {
    this.listeners.clear();
  }
}
