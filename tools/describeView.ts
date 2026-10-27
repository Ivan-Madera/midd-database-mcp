import { resolveDatabase, withAccount } from "../db";
import { parseTableName } from "./sqlIdentifier";
import sql from "mssql";

export interface ViewColumnInfo {
  name: string;
  type: string;
  maxLength: number | null;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  ordinalPosition: number;
}

export interface DescribeViewResult {
  database: string;
  view: string;
  columns: ViewColumnInfo[];
}

/**
 * Describe una vista en formato estructurado (JSON): las columnas que expone
 * con su tipo, longitud/precisión, nullabilidad y posición. A diferencia de
 * una tabla, una vista no tiene IDENTITY ni PRIMARY KEY propios, por eso el
 * resultado se limita a las columnas.
 *
 * Ejecuta con la cuenta principal y, si falla por permisos o no ve la vista,
 * reintenta con la cuenta secundaria si está configurada. Si ninguna de las
 * dos cuentas ve la vista, el error "no existe" se propaga.
 */
export async function describeView(
  view: string,
  database?: string
): Promise<DescribeViewResult> {
  if (!view || typeof view !== "string") {
    throw new Error("El nombre de la vista es requerido y debe ser un string.");
  }

  const { schema: schemaName, name: viewName } = parseTableName(view);
  const target = resolveDatabase(database);

  // Ejecuta con la cuenta principal y, si falla por permisos o no ve la vista,
  // reintenta con la cuenta secundaria si está configurada.
  const columns = await withAccount(target, async ({ pool }) => {
    // 1) ¿La cuenta actual ve la vista? Si no, lanzamos para forzar el
    //    fallback. Una vista sin columnas no es un caso real, pero
    //    comprobamos la existencia en INFORMATION_SCHEMA.VIEWS para
    //    distinguir "no existe" de "no es una vista".
    const existsResult = await pool
      .request()
      .input("viewName", sql.NVarChar, viewName)
      .input("schemaName", sql.NVarChar, schemaName)
      .query(`
        SELECT 1 AS Found
        FROM INFORMATION_SCHEMA.VIEWS
        WHERE TABLE_NAME = @viewName
          AND TABLE_SCHEMA = @schemaName
      `);

    if (!existsResult.recordset.length) {
      throw new Error(
        `La vista "${schemaName}.${viewName}" no existe en la base de datos "${target}".`
      );
    }

    // 2) Columnas que expone la vista.
    const result = await pool
      .request()
      .input("viewName", sql.NVarChar, viewName)
      .input("schemaName", sql.NVarChar, schemaName)
      .query(`
        SELECT
          c.COLUMN_NAME,
          c.DATA_TYPE,
          c.CHARACTER_MAXIMUM_LENGTH,
          c.NUMERIC_PRECISION,
          c.NUMERIC_SCALE,
          c.IS_NULLABLE,
          c.ORDINAL_POSITION
        FROM INFORMATION_SCHEMA.COLUMNS c
        WHERE c.TABLE_NAME = @viewName AND c.TABLE_SCHEMA = @schemaName
        ORDER BY c.ORDINAL_POSITION
      `);

    return result.recordset.map((r) => ({
      name: r.COLUMN_NAME as string,
      type: (r.DATA_TYPE as string).toUpperCase(),
      maxLength: r.CHARACTER_MAXIMUM_LENGTH as number | null,
      precision: r.NUMERIC_PRECISION as number | null,
      scale: r.NUMERIC_SCALE as number | null,
      nullable: r.IS_NULLABLE === "YES",
      ordinalPosition: r.ORDINAL_POSITION as number,
    })) as ViewColumnInfo[];
  });

  return { database: target, view: `${schemaName}.${viewName}`, columns };
}
