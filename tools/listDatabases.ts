import { getAllowedDatabases, withAccount } from "../db";

export interface ListDatabasesResult {
  databases: string[];
}

/**
 * Lista las bases de datos del servidor a las que la cuenta tiene acceso.
 * Excluye las BD de sistema (master, model, msdb, tempdb).
 * Si DB_ALLOWED_DATABASES está configurado, filtra adicionalmente por ella.
 *
 * Usa HAS_DBACCESS, que depende de la cuenta conectada; por eso, si la cuenta
 * principal falla por permisos, reintenta con la cuenta secundaria.
 */
export async function listDatabases(): Promise<ListDatabasesResult> {
  const allowed = getAllowedDatabases();
  const allowedLower =
    allowed.length > 0 ? new Set(allowed.map((d) => d.toLowerCase())) : null;

  // Usa el pool de la BD por defecto (o cualquier accesible) para consultar sys.databases.
  const databases = await withAccount(undefined, async ({ pool }) => {
    const result = await pool.request().query(`
      SELECT name
      FROM sys.databases
      WHERE HAS_DBACCESS(name) = 1
        AND name NOT IN ('master', 'model', 'msdb', 'tempdb')
      ORDER BY name
    `);

    let dbs = result.recordset.map((row) => row.name as string);

    // Aplicar allowlist si está configurada.
    if (allowedLower) {
      dbs = dbs.filter((d) => allowedLower.has(d.toLowerCase()));
    }
    return dbs;
  });

  return { databases };
}
