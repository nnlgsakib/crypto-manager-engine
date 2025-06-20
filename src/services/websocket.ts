import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '../utils/logger';
import { Deposit, Withdrawal, AccountModel } from '../db/models';

interface WebSocketMessage {
  type:
    | 'subscribe'
    | 'unsubscribe'
    | 'deposit_update'
    | 'withdrawal_update'
    | 'balance_update'
    | 'transfer_update'
    | 'confirmation'
    | 'error';
  data: any;
}

interface Subscription {
  type: 'deposit' | 'withdrawal' | 'balance' | 'transfer';
  username: string;
  filters?: {
    blockchain?: string;
    currency?: string;
    status?: string;
  };
}

export class WebSocketService {
  private static wss: WebSocketServer;
  private static clients: Map<WebSocket, Set<string>> = new Map(); // Map of client to subscribed usernames (legacy)
  private static subscriptions: Map<WebSocket, Set<Subscription>> = new Map(); // Map of client to detailed subscriptions

  static initialize(port: number) {
    this.wss = new WebSocketServer({ port });
    logger.info(`WebSocket server started on port ${port}`);

    this.wss.on('connection', (ws: WebSocket) => {
      logger.debug('New WebSocket client connected');
      this.clients.set(ws, new Set());
      this.subscriptions.set(ws, new Set());

      ws.on('message', async (message: string) => {
        try {
          const parsed: WebSocketMessage = JSON.parse(message);

          if (parsed.type === 'subscribe') {
            const { username, subscriptionType, filters } = parsed.data;
            if (!username || typeof username !== 'string') {
              throw new Error('Username is required and must be a string');
            }
            const account = await AccountModel.findByUsername(username);
            if (!account) {
              throw new Error(`Username ${username} does not exist`);
            }

            if (!subscriptionType) {
              // Legacy subscription (all updates for username)
              this.clients.get(ws)!.add(username);
              logger.debug(
                `Client subscribed to username: ${username} (legacy)`
              );
              ws.send(
                JSON.stringify({
                  type: 'confirmation',
                  data: { message: `Subscribed to username: ${username}` },
                })
              );
            } else {
              // Modern subscription with type and filters
              if (
                !['deposit', 'withdrawal', 'balance', 'transfer'].includes(
                  subscriptionType
                )
              ) {
                throw new Error(
                  `Invalid subscription type: ${subscriptionType}`
                );
              }
              const subscription: Subscription = {
                type: subscriptionType,
                username,
                filters: filters
                  ? {
                      blockchain: filters.blockchain,
                      currency: filters.currency,
                      status: filters.status,
                    }
                  : undefined,
              };
              this.subscriptions.get(ws)!.add(subscription);
              logger.debug(
                `Client subscribed to ${subscriptionType} for username: ${username}, filters: ${JSON.stringify(filters || {})}`
              );
              ws.send(
                JSON.stringify({
                  type: 'confirmation',
                  data: {
                    message: `Subscribed to ${subscriptionType} for username: ${username}`,
                  },
                })
              );
            }
          } else if (parsed.type === 'unsubscribe') {
            const { username, subscriptionType, filters } = parsed.data;
            if (!username || typeof username !== 'string') {
              throw new Error('Username is required and must be a string');
            }

            if (!subscriptionType) {
              // Legacy unsubscription
              this.clients.get(ws)!.delete(username);
              logger.debug(
                `Client unsubscribed from username: ${username} (legacy)`
              );
              ws.send(
                JSON.stringify({
                  type: 'confirmation',
                  data: { message: `Unsubscribed from username: ${username}` },
                })
              );
            } else {
              // Modern unsubscription
              const subscription: Subscription = {
                type: subscriptionType,
                username,
                filters: filters
                  ? {
                      blockchain: filters.blockchain,
                      currency: filters.currency,
                      status: filters.status,
                    }
                  : undefined,
              };
              this.subscriptions.get(ws)!.delete(subscription);
              logger.debug(
                `Client unsubscribed from ${subscriptionType} for username: ${username}, filters: ${JSON.stringify(filters || {})}`
              );
              ws.send(
                JSON.stringify({
                  type: 'confirmation',
                  data: {
                    message: `Unsubscribed from ${subscriptionType} for username: ${username}`,
                  },
                })
              );
            }
          } else {
            throw new Error(
              `Invalid message type or missing username: ${parsed.type}`
            );
          }
        } catch (err: any) {
          logger.error(`Error processing WebSocket message: ${err.message}`);
          ws.send(
            JSON.stringify({
              type: 'error',
              data: { message: `Invalid message: ${err.message}` },
            })
          );
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        this.subscriptions.delete(ws);
        logger.debug('WebSocket client disconnected');
      });

      ws.on('error', err => {
        logger.error(`WebSocket client error: ${err.message}`);
      });
    });

    this.wss.on('error', err => {
      logger.error(`WebSocket server error: ${err.message}`);
    });
  }

  static broadcast(message: WebSocketMessage) {
    if (
      ![
        'deposit_update',
        'withdrawal_update',
        'balance_update',
        'transfer_update',
      ].includes(message.type)
    ) {
      return;
    }

    const data = message.data;
    const username =
      data.username ||
      (message.type === 'transfer_update'
        ? [data.senderUsername, data.recipientUsername]
        : null);

    this.clients.forEach((subscribedUsernames, ws) => {
      if (ws.readyState === WebSocket.OPEN && username) {
        if (Array.isArray(username)) {
          if (username.some(u => subscribedUsernames.has(u))) {
            ws.send(JSON.stringify(message));
          }
        } else if (subscribedUsernames.has(username)) {
          ws.send(JSON.stringify(message));
        }
      }
    });

    this.subscriptions.forEach((subscriptions, ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        subscriptions.forEach(sub => {
          if (
            (message.type === `${sub.type}_update` ||
              (message.type === 'deposit_update' && sub.type === 'deposit') ||
              (message.type === 'withdrawal_update' &&
                sub.type === 'withdrawal') ||
              (message.type === 'balance_update' && sub.type === 'balance') ||
              (message.type === 'transfer_update' &&
                sub.type === 'transfer')) &&
            (Array.isArray(username)
              ? username.includes(sub.username)
              : sub.username === username)
          ) {
            let shouldSend = true;
            if (sub.filters) {
              if (
                sub.filters.blockchain &&
                data.blockchain !== sub.filters.blockchain
              ) {
                shouldSend = false;
              }
              if (
                sub.filters.currency &&
                data.currency !== sub.filters.currency
              ) {
                shouldSend = false;
              }
              if (sub.filters.status && data.status !== sub.filters.status) {
                shouldSend = false;
              }
            }
            if (shouldSend) {
              ws.send(JSON.stringify(message));
            }
          }
        });
      }
    });
  }
}

export const webSocketService = WebSocketService;
