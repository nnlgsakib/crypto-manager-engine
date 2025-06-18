// src/app.ts
import express from 'express';
import accountRoutes from './api/routes/account';
import balanceRoutes from './api/routes/balance';
import depositRoutes from './api/routes/deposit';
import withdrawalRoutes from './api/routes/withdrawal';
import { logger } from './utils/logger';
import { WebSocketService } from './services/websocket';

const app = express();

app.use(express.json());
app.use('/api', accountRoutes);
app.use('/api', balanceRoutes);
app.use('/api', depositRoutes);
app.use('/api', withdrawalRoutes);
WebSocketService.initialize(8081);

app.use(
  (
    err: any,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    logger.error(`Unhandled error: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
);

export default app;
