// Promise.try landed in V8 12.8 / Node 24. We target Node 22, and unpdf's
// bundled PDF.js calls it unconditionally. Polyfill to the TC39 spec shape.
// Remove once the minimum Node version is bumped to 24.
declare global {
  interface PromiseConstructor {
    try<T, Args extends readonly unknown[]>(
      fn: (...args: Args) => T | PromiseLike<T>,
      ...args: Args
    ): Promise<Awaited<T>>;
  }
}

if (typeof (Promise as { try?: unknown }).try !== "function") {
  (Promise as unknown as { try: unknown }).try = function tryPolyfill<
    T,
    Args extends readonly unknown[],
  >(fn: (...args: Args) => T | PromiseLike<T>, ...args: Args): Promise<T> {
    return new Promise<T>((resolve) => resolve(fn(...args)));
  };
}

export {};
