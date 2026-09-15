import http from 'node:http';
import app from './src/app.js';
import { config } from './src/config/index.js';
import logger from './src/config/logger.js';
import { queueWorker } from './src/services/queue/queueWorker.js';
import { createDigestScheduler } from './src/services/digest/digestScheduler.js';
import { runDigestAllCompanies } from './src/services/digest/digestService.js';

// One scheduler per approval stage: each fires at its own IST time and sends only
// the SOs currently awaiting that stage's approver.
const digestSchedulers = config.digest.stageSchedules.map((stageSchedule) =>
  createDigestScheduler({
    hour: stageSchedule.hour,
    minute: stageSchedule.minute,
    runFn: () => runDigestAllCompanies({ stageFilter: stageSchedule.stage }),
  })
);

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception detected', {
    message: error.message,
    stack: error.stack,
  });
  process.exit(1);
});

let server;

// Plain HTTP only. HTTPS/TLS is terminated by the hosting front end (IIS), which
// binds the certificate and forwards requests here. `app` sets `trust proxy`, so
// the real client IP is read from the proxy's X-Forwarded-For header.
const startServer = () => {
  server = http.createServer(app);

  // iisnode supplies a named pipe in process.env.PORT; a standalone/reverse-proxy
  // deployment supplies a numeric port (bound to config.host).
  const target = process.env.PORT || config.port || 3000;
  const numericPort = Number(target);
  const isNamedPipe = Number.isNaN(numericPort);

  const onListening = () => {
    logger.info(`Server listening on ${isNamedPipe ? String(target) : `${config.host}:${numericPort}`}`);
    logger.info(`Environment: ${config.nodeEnv}`);
  };

  if (isNamedPipe) {
    server.listen(target, onListening);
  } else {
    server.listen(numericPort, config.host, onListening);
  }

  queueWorker.start();
  digestSchedulers.forEach((scheduler) => scheduler.start());

  server.on('error', (error) => {
    logger.error('Server failed to start', {
      message: error.message,
      stack: error.stack,
    });
    process.exit(1);
  });
};

startServer();

process.on('SIGINT', () => {
  queueWorker.stop();
  digestSchedulers.forEach((scheduler) => scheduler.stop());
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
