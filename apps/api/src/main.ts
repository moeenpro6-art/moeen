import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApiSecurity } from './api-security';
import { resolveTrustedProxyHops } from './trusted-proxy';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const trustedProxyHops = resolveTrustedProxyHops();
  if (trustedProxyHops !== undefined) {
    app.set('trust proxy', trustedProxyHops);
  }
  configureApiSecurity(app);
  await app.listen(process.env.PORT ?? 3002);
}
void bootstrap();
