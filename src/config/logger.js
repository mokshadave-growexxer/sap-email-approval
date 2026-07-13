import { createLogger, format, transports } from 'winston';

const level = process.env.NODE_ENV === 'production' ? 'info' : 'debug';

const logger = createLogger({
  level,
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.splat(),
    format.metadata({ fillExcept: ['message', 'level', 'timestamp', 'label'] }),
    format.printf(({ timestamp, level, message, stack, metadata }) => {
      const base = `${timestamp} [${level}] ${message}`;
      const detail = stack || (Object.keys(metadata).length ? JSON.stringify(metadata) : '');
      return detail ? `${base} ${detail}` : base;
    })
  ),
  transports: [
    new transports.Console({
      format: format.combine(format.colorize({ all: true }))
    })
  ],
  exitOnError: false,
});

export default logger;
