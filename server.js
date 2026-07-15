import app from './src/app.js';
import { config } from './src/config/index.js';
import logger from './src/config/logger.js';
import { queueWorker } from './src/services/queue/queueWorker.js';

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception detected', {
    message: error.message,
    stack: error.stack,
  });
  process.exit(1);
});

let server;

const startServer = (port) => {
  server = app.listen(port, () => {
    logger.info(`Server listening on port ${port}`);
    logger.info(`Environment: ${config.nodeEnv}`);
  });

  queueWorker.start();

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      logger.warn(`Port ${port} is already in use, trying ${port + 1}`);
      queueWorker.stop();
      startServer(port + 1);
      return;
    }

    logger.error('Server failed to start', {
      message: error.message,
      stack: error.stack,
    });
    process.exit(1);
  });
};

startServer(Number(process.env.PORT || config.port || 3000));

process.on('SIGINT', () => {
  queueWorker.stop();
  if (server) {
    server.close(() => process.exit(0));
  } else {
    process.exit(0);
  }
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection detected', { reason });
  if (server) {
    server.close(() => process.exit(1));
  } else {
    process.exit(1);
  }
});
