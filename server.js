import app from './src/app.js';
import { config, logger } from './src/config/index.js';

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception detected', {
    message: error.message,
    stack: error.stack,
  });
  process.exit(1);
});

const server = app.listen(config.port, () => {
  logger.info(`Server listening on port ${config.port}`);
  logger.info(`Environment: ${config.nodeEnv}`);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection detected', { reason });
  server.close(() => process.exit(1));
});
