#!/usr/bin/env node
// Copies PostgreSQL migration SQL files from src/database/migrations into the
// compiled output dist/src/database/migrations so the production artifact is
// self-contained. This is cross-platform (Node fs/path only) and runs AFTER
// `nest build` so stale migration output cannot survive a clean build
// (deleteOutDir removes dist first).
//
// Usage: node scripts/copy-migrations.mjs

import { cpSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_SOURCE_REL = 'src/database/migrations';
const DEFAULT_OUT_REL = 'dist/src/database/migrations';
const MIGRATION_FILE_PATTERN = /^(\d{4})_[a-z0-9][a-z0-9_-]*\.sql$/;

function fail(message) {
  console.error(`[copy-migrations] FAIL: ${message}`);
  process.exitCode = 1;
}

function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  // Repository root for the API package (the directory containing scripts/).
  const packageRoot = dirname(scriptDir);

  const sourceDir = join(packageRoot, DEFAULT_SOURCE_REL);
  const outDir = join(packageRoot, DEFAULT_OUT_REL);

  let sourceEntries;
  try {
    sourceEntries = readdirSync(sourceDir, { withFileTypes: true });
  } catch (error) {
    fail(`source migrations directory missing: ${sourceDir} (${error.code ?? error})`);
    return;
  }
  if (!statSync(sourceDir).isDirectory()) {
    fail(`source migrations path is not a directory: ${sourceDir}`);
    return;
  }

  const migrationFiles = sourceEntries
    .filter((entry) => entry.isFile() && MIGRATION_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  if (migrationFiles.length === 0) {
    fail(`no migration SQL files found in ${sourceDir}`);
    return;
  }

  mkdirSync(outDir, { recursive: true });
  for (const filename of migrationFiles) {
    cpSync(join(sourceDir, filename), join(outDir, filename));
  }

  console.log(
    `[copy-migrations] OK: ${migrationFiles.length} migration file(s) copied to ${outDir}`,
  );
}

main();