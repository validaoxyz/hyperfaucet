import { WebSocketServer } from 'ws';

export const FAUCET_WEBSOCKET_MAX_PAYLOAD = 64 * 1024;

export function createFaucetWebSocketServer(): WebSocketServer {
  return new WebSocketServer({
    noServer: true,
    maxPayload: FAUCET_WEBSOCKET_MAX_PAYLOAD,
  });
}
