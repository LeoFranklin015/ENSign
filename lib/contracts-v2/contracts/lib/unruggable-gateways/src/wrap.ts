export type Unwrappable<P, T> = T | Wrapped<P, T>;

export function unwrap<P, T>(x: Unwrappable<P, T>) {
  return x instanceof Wrapped ? x.get() : x;
}

export class Wrapped<P, T> {
  private value: Promise<T> | undefined;
  constructor(
    readonly payload: P,
    private init: () => Promise<T>
  ) {}
  get() {
    if (!this.value) {
      this.value = this.init();
    }
    return this.value;
  }
}
