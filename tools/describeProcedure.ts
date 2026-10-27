import { resolveDatabase, withAccount } from "../db";
import { parseTableName } from "./sqlIdentifier";
import sql from "mssql";

export interface ParameterInfo {
  name: string;
  type: string;
  maxLength: number | null;
  precision: number | null;
  scale: number | null;
  /** Dirección del parámetro: 'IN', 'OUT' o 'INOUT'. */
  mode: string;
  /** true si es el valor de retorno de la rutina (RESULT). */
  isResult: boolean;
  ordinalPosition: number;
}

export interface DescribeProcedureResult {
  database: string;
  procedure: string;
  parameters: ParameterInfo[];
}

/**
 * Describe un stored procedure en formato estructurado (JSON): sus parámetros
 * con tipo, longitud/precisión, dirección (IN/OUT/INOUT) y posición.
 *
 * Ejecuta con la cuenta principal y, si falla por permisos o no ve el SP,
 * reintenta con la cuenta secundaria si está configurada. Si ninguna de las
 * dos cuentas ve el procedimiento, el error "no existe" se propaga.
 *
 * Nota: un SP sin parámetros devuelve una lista vacía; eso es válido y se
 * distingue de "no existe" comprobando primero la existencia de la rutina.
 */
export async function describeProcedure(
  procedure: string,
  database?: string
): Promise<DescribeProcedureResult> {
  if (!procedure || typeof procedure !== "string") {
    throw new Error("El nombre del procedimiento es requerido y debe ser un string.");
  }

  const { schema: schemaName, name: procName } = parseTableName(procedure);
  const target = resolveDatabase(database);

  const parameters = await withAccount(target, async ({ pool }) => {
    // 1) ¿La cuenta actual ve el procedimiento? Si no, lanzamos para forzar el
    //    fallback (un SP sin parámetros es válido, así que no basta con contar
    //    parámetros para decidir si existe).
    const existsResult = await pool
      .request()
      .input("procName", sql.NVarChar, procName)
      .input("schemaName", sql.NVarChar, schemaName)
      .query(`
        SELECT 1 AS Found
        FROM INFORMATION_SCHEMA.ROUTINES
        WHERE ROUTINE_TYPE = 'PROCEDURE'
          AND ROUTINE_NAME = @procName
          AND ROUTINE_SCHEMA = @schemaName
      `);

    if (!existsResult.recordset.length) {
      throw new Error(
        `El procedimiento "${schemaName}.${procName}" no existe en la base de datos "${target}".`
      );
    }

    // 2) Parámetros del SP.
    const result = await pool
      .request()
      .input("procName", sql.NVarChar, procName)
      .input("schemaName", sql.NVarChar, schemaName)
      .query(`
        SELECT
          p.PARAMETER_NAME,
          p.DATA_TYPE,
          p.CHARACTER_MAXIMUM_LENGTH,
          p.NUMERIC_PRECISION,
          p.NUMERIC_SCALE,
          p.PARAMETER_MODE,
          p.IS_RESULT,
          p.ORDINAL_POSITION
        FROM INFORMATION_SCHEMA.PARAMETERS p
        WHERE p.SPECIFIC_NAME = @procName
          AND p.SPECIFIC_SCHEMA = @schemaName
        ORDER BY p.ORDINAL_POSITION
      `);

    return result.recordset.map((r) => ({
      // El valor de retorno aparece con PARAMETER_NAME NULL; lo nombramos.
      name: (r.PARAMETER_NAME as string | null) ?? "(return value)",
      type: (r.DATA_TYPE as string).toUpperCase(),
      maxLength: r.CHARACTER_MAXIMUM_LENGTH as number | null,
      precision: r.NUMERIC_PRECISION as number | null,
      scale: r.NUMERIC_SCALE as number | null,
      mode: (r.PARAMETER_MODE as string | null) ?? "IN",
      isResult: r.IS_RESULT === "YES",
      ordinalPosition: r.ORDINAL_POSITION as number,
    })) as ParameterInfo[];
  });

  return { database: target, procedure: `${schemaName}.${procName}`, parameters };
}
