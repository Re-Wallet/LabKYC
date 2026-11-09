import { query, queryOne } from "./db";
import type { UserRepository, UserRow, DatosKYC } from "../domain/ports";

export class PostgresUserRepository implements UserRepository {
  async obtenerPorId(userId: string): Promise<UserRow | null> {
    return queryOne(
      "SELECT id, tag, email, kyc_status, account_status FROM users WHERE id = $1 LIMIT 1",
      [userId],
    );
  }

  async obtenerPorTag(tagNormalizado: string): Promise<UserRow | null> {
    return queryOne(
      "SELECT id, tag, email, kyc_status, account_status FROM users WHERE lower(tag) = $1 LIMIT 1",
      [tagNormalizado],
    );
  }

  async obtenerPorEmail(emailNormalizado: string): Promise<UserRow | null> {
    return queryOne(
      "SELECT id, tag, email, kyc_status, account_status FROM users WHERE lower(email) = $1 LIMIT 1",
      [emailNormalizado],
    );
  }

  async actualizarKycStatus(userId: string, status: string): Promise<void> {
    await query("UPDATE users SET kyc_status = $2, updated_at = now() WHERE id = $1", [userId, status]);
  }

  async actualizarDatosKYC(userId: string, datos: DatosKYC): Promise<void> {
    await query(
      `UPDATE users SET full_name = $2, date_of_birth = $3, document_type = $4,
         document_number = $5, document_expiry = $6, nationality = $7, updated_at = now()
       WHERE id = $1`,
      [
        userId,
        datos.fullName ?? null,
        datos.dateOfBirth ?? null,
        datos.documentType ?? null,
        datos.documentNumber ?? null,
        datos.documentExpiry ?? null,
        datos.nationality ?? null,
      ],
    );
  }

  async crear(usuario: {
    id: string;
    tag: { value: string; normalizado: string };
    email: { value: string; normalizado: string };
    phone_number?: string | null;
    kyc_status: string;
    account_status: string;
  }): Promise<UserRow> {
    const row = await queryOne(
      `INSERT INTO users (id, tag, email, phone_number, kyc_status, account_status)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, tag, email, kyc_status, account_status`,
      [
        usuario.id,
        usuario.tag.value,
        usuario.email.value,
        usuario.phone_number ?? null,
        usuario.kyc_status,
        usuario.account_status,
      ],
    );
    return row;
  }
}
