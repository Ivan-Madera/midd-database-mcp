import { getPool, resolveDatabase } from "../db";
import { listDatabases } from "./listDatabases";
import sql from "mssql";

export interface ColumnMatch {
  database: string;
  schema: string;
  table: string;
  column: string;
  type: string;
}

export interface SearchColumnsResult {
  pattern: string;
  matches: ColumnMatch[];
}

/**
 * Busca columnas cuyo nombre contenga `pattern` (case-insensitive).
 * Si se indica `database`, busca solo en esa BD; si no, recorre todas las
 * BD accesibles (respetando la allowlist). Útil para encontrar en qué tabla
 * vive un campo (ej. "email", "id_cliente").
 */
export async function searchColumns(
  pattern: string,
  database?: string
): Promise<SearchColumnsResult> {
  if (!pattern || typeof pattern !== "string") {
    throw new Error("El patrón de búsqueda es requerido y debe ser un string.");
  }

  const targets = database
    ? [resolveDatabase(database)]
    : (await listDatabases()).databases;

  const matches: ColumnMatch[] = [];

  for (const db of targets) {
    try {
      const pool = await getPool(db);
      const result = await pool
        .request()
        .input("pattern", sql.NVarChar, `%${pattern}%`)
        .query(`
          SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE COLUMN_NAME LIKE @pattern
          ORDER BY TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME
        `);

      for (const row of result.recordset) {
        matches.push({
          database: db,
          schema: row.TABLE_SCHEMA as string,
          table: row.TABLE_NAME as string,
          column: row.COLUMN_NAME as string,
          type: (row.DATA_TYPE as string).toUpperCase(),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[searchColumns] No se pudo buscar en "${db}": ${message}`);
    }
  }

  return { pattern, matches };
}
