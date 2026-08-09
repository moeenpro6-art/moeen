#!/usr/bin/env node
'use strict';

/**
 * Q0-SEC child-environment probe (P3).
 *
 * Run through the shim: `node scripts/with-test-env.js node scripts/probe-child-env.js`.
 * Prints ONLY the run id this child inherited and the schema extracted from
 * the inherited TEST_DATABASE_URL — never the URL itself, never credentials.
 * Used by the guard spec to prove the child received the shim's childEnv
 * (fresh run id + owner token) rather than any inherited process.env values.
 */

const runId = process.env.MOEEN_TEST_RUN_ID ?? '(missing)';
const ownerTokenPresent = Boolean(process.env.MOEEN_TEST_OWNER_TOKEN);
const rawUrl = process.env.TEST_DATABASE_URL ?? '';
let schema = '(missing)';
try {
  const options = new URL(rawUrl).searchParams.get('options');
  const match = /(?:^|[\s,])search_path\s*=\s*([^\s]+)/i.exec(options ?? '');
  schema = match ? match[1].replace(/^'|'$/g, '') : '(no search_path)';
} catch {
  schema = '(unparseable)';
}
console.log(
  `[probe] run ${runId} owner ${ownerTokenPresent ? 'present' : 'missing'} schema ${schema}`,
);
