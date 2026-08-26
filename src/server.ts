import { env } from "./config/env";
import { logger } from "./utils/logger";
import { bindApp } from "./websocket/publish";
import { handleGameUpgrade, onOpen, onMessage, onClose } from "./websocket/connection";
import { handleAdminUpgrade, onAdminOpen, onAdminMessage, onAdminClose } from "./websocket/admin.live";
import { buildAppRoutes, notFoundFallback } from "./http/routes";
import type { AnySocketData, AdminWebSocket, AppWebSocket, App } from "./websocket/types";

export interface StartedServer {
  app: App;
  stop: () => void;
}

export async function startServer(): Promise<StartedServer> {
  const useSsl = Boolean(env.SSL_KEY_FILE && env.SSL_CERT_FILE);

  const server: App = Bun.serve<AnySocketData>({
    hostname: env.HOST,
    port: env.PORT,
    routes: {
      "/ws": (req: Request, srv: App) => handleGameUpgrade(req, srv),
      // The native Tauri admin app connects with the access token in the
      // Authorization header. Keeping it out of the URL avoids token
      // leakage through logs.
      "/admin/ws": (req: Request, srv: App) => handleAdminUpgrade(req, srv),
      ...buildAppRoutes(),
      "/*": () => notFoundFallback(),
    },

    // Shared by both /ws (game) and /admin/ws (admin) sockets - Bun.serve()
    // only accepts a single websocket config per server, unlike uWS's
    // app.ws(pattern, behavior), which let each path register its own. The
    // two previously differed only in maxPayloadLength (env-configured vs a
    // hardcoded 1024) and compression (shared vs disabled): the payload cap
    // isn't a concern here since /admin/ws is server-push-only (see
    // websocket/admin.live.ts, onAdminMessage is a no-op), and compression is
    // skipped per-message for admin frames via ws.send(data, false) instead
    // of a config-level toggle.
    websocket: {
      maxPayloadLength: env.WS_MAX_PAYLOAD_BYTES,
      // Bun auto-pings roughly every idleTimeout/2 seconds and force-closes
      // the socket if nothing (including a pong) comes back within
      // idleTimeout - kept fairly tight so other players find out someone
      // dropped promptly, without being so aggressive that a brief
      // mobile-network blip trips it.
      idleTimeout: env.WS_IDLE_TIMEOUT_S,
      backpressureLimit: env.WS_MAX_BACKPRESSURE_BYTES,
      closeOnBackpressureLimit: false,
      perMessageDeflate: { compress: "shared", decompress: "shared" },
      sendPings: true,
      open(ws) {
        if (ws.data.kind === "admin") onAdminOpen(ws as AdminWebSocket);
        else onOpen(ws as AppWebSocket);
      },
      message(ws, message) {
        if (ws.data.kind === "admin") onAdminMessage(ws as AdminWebSocket, message);
        else onMessage(ws as AppWebSocket, message);
      },
      close(ws) {
        if (ws.data.kind === "admin") onAdminClose(ws as AdminWebSocket);
        else onClose(ws as AppWebSocket);
      },
    },
  });

  bindApp(server);
  logger.info("Server listening", { host: env.HOST, port: env.PORT, ssl: useSsl });

  const stop = (): void => {
    server.stop();
  };

  return { app: server, stop };
}
