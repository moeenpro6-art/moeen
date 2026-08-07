import { createHash } from 'node:crypto';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import type { LoginAttemptScope } from './login-attempt-limiter.service';
import type { PublicAuthAttemptScope } from './public-auth-rate-limiter.service';
import { resolveDatabaseConnectionString } from './database.config';
import type {
  StaffAuthStore,
  StaffPrincipal,
  StaffRole,
  StoredStaff,
} from './staff-auth.service';

type StaffRow = {
  id: string;
  email: string;
  display_name: string;
  role: StaffRole;
  password_hash: string;
  is_active: boolean;
};

type AuditEventRow = {
  id: string;
  staff_user_id: string;
  actor_display_name: string;
  action: string;
  subject_type: string;
  subject_id: string;
  old_state: Record<string, unknown> | null;
  new_state: Record<string, unknown> | null;
  created_at: Date;
};

export type CreateStaffInput = {
  email: string;
  displayName: string;
  role: StaffRole;
  passwordHash: string;
};

export type CreateAuditEventInput = {
  staffId: string;
  action: string;
  subjectType: string;
  subjectId: string;
  oldState?: Record<string, unknown>;
  newState?: Record<string, unknown>;
};

export type StaffAuditEvent = {
  id: string;
  actor: Pick<StaffPrincipal, 'id' | 'displayName'>;
  action: string;
  subjectType: string;
  subjectId: string;
  oldState?: Record<string, unknown>;
  newState?: Record<string, unknown>;
  createdAt: string;
};

@Injectable()
export class StaffAuthRepository
  implements StaffAuthStore, OnModuleInit, OnModuleDestroy
{
  private readonly pool = new Pool({
    connectionString: resolveDatabaseConnectionString(),
  });

  async onModuleInit(): Promise<void> {
    await this.initialize();
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS staff_users (
        id BIGSERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'dispatcher', 'support_agent')),
        password_hash TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS staff_sessions (
        token_hash TEXT PRIMARY KEY,
        staff_user_id BIGINT NOT NULL REFERENCES staff_users(id),
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS auth_login_failures (
        scope TEXT NOT NULL CHECK (scope IN ('staff_login', 'provider_login')),
        subject_hash CHAR(64) NOT NULL,
        attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS public_auth_rate_limits (
        scope TEXT NOT NULL CHECK (scope IN ('customer_otp_request', 'customer_otp_verification')),
        subject_hash CHAR(64) NOT NULL,
        window_started_at TIMESTAMPTZ NOT NULL,
        attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
        PRIMARY KEY (scope, subject_hash)
      )
    `);
    // Extend the public-auth scope CHECK with provider_login (controlled, idempotent, race-safe)
    await this.pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'public_auth_rate_limits_scope_check'
            AND pg_get_constraintdef(oid) LIKE '%provider_login%'
        ) THEN
          BEGIN
            ALTER TABLE public_auth_rate_limits
              DROP CONSTRAINT IF EXISTS public_auth_rate_limits_scope_check,
              ADD CONSTRAINT public_auth_rate_limits_scope_check
                CHECK (scope IN ('customer_otp_request', 'customer_otp_verification', 'provider_login'));
          EXCEPTION WHEN duplicate_object THEN
            NULL;
          END;
        END IF;
      END $$;
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS staff_audit_events (
        id BIGSERIAL PRIMARY KEY,
        staff_user_id BIGINT NOT NULL REFERENCES staff_users(id),
        action TEXT NOT NULL,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        old_state JSONB,
        new_state JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS staff_sessions_expires_at_idx ON staff_sessions (expires_at)',
    );
    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS auth_login_failures_lookup_idx ON auth_login_failures (scope, subject_hash, attempted_at DESC)',
    );
    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS staff_audit_events_actor_created_at_idx ON staff_audit_events (staff_user_id, created_at DESC)',
    );
    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS staff_audit_events_subject_created_at_idx ON staff_audit_events (subject_type, subject_id, created_at DESC)',
    );
  }

  async createStaff(input: CreateStaffInput): Promise<StaffPrincipal> {
    const result = await this.pool.query<StaffRow>(
      `INSERT INTO staff_users (email, display_name, role, password_hash, is_active)
       VALUES ($1, $2, $3, $4, TRUE)
       ON CONFLICT (email) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           role = EXCLUDED.role,
           password_hash = EXCLUDED.password_hash,
           is_active = TRUE
       RETURNING id, email, display_name, role, password_hash, is_active`,
      [
        input.email.trim().toLowerCase(),
        input.displayName.trim(),
        input.role,
        input.passwordHash,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Staff member could not be created');
    return this.toPrincipal(row);
  }

  async bootstrapInitialAdmin(input: {
    email: string;
    displayName: string;
    passwordHash: string;
  }): Promise<StaffPrincipal> {
    const existing = await this.findStaffByEmail(input.email);
    if (existing) {
      return {
        id: existing.id,
        email: existing.email,
        displayName: existing.displayName,
        role: existing.role,
      };
    }
    return this.createStaff({ ...input, role: 'admin' });
  }

  async findStaffByEmail(email: string): Promise<StoredStaff | undefined> {
    const result = await this.pool.query<StaffRow>(
      `SELECT id, email, display_name, role, password_hash, is_active
       FROM staff_users
       WHERE email = $1`,
      [email.trim().toLowerCase()],
    );
    const row = result.rows[0];
    return row
      ? {
          ...this.toPrincipal(row),
          passwordHash: row.password_hash,
          isActive: row.is_active,
        }
      : undefined;
  }

  async createStaffSession(staffId: string, token: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO staff_sessions (token_hash, staff_user_id, expires_at)
       VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 day'))
       ON CONFLICT (token_hash) DO UPDATE
       SET staff_user_id = EXCLUDED.staff_user_id,
           expires_at = EXCLUDED.expires_at`,
      [
        this.hashToken(token),
        this.toDatabaseId(staffId),
        this.sessionTtlDays(),
      ],
    );
  }

  async findStaffBySession(token: string): Promise<StaffPrincipal | undefined> {
    const result = await this.pool.query<StaffRow>(
      `SELECT u.id, u.email, u.display_name, u.role, u.password_hash, u.is_active
       FROM staff_sessions s
       JOIN staff_users u ON u.id = s.staff_user_id
       WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.is_active = TRUE`,
      [this.hashToken(token)],
    );
    const row = result.rows[0];
    return row ? this.toPrincipal(row) : undefined;
  }

  async revokeStaffSession(token: string): Promise<void> {
    await this.pool.query('DELETE FROM staff_sessions WHERE token_hash = $1', [
      this.hashToken(token),
    ]);
  }

  async countRecentLoginFailures(
    scope: LoginAttemptScope,
    subjectHash: string,
    since: Date,
  ): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count
       FROM auth_login_failures
       WHERE scope = $1 AND subject_hash = $2 AND attempted_at >= $3`,
      [scope, subjectHash, since],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async reservePublicAuthAttempt(
    scope: PublicAuthAttemptScope,
    subjectHash: string,
    windowStartedAt: Date,
  ): Promise<number> {
    const result = await this.pool.query<{ attempt_count: number }>(
      `INSERT INTO public_auth_rate_limits (
         scope, subject_hash, window_started_at, attempt_count
       )
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (scope, subject_hash) DO UPDATE
       SET window_started_at = EXCLUDED.window_started_at,
           attempt_count = CASE
             WHEN public_auth_rate_limits.window_started_at = EXCLUDED.window_started_at
               THEN public_auth_rate_limits.attempt_count + 1
             ELSE 1
           END
       RETURNING attempt_count`,
      [scope, subjectHash, windowStartedAt],
    );
    await this.pool.query(
      `DELETE FROM public_auth_rate_limits
       WHERE window_started_at < NOW() - INTERVAL '24 hours'`,
    );
    const attempts = result.rows[0]?.attempt_count;
    if (attempts === undefined) {
      throw new Error('Public authentication attempt could not be reserved');
    }
    return attempts;
  }

  async recordLoginFailure(
    scope: LoginAttemptScope,
    subjectHash: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO auth_login_failures (scope, subject_hash)
       VALUES ($1, $2)`,
      [scope, subjectHash],
    );
    await this.pool.query(
      `DELETE FROM auth_login_failures
       WHERE attempted_at < NOW() - INTERVAL '24 hours'`,
    );
  }

  async clearLoginFailures(
    scope: LoginAttemptScope,
    subjectHash: string,
  ): Promise<void> {
    await this.pool.query(
      'DELETE FROM auth_login_failures WHERE scope = $1 AND subject_hash = $2',
      [scope, subjectHash],
    );
  }

  async appendAuditEvent(input: CreateAuditEventInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO staff_audit_events
        (staff_user_id, action, subject_type, subject_id, old_state, new_state)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        this.toDatabaseId(input.staffId),
        input.action,
        input.subjectType,
        input.subjectId,
        input.oldState ?? null,
        input.newState ?? null,
      ],
    );
  }

  async listAuditEvents(
    options: {
      subjectId?: string;
      limit?: number;
    } = {},
  ): Promise<StaffAuditEvent[]> {
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), 100);
    const values: Array<string | number> = [];
    const condition = options.subjectId
      ? (values.push(options.subjectId), 'WHERE e.subject_id = $1')
      : '';
    values.push(limit);
    const result = await this.pool.query<AuditEventRow>(
      `SELECT e.id, e.staff_user_id, u.display_name AS actor_display_name,
              e.action, e.subject_type, e.subject_id, e.old_state, e.new_state, e.created_at
       FROM staff_audit_events e
       JOIN staff_users u ON u.id = e.staff_user_id
       ${condition}
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT $${values.length}`,
      values,
    );
    return result.rows.map((row) => this.toAuditEvent(row));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private sessionTtlDays(): number {
    const configuredValue = Number(process.env.STAFF_SESSION_TTL_DAYS ?? 7);
    return Number.isFinite(configuredValue) && configuredValue > 0
      ? Math.min(Math.floor(configuredValue), 30)
      : 7;
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private toDatabaseId(staffId: string): number {
    const match = /^STF-(\d+)$/.exec(staffId);
    if (!match) throw new Error('Invalid staff id');
    return Number(match[1]) - 1000;
  }

  private toPrincipal(row: StaffRow): StaffPrincipal {
    return {
      id: `STF-${1000 + Number(row.id)}`,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
    };
  }

  private toAuditEvent(row: AuditEventRow): StaffAuditEvent {
    return {
      id: `AUD-${1000 + Number(row.id)}`,
      actor: {
        id: `STF-${1000 + Number(row.staff_user_id)}`,
        displayName: row.actor_display_name,
      },
      action: row.action,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      oldState: row.old_state ?? undefined,
      newState: row.new_state ?? undefined,
      createdAt: row.created_at.toISOString(),
    };
  }
}
