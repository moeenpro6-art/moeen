import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApiSecurity } from './api-security';
import { resolveTrustedProxyHops } from './trusted-proxy';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const trustedProxyHops = resolveTrustedProxyHops();
  if (trustedProxyHops !== undefined) {
    app.getHttpAdapter().getInstance().set('trust proxy', trustedProxyHops);
  }
  configureApiSecurity(app);
  await app.listen(process.env.PORT ?? 3002);
}
void bootstrap();
