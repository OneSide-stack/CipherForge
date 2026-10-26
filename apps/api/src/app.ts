import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import helmet from 'helmet';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { config } from './config.js';
import { ApiError } from './lib/errors.js';
import { log } from './lib/logger.js';
import { loadAuth, originGuard } from './middleware/auth.js';
import { memoryLimit } from './services/ratelimit.js';
import { router } from './routes.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ? 1 : false);

  // The platform document may frame same-origin lab targets. Target responses
  // never carry framing/sandbox headers themselves (stripped by the gateway).
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:', 'blob:'],
          'font-src': ["'self'", 'data:'],
          'connect-src': ["'self'", 'ws:', 'wss:'],
          'frame-src': ["'self'"],
          'frame-ancestors': ["'self'"],
          'base-uri': ["'self'"],
          'form-action': ["'self'"],
          'object-src': ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-origin' },
      hsts: config.env === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );
  app.use(compression());
  // Keep the raw bytes: the lab gateway must forward the learner's original
  // form/JSON body to the target service untouched.
  const captureRaw = (req: Request, _res: Response, buf: Buffer) => {
    (req as Request & { rawBody?: Buffer }).rawBody = buf;
  };
  app.use(express.json({ limit: '256kb', verify: captureRaw }));
  app.use(express.urlencoded({ extended: false, limit: '64kb', verify: captureRaw }));
  app.use(cookieParser());
  app.use((req, res, next) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    if (req.path.startsWith('/api/')) res.setHeader('cache-control', 'no-store');
    next();
  });
  // Coarse global rate limit (does not affect static assets).
  app.use('/api/', (req, res, next) => {
    try {
      memoryLimit(`api:${req.ip}`, 900, 60_000);
      next();
    } catch (err) {
      next(err);
    }
  });
  app.use(loadAuth);
  app.use('/api', originGuard);

  app.use('/api', router);

  // ----------------------------------------------------------- static web app
  if (existsSync(config.webDist)) {
    app.use(
      express.static(config.webDist, {
        index: false,
        maxAge: '1h',
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('index.html')) res.setHeader('cache-control', 'no-cache');
        },
      }),
    );
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
      res.sendFile(path.join(config.webDist, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res
        .status(503)
        .type('text/plain')
        .send('CipherForge Academy API is running, but the web client has not been built yet.\nRun: npm run build:web\n');
    });
  }

  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api')) return next(new ApiError(404, 'not_found', 'API route not found'));
    next();
  });
  app.use('/api', (_req, _res, next) => next(new ApiError(404, 'not_found', 'API route not found')));

  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    const apiError = err instanceof ApiError ? err : null;
    const status = apiError?.status ?? 500;
    if (status >= 500) log.error('request failed', { path: req.path, method: req.method, error: err.message });
    if (res.headersSent) return;
    res.status(status).json({
      error: apiError?.code ?? 'internal_error',
      message: status >= 500 ? 'Something went wrong while handling this request.' : err.message,
      detail: apiError?.detail,
    });
  });

  return app;
}
