using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .mainWorker),
  ],
  sockets = [
    (name = "http", address = "*:8080", http = (), service = "main"),
  ],
);

const mainWorker :Workerd.Worker = (
  modules = [
    (name = "index.js", esModule = embed "dist/index.js"),
  ],
  compatibilityDate = "2026-07-02",
  compatibilityFlags = ["nodejs_compat"],
  bindings = [
    (name = "POLARION_BASE_URL", fromEnvironment = "POLARION_BASE_URL"),
    (name = "POLARION_GUIDELINES", fromEnvironment = "POLARION_GUIDELINES"),
    (name = "REST_PAGE_SIZE", fromEnvironment = "REST_PAGE_SIZE"),
    (name = "FETCH_CONCURRENCY_COUNT", fromEnvironment = "FETCH_CONCURRENCY_COUNT"),
    (name = "READ_ATTACHMENT_INLINE_RESULT_MAX_BYTES", fromEnvironment = "READ_ATTACHMENT_INLINE_RESULT_MAX_BYTES"),
    (name = "LOADER", workerLoader = ()),
  ],
);
