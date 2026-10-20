import { getPool, resolveDatabase } from "../db";
import { listDatabases } from "./listDatabases";
import sql from "mssql";

export interface TableMatch {
  database: string;
  schema: string;
  table: string;
}

export interface SearchTablesResult {
  pattern: string;
  matches: TableMatch[];
}

/**
 * Busca tablas cuyo nombre contenga `pattern` (case-insensitive).
 * Si se indica `database`, busca solo en esa BD; si no, recorre todas las
 * BD accesibles (respetando la allowlist).
 */
export async function searchTables(
  pattern: string,
  database?: string
): Promise<SearchTablesResult> {
  if (!pattern || typeof pattern !== "string") {
    throw new Error("El patrón de búsqueda es requerido y debe ser un string.");
  }

  const targets = database
    ? [resolveDatabase(database)]
    : (await listDatabases()).databases;

  const matches: TableMatch[] = [];

  for (const db of targets) {
    try {
      const pool = await getPool(db);
      const result = await pool
        .request()
        .input("pattern", sql.NVarChar, `%${pattern}%`)
        .query(`
          SELECT TABLE_SCHEMA, TABLE_NAME
          FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_TYPE = 'BASE TABLE'
            AND TABLE_NAME LIKE @pattern
          ORDER BY TABLE_SCHEMA, TABLE_NAME
        `);

      for (const row of result.recordset) {
        matches.push({
          database: db,
          schema: row.TABLE_SCHEMA as string,
          table: row.TABLE_NAME as string,
        });
      }
    } catch (err) {
      // No cortar toda la búsqueda si una BD falla (p. ej. permisos).
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[searchTables] No se pudo buscar en "${db}": ${message}`);
    }
  }

  return { pattern, matches };
}
