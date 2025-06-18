// src/services/websocket.ts
import { WebSocketServer, WebSocket } from "ws";
import { logger } from "../utils/logger";
import { Deposit, Withdrawal, AccountModel } from "../db/models";

interface WebSocketMessage {
  type: "subscribe" | "unsubscribe" | "deposit_update" | "withdrawal_update" | "confirmation" | "error";
  data: any;
}

export class WebSocketService {
  private static wss: WebSocketServer;
  private static clients: Map<WebSocket, Set<string>> = new Map(); // Map of client to subscribed usernames

  static initialize(port: number) {
    this.wss = new WebSocketServer({ port });
    logger.info(`WebSocket server started on port ${port}`);

    this.wss.on("connection", (ws: WebSocket) => {
      logger.debug("New WebSocket client connected");
      this.clients.set(ws, new Set());

      ws.on("message", async (message: string) => {
        try {
          const parsed: WebSocketMessage = JSON.parse(message);

          if (parsed.type === "subscribe" && typeof parsed.data.username === "string") {
            const username = parsed.data.username;
            // Validate username exists in the database
            const account = await AccountModel.findByUsername(username);
            if (!account) {
              throw new Error(`Username ${username} does not exist`);
            }
            this.clients.get(ws)!.add(username);
            logger.debug(`Client subscribed to username: ${username}`);
            // Send confirmation to client
            ws.send(
              JSON.stringify({
                type: "confirmation",
                data: { message: `Subscribed to username: ${username}` },
              })
            );
          } else if (parsed.type === "unsubscribe" && typeof parsed.data.username === "string") {
            const username = parsed.data.username;
            this.clients.get(ws)!.delete(username);
            logger.debug(`Client unsubscribed from username: ${username}`);
            // Send confirmation to client
            ws.send(
              JSON.stringify({
                type: "confirmation",
                data: { message: `Unsubscribed from username: ${username}` },
              })
            );
          } else {
            throw new Error(`Invalid message type or missing username: ${parsed.type}`);
          }
        } catch (err: any) {
          logger.error(`Error processing WebSocket message: ${err.message}`);
          // Send error message to client
          ws.send(
            JSON.stringify({
              type: "error",
              data: { message: `Invalid message: ${err.message}` },
            })
          );
        }
      });

      ws.on("close", () => {
        this.clients.delete(ws);
        logger.debug("WebSocket client disconnected");
      });

      ws.on("error", (err) => {
        logger.error(`WebSocket client error: ${err.message}`);
      });
    });

    this.wss.on("error", (err) => {
      logger.error(`WebSocket server error: ${err.message}`);
    });
  }

  static broadcast(message: WebSocketMessage) {
    if (message.type === "deposit_update" || message.type === "withdrawal_update") {
      const data = message.data as Deposit | Withdrawal;
      const username = data.username;
      this.clients.forEach((subscribedUsernames, ws) => {
        if (ws.readyState === WebSocket.OPEN && subscribedUsernames.has(username)) {
          ws.send(JSON.stringify(message));
        }
      });
    }
  }
}

export const webSocketService = WebSocketService;