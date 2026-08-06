import type { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

const contentSecurityPolicy =
  "default-src 'none'; base-uri 'none'; frame-ancestors 'none'";

/**
 * Applies HTTP-response protections that are safe for the API's JSON-only
 * surface. TLS/HSTS remain the responsibility of the public HTTPS edge, so
 * local Android development over adb reverse continues to work.
 */
export function configureApiSecurity(app: INestApplication): void {
  const httpServer = app.getHttpAdapter().getInstance() as {
    disable?: (setting: string) => void;
  };
  httpServer.disable?.('x-powered-by');

  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('Cache-Control', 'no-store, private');
    response.setHeader('Content-Security-Policy', contentSecurityPolicy);
    response.setHeader(
      'Permissions-Policy',
      'camera=(), geolocation=(), microphone=()',
    );
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    next();
  });
}
