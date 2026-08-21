import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  defaultMigrationsDirectory,
  loadMigrations,
} from './database-migrations';

describe('service request location migration', () => {
  it('ships 0005 after the immutable 0001-0004 history', async () => {
    const migrations = await loadMigrations(defaultMigrationsDirectory());
    expect(migrations.map((migration) => migration.version)).toEqual(
      expect.arrayContaining(['0001', '0002', '0003', '0004', '0005']),
    );
    expect(
      migrations.find((migration) => migration.version === '0005'),
    ).toMatchObject({
      filename: '0005_service_request_locations.sql',
    });
  });

  it('adds only nullable canonical request-location columns and named integrity checks', async () => {
    const sql = await readFile(
      join(defaultMigrationsDirectory(), '0005_service_request_locations.sql'),
      'utf8',
    );

    expect(sql).toContain('location_latitude NUMERIC(9,6)');
    expect(sql).toContain('location_longitude NUMERIC(10,6)');
    expect(sql).toContain('location_source TEXT');
    expect(sql).toContain('location_confirmed_at TIMESTAMPTZ');
    expect(sql).toContain('service_requests_location_completeness_check');
    expect(sql).toContain('service_requests_location_latitude_check');
    expect(sql).toContain('service_requests_location_longitude_check');
    expect(sql).toContain('service_requests_location_source_check');
    expect(sql).toContain("'current_location'");
    expect(sql).toContain("'map_pin'");
    expect(sql).not.toMatch(
      /location_confirmed_at\s+TIMESTAMPTZ\s+[^,;]*DEFAULT/i,
    );
    expect(sql).not.toMatch(/UPDATE\s+service_requests/i);
    expect(sql).not.toMatch(/postgis|geocod|provider_location/i);
  });
});
