import { query } from "./db";
import type { TagHistoryRepository } from "../domain/ports";

export class PostgresTagHistoryRepository implements TagHistoryRepository {
  async registrar(userId: string, tag: string, status = "active") {
    await query("INSERT INTO tag_history (user_id, tag, status) VALUES ($1,$2,$3)", [userId, tag, status]);
  }
}
