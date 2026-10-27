import { resolveDatabase, withAccount } from "../db";

export interface ListViewsResult {
  database: string;
  views: string[];
}

/**
 * Lista las vistas de una BD (INFORMATION_SCHEMA.VIEWS), excluyendo las de
 * sistema (schema 'sys'). Si no se indica `database`, usa DB_NAME por defecto.
 *
 * Si la cuenta principal falla por permisos, reintenta con la cuenta
 * secundaria cuando esté configurada. Un resultado vacío NO dispara el
 * fallback: significa que la cuenta pudo consultar y no había vistas.
 */
export async function listViews(database?: string): Promise<ListViewsResult> {
  const target = resolveDatabase(database);

  const views = await withAccount(target, async ({ pool }) => {
    const result = await pool.request().query(`
      SELECT TABLE_SCHEMA + '.' + TABLE_NAME AS ViewName
      FROM INFORMATION_SCHEMA.VIEWS
      WHERE TABLE_SCHEMA <> 'sys'
      ORDER BY TABLE_SCHEMA, TABLE_NAME
    `);
    return result.recordset.map((row) => row.ViewName as string);
  });

  return { database: target, views };
}
