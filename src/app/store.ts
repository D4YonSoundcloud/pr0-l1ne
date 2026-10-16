/**
 * A small state store: one state object, changed only through named
 * actions, with listeners told about every change.
 *
 * State is replaced, never changed in place: an action produces a new state
 * object from the old one, so a listener can compare `state` with
 * `previous` to see what changed.
 */

export type Listener<S> = (state: Readonly<S>, previous: Readonly<S>, action: string) => void;

export class Store<S extends object> {
  private state: Readonly<S>;
  private readonly listeners = new Set<Listener<S>>();

  constructor(initial: S) {
    this.state = initial;
  }

  get(): Readonly<S> {
    return this.state;
  }

  /**
   * Apply a change under an action's name ("setLanguage"). Listeners run
   * after the state is updated, in the order they subscribed. A change that
   * changes nothing tells no one.
   */
  update(action: string, change: Partial<S>): void {
    const previous = this.state;
    const next = { ...previous, ...change };
    if ((Object.keys(change) as (keyof S)[]).every((key) => Object.is(previous[key], next[key]))) return;
    this.state = next;
    for (const listener of [...this.listeners]) listener(next, previous, action);
  }

  /** Listen for every change; returns a function that stops listening. */
  subscribe(listener: Listener<S>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Listen for changes to one part of the state (compared with Object.is). */
  watch<T>(pick: (state: Readonly<S>) => T, listener: (value: T, previous: T, action: string) => void): () => void {
    return this.subscribe((state, previous, action) => {
      const value = pick(state);
      const before = pick(previous);
      if (!Object.is(value, before)) listener(value, before, action);
    });
  }
}
