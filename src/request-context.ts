import { AsyncLocalStorage } from "node:async_hooks";

const polarionAccessTokenStorage = new AsyncLocalStorage<string | undefined>();

export function runWithPolarionAccessToken<T>(
  token: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return polarionAccessTokenStorage.run(token, fn);
}

export function getPolarionAccessToken(): string | undefined {
  return polarionAccessTokenStorage.getStore();
}
