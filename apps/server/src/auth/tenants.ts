/**
 * Minimal tenant store — enough to own API keys and enforce isolation.
 * (Billing/plan management lives in a later phase.)
 */
import type { Sql } from "postgres";
import { sql as defaultSql } from "../db/client";

export interface Tenant {
  id: string;
  name: string;
  email: string;
  plan: string;
  isActive: boolean;
}

export class TenantService {
  constructor(private readonly db: Sql = defaultSql) {}

  /** Create (or no-op if it exists) a tenant. */
  async create(
    id: string,
    info: { name: string; email: string },
  ): Promise<void> {
    await this.db`
      INSERT INTO tenants (id, name, email)
      VALUES (${id}, ${info.name}, ${info.email})
      ON CONFLICT (id) DO NOTHING
    `;
  }

  async get(id: string): Promise<Tenant | null> {
    const [row] = await this.db`
      SELECT id, name, email, plan, is_active FROM tenants WHERE id = ${id}
    `;
    if (!row) return null;
    return {
      id: row.id as string,
      name: row.name as string,
      email: row.email as string,
      plan: row.plan as string,
      isActive: row.is_active as boolean,
    };
  }
}
