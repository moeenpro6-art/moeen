import 'dotenv/config';
import { runDatabaseMigrationsFromEnvironment } from './database-migrations';

async function main(): Promise<void> {
  const result = await runDatabaseMigrationsFromEnvironment();
  process.stdout.write(
    `[database] migrations complete: applied=${result.applied.length}, baselined=${result.baselined.length}\n`,
  );
}

void main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : 'Unknown database migration error';
  process.stderr.write(`[database] migration failed: ${message}\n`);
  process.exitCode = 1;
});
