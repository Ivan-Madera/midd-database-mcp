import { resolveDatabase, withAccount } from "../db";

export interface ListTablesResult {
  database: string;
  tables: string[];
}

/**
 * Lista todas las tablas base (TABLE_TYPE = 'BASE TABLE') de una BD.
 * Si no se indica `database`, usa DB_NAME por defecto.
 *
 * Si la cuenta principal falla por permisos, reintenta con la cuenta
 * secundaria cuando esté configurada.
 */
export async function listTables(database?: string): Promise<ListTablesResult> {
  const target = resolveDatabase(database);

  const tables = await withAccount(target, async ({ pool }) => {
    const result = await pool.request().query(`
      SELECT TABLE_SCHEMA + '.' + TABLE_NAME AS TableName
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_SCHEMA, TABLE_NAME
    `);
    return result.recordset.map((row) => row.TableName as string);
  });

  return { database: target, tables };
}
