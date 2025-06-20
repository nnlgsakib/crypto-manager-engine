// src/server.ts
import app from './app';
import { logger } from './utils/logger';

const PORT = process.env.PORT || 8484;

app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});
