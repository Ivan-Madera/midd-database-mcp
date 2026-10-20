import { getPool, getAllowedDatabases } from "../db";

export interface ListDatabasesResult {
  databases: string[];
}

/**
 * Lista las bases de datos del servidor a las que la cuenta tiene acceso.
 * Excluye las BD de sistema (master, model, msdb, tempdb).
 * Si DB_ALLOWED_DATABASES está configurado, filtra adicionalmente por ella.
 */
export async function listDatabases(): Promise<ListDatabasesResult> {
  // Usa el pool de la BD por defecto (o cualquier accesible) para consultar sys.databases.
  const pool = await getPool();

  const result = await pool.request().query(`
    SELECT name
    FROM sys.databases
    WHERE HAS_DBACCESS(name) = 1
      AND name NOT IN ('master', 'model', 'msdb', 'tempdb')
    ORDER BY name
  `);

  let databases = result.recordset.map((row) => row.name as string);

  // Aplicar allowlist si está configurada.
  const allowed = getAllowedDatabases();
  if (allowed.length > 0) {
    const allowedLower = new Set(allowed.map((d) => d.toLowerCase()));
    databases = databases.filter((d) => allowedLower.has(d.toLowerCase()));
  }

  return { databases };
}
