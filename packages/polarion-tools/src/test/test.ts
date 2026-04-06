import { expect } from "@std/expect";
import {
  afterEach,
  beforeEach,
  describe,
  it as test,
} from "@std/testing/bdd";

type AnyFn = (...args: any[]) => any;

type MockCall = {
  args: unknown[];
};

export type Spy<F extends AnyFn> = {
  calls: MockCall[];
  mockReset(): void;
  mockResolvedValueOnce(value: Awaited<ReturnType<F>>): void;
  restore(): void;
};

const activeSpies = new Set<Spy<AnyFn>>();

export function spyOn<T extends object, K extends keyof T & string>(
  target: T,
  method: K,
): Spy<Extract<T[K], AnyFn>> {
  const original = target[method];
  if (typeof original !== "function") {
    throw new Error(`Cannot spy on non-function property: ${String(method)}`);
  }

  const calls: MockCall[] = [];
  const queue: unknown[] = [];

  function replacement(this: unknown, ...args: unknown[]) {
    calls.push({ args });
    if (queue.length > 0) {
      return Promise.resolve(queue.shift());
    }
    return Reflect.apply(original as AnyFn, this, args);
  }

  (target as Record<string, unknown>)[method] = replacement;

  const spy: Spy<Extract<T[K], AnyFn>> = {
    calls,
    mockReset() {
      calls.length = 0;
      queue.length = 0;
    },
    mockResolvedValueOnce(value) {
      queue.push(value);
    },
    restore() {
      (target as Record<string, unknown>)[method] = original;
      activeSpies.delete(spy as Spy<AnyFn>);
    },
  };

  activeSpies.add(spy as Spy<AnyFn>);
  return spy;
}

export function restoreAllSpies() {
  for (const spy of [...activeSpies]) {
    spy.restore();
  }
}

export function expectCalledWith(
  spy: Spy<AnyFn>,
  ...expectedArgs: unknown[]
) {
  const matched = spy.calls.some((call) => {
    try {
      expect(call.args).toEqual(expectedArgs);
      return true;
    } catch {
      return false;
    }
  });

  expect(matched).toBe(true);
}

export const vi = {
  spyOn,
  restoreAllMocks: restoreAllSpies,
};

export {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
};
