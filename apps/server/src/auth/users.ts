/**
 * Dashboard user accounts — the human login identity (email + password).
 *
 * Signing up provisions a fresh tenant and an owner user in one transaction.
 * Passwords are hashed with Bun's argon2id (never stored in clear). This is the
 * "signup/login" layer that sits in front of API-key management — a user logs
 * in, then mints scoped API keys for their tenant from the dashboard.
 */
import type { Sql } from "postgres";
import { sql as defaultSql } from "../db/client";
import { EngineError } from "../errors";
import { randomHex } from "./crypto";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MIN_PASSWORD_LENGTH = 8;

export interface User {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: string;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class UserService {
  constructor(private readonly db: Sql = defaultSql) {}

  /**
   * Create an account: a new tenant + its owner user, atomically. Returns the
   * user (the caller then issues a session token). Throws 409 if the email is
   * taken, 400 on a malformed email / weak password.
   */
  async signup(input: {
    email: string;
    password: string;
    orgName?: string;
  }): Promise<User> {
    const email = normalizeEmail(input.email ?? "");
    if (!EMAIL_RE.test(email)) {
      throw new EngineError("INVALID_EMAIL", "A valid email address is required.", 400);
    }
    if (!input.password || input.password.length < MIN_PASSWORD_LENGTH) {
      throw new EngineError(
        "WEAK_PASSWORD",
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
        400,
      );
    }

    const [taken] = await this.db`SELECT 1 FROM users WHERE email = ${email}`;
    if (taken) {
      throw new EngineError("EMAIL_TAKEN", "An account with this email already exists.", 409);
    }

    const tenantId = `t_${randomHex(8)}`;
    const userId = `usr_${randomHex(8)}`;
    const name = (input.orgName ?? "").trim() || (email.split("@")[0] ?? "owner");
    const passwordHash = await Bun.password.hash(input.password);

    await this.db.begin(async (tx) => {
      await tx`
        INSERT INTO tenants (id, name, email) VALUES (${tenantId}, ${name}, ${email})
      `;
      await tx`
        INSERT INTO users (id, tenant_id, email, password_hash, name, role)
        VALUES (${userId}, ${tenantId}, ${email}, ${passwordHash}, ${name}, 'owner')
      `;
    });

    return { id: userId, tenantId, email, name, role: "owner" };
  }

  /** Verify email + password. Returns the user, or null if invalid/inactive. */
  async login(email: string, password: string): Promise<User | null> {
    const e = normalizeEmail(email ?? "");
    const [row] = await this.db`
      SELECT u.id, u.tenant_id, u.email, u.name, u.role, u.password_hash,
             t.is_active AS tenant_active
        FROM users u JOIN tenants t ON t.id = u.tenant_id
       WHERE u.email = ${e}
    `;
    if (!row || row.tenant_active !== true) return null;
    const ok = await Bun.password.verify(password ?? "", row.password_hash as string);
    if (!ok) return null;
    void this.db`UPDATE users SET last_login_at = NOW() WHERE id = ${row.id}`.catch(() => {});
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      email: row.email as string,
      name: row.name as string,
      role: row.role as string,
    };
  }

  async getById(id: string): Promise<User | null> {
    const [row] = await this.db`
      SELECT id, tenant_id, email, name, role FROM users WHERE id = ${id}
    `;
    if (!row) return null;
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      email: row.email as string,
      name: row.name as string,
      role: row.role as string,
    };
  }
}
