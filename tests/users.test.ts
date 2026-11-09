import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query, queryOne, closePool } from "../src/infrastructure/db";
import { limpiarTodo } from "./helpers";
import { RegistrarUsuarioUseCase } from "../src/application/users";
import { PostgresUserRepository } from "../src/infrastructure/userRepo";
import { PostgresComplianceProfileRepository } from "../src/infrastructure/complianceRepo";
import { PostgresTagHistoryRepository } from "../src/infrastructure/tagHistoryRepo";

const useCase = new RegistrarUsuarioUseCase(
  new PostgresUserRepository(),
  new PostgresComplianceProfileRepository(),
  new PostgresTagHistoryRepository()
);

function sufijo() { return Math.random().toString(36).slice(2, 8); }

beforeAll(async () => {
  await limpiarTodo();
});

afterAll(async () => {
  await limpiarTodo();
  await closePool();
});

describe("Módulo 2 — Registro de usuarios + tag", () => {
  it("registro exitoso", async () => {
    const t = `u.t.${sufijo()}`;
    const e = `${t}@labkyc.test`;
    const r = await useCase.ejecutar({ tag: t, email: e });
    expect(r.tag).toBe(t.toLowerCase());
    expect(r.email).toBe(e.toLowerCase());
    expect(r.kycStatus).toBe("not_started");
    expect(r.accountStatus).toBe("active");

    const prof = await queryOne("SELECT 1 FROM compliance_profiles WHERE user_id = $1", [r.userId]);
    expect(prof).not.toBeNull();

    const hist = await queryOne("SELECT 1 FROM tag_history WHERE user_id = $1 AND status = 'active'", [r.userId]);
    expect(hist).not.toBeNull();
  });

  it("tag duplicado case-insensitive", async () => {
    const t = `u.d.${sufijo()}`;
    await useCase.ejecutar({ tag: t, email: `${t}@labkyc.test` });
    await expect(useCase.ejecutar({ tag: t.toUpperCase(), email: `otro.${t}@labkyc.test` })).rejects.toThrow(/ya está en uso/);
  });

  it("email duplicado case-insensitive", async () => {
    const t = `u.e1.${sufijo()}`;
    const email = `DUPE.${sufijo()}@labkyc.test`;
    await useCase.ejecutar({ tag: t, email });
    await expect(useCase.ejecutar({ tag: `u.e2.${sufijo()}`, email: email.toUpperCase() })).rejects.toThrow(/ya está registrado/);
  });

  it("tag reservado", async () => {
    await expect(useCase.ejecutar({ tag: "ADMIN", email: `reserved.${sufijo()}@labkyc.test` })).rejects.toThrow(/reservado/);
  });

  it("tag formato inválido", async () => {
    await expect(useCase.ejecutar({ tag: "ab", email: `short.${sufijo()}@labkyc.test` })).rejects.toThrow(/formato/);
    await expect(useCase.ejecutar({ tag: "TAG MAYÚSCULAS", email: `upper.${sufijo()}@labkyc.test` })).rejects.toThrow(/formato/);
  });
});
