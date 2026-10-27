import { resolveDatabase, withAccount } from "../db";

export interface ListProceduresResult {
  database: string;
  procedures: string[];
}

/**
 * Lista los stored procedures de una BD (ROUTINE_TYPE = 'PROCEDURE'),
 * excluyendo los de sistema (schema 'sys'). Si no se indica `database`,
 * usa DB_NAME por defecto.
 *
 * Si la cuenta principal falla por permisos, reintenta con la cuenta
 * secundaria cuando esté configurada. Un resultado vacío NO dispara el
 * fallback: significa que la cuenta pudo consultar y no había procedimientos.
 */
export async function listProcedures(database?: string): Promise<ListProceduresResult> {
  const target = resolveDatabase(database);

  const procedures = await withAccount(target, async ({ pool }) => {
    const result = await pool.request().query(`
      SELECT ROUTINE_SCHEMA + '.' + ROUTINE_NAME AS ProcedureName
      FROM INFORMATION_SCHEMA.ROUTINES
      WHERE ROUTINE_TYPE = 'PROCEDURE'
        AND ROUTINE_SCHEMA <> 'sys'
      ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME
    `);
    return result.recordset.map((row) => row.ProcedureName as string);
  });

  return { database: target, procedures };
}
