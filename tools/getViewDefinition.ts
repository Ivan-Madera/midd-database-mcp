import { resolveDatabase, withAccount } from "../db";
import { parseTableName } from "./sqlIdentifier";
import sql from "mssql";

export interface GetViewDefinitionResult {
  database: string;
  view: string;
  definition: string;
}

/**
 * Obtiene el texto de definición (CREATE VIEW ...) de una vista vía
 * OBJECT_DEFINITION. Requiere el permiso VIEW DEFINITION sobre el objeto.
 *
 * Ejecuta con la cuenta principal y, si falla por permisos o no puede leer la
 * definición, reintenta con la cuenta secundaria si está configurada. Esto es
 * especialmente útil aquí, porque VIEW DEFINITION suele otorgarse de forma
 * dispareja entre cuentas.
 *
 * Casos a tener en cuenta:
 * - Si la vista no existe (OBJECT_ID NULL), se lanza para forzar el fallback;
 *   si ninguna cuenta la ve, el error "no existe" se propaga.
 * - Si la vista existe pero la definición vuelve NULL (cifrada con
 *   WITH ENCRYPTION, o sin VIEW DEFINITION), se lanza para intentar con la
 *   otra cuenta; si ninguna puede leerla, se informa que no es accesible.
 */
export async function getViewDefinition(
  view: string,
  database?: string
): Promise<GetViewDefinitionResult> {
  if (!view || typeof view !== "string") {
    throw new Error("El nombre de la vista es requerido y debe ser un string.");
  }

  const { schema: schemaName, name: viewName } = parseTableName(view);
  const target = resolveDatabase(database);
  const qualified = `${schemaName}.${viewName}`;

  const definition = await withAccount(target, async ({ pool }) => {
    const result = await pool
      .request()
      .input("qualified", sql.NVarChar, qualified)
      .query(`
        SELECT
          OBJECT_ID(@qualified, 'V') AS ObjectId,
          OBJECT_DEFINITION(OBJECT_ID(@qualified, 'V')) AS Definition
      `);

    const row = result.recordset[0];

    // OBJECT_ID NULL = la cuenta actual no ve la vista. Lanzamos para que
    // withAccount reintente con la secundaria; si ninguna la ve, se propaga.
    if (!row || row.ObjectId === null) {
      throw new Error(
        `La vista "${qualified}" no existe en la base de datos "${target}".`
      );
    }

    // Definición NULL = vista cifrada (WITH ENCRYPTION) o sin VIEW DEFINITION.
    // Lanzamos para intentar con la otra cuenta antes de rendirnos.
    if (row.Definition === null) {
      throw new Error(
        `No se pudo leer la definición de "${qualified}" (posiblemente cifrada con WITH ENCRYPTION o sin permiso VIEW DEFINITION).`
      );
    }

    return row.Definition as string;
  });

  return { database: target, view: qualified, definition };
}
