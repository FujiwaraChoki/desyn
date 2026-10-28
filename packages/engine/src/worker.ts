// Dedicated worker entry: one EngineHost served over the typed RPC. Create it with
// `new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })` (EngineClient does this).
import { ENGINE_WORKER_METHODS, EngineHost } from "./host";
import type { EngineEvents } from "./protocol";
import { type Endpoint, exposeRpc } from "./rpc";

const scope = globalThis as unknown as Endpoint;
let server: ReturnType<typeof exposeRpc<EngineEvents>> | null = null;
const host = new EngineHost((event, value, transferables) =>
  server?.emit(event, value, transferables),
);
server = exposeRpc<EngineEvents>(host, scope, ENGINE_WORKER_METHODS);
