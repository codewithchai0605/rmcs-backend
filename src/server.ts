import uWS from "uWebSockets";
import { env } from "./config/env";
import { logger } from "./core/logger";
import { bindApp } from "./ws/publish";
import { onClose, onMessage, onOpen, onUpgrade } from "./ws/connection";
import { registerHttpRoutes } from "./http/routes";
import type { SocketUserData } from "./ws/types";

export interface StartedServer {
  app: uWS.TemplatedApp;
  stop: () => void;
}

export async function startServer(): Promise<StartedServer> {
  const useSsl = Boolean(env.SSL_KEY_FILE && env.SSL_CERT_FILE);

  const app = useSsl
    ? uWS.SSLApp({ key_file_name: env.SSL_KEY_FILE, cert_file_name: env.SSL_CERT_FILE })
    : uWS.App();

  bindApp(app);

  app.ws<SocketUserData>("/ws", {
    maxPayloadLength: env.WS_MAX_PAYLOAD_BYTES,
    idleTimeout: env.WS_IDLE_TIMEOUT_S,
    maxBackpressure: env.WS_MAX_BACKPRESSURE_BYTES,
    closeOnBackpressureLimit: false,
    compression: uWS.SHARED_COMPRESSOR,
    sendPingsAutomatically: true,
    upgrade: onUpgrade,
    open: onOpen,
    message: onMessage,
    close: onClose,
  });

  registerHttpRoutes(app);

  const listenSocket = await new Promise<unknown>((resolve, reject) => {
    app.listen(env.HOST, env.PORT, (token) => {
      if (token) {
        resolve(token);
      } else {
        reject(new Error(`Failed to listen on ${env.HOST}:${env.PORT}`));
      }
    });
  });

  logger.info("Server listening", { host: env.HOST, port: env.PORT, ssl: useSsl });

  const stop = (): void => {
    if (listenSocket) {
      uWS.us_listen_socket_close(listenSocket as uWS.us_listen_socket);
    }
  };

  return { app, stop };
}
