declare module "@jsquash/png/codec/pkg/squoosh_png_bg.wasm" {
  const value: WebAssembly.Module;
  export default value;
}

declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: () => R): R;
    getStore(): T | undefined;
  }
}
