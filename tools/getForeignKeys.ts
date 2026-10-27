import { resolveDatabase, withAccount } from "../db";
import { parseTableName } from "./sqlIdentifier";
import sql from "mssql";

export interface ForeignKey {
  name: string;
  column: string;
  referencedSchema: string;
  referencedTable: string;
  referencedColumn: string;
}

export interface GetForeignKeysResult {
  database: string;
  table: string;
  foreignKeys: ForeignKey[];
}

/**
 * Obtiene las claves foráneas (FK) de una tabla: columna origen y la
 * tabla/columna referenciada. Usa las vistas sys.* para mayor fidelidad.
 */
export async function getForeignKeys(
  table: string,
  database?: string
): Promise<GetForeignKeysResult> {
  if (!table || typeof table !== "string") {
    throw new Error("El nombre de la tabla es requerido y debe ser un string.");
  }

  const { schema: schemaName, name: tableName } = parseTableName(table);
  const target = resolveDatabase(database);

  // Ejecuta con la cuenta principal y, si falla por permisos o no ve la tabla,
  // reintenta con la cuenta secundaria si está configurada. Una tabla sin FKs
  // (0 filas) es válido y NO dispara el fallback; por eso comprobamos aparte
  // si la tabla es visible para la cuenta actual.
  const foreignKeys = await withAccount(target, async ({ pool }) => {
    // ¿La cuenta actual ve la tabla? Si no, lanzamos para forzar el fallback.
    const existsResult = await pool
      .request()
      .input("tableName", sql.NVarChar, tableName)
      .input("schemaName", sql.NVarChar, schemaName)
      .query(`
        SELECT 1
        FROM sys.tables t
        JOIN sys.schemas s ON s.schema_id = t.schema_id
        WHERE t.name = @tableName AND s.name = @schemaName
      `);

    if (!existsResult.recordset.length) {
      throw new Error(`La tabla "${schemaName}.${tableName}" no existe en la base de datos "${target}".`);
    }

    const result = await pool
      .request()
      .input("tableName", sql.NVarChar, tableName)
      .input("schemaName", sql.NVarChar, schemaName)
      .query(`
        SELECT
          fk.name AS FK_NAME,
          cpa.name AS COLUMN_NAME,
          rs.name AS REF_SCHEMA,
          rt.name AS REF_TABLE,
          cref.name AS REF_COLUMN
        FROM sys.foreign_keys fk
        JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
        JOIN sys.tables pt ON pt.object_id = fk.parent_object_id
        JOIN sys.schemas ps ON ps.schema_id = pt.schema_id
        JOIN sys.columns cpa ON cpa.object_id = pt.object_id AND cpa.column_id = fkc.parent_column_id
        JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id
        JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
        JOIN sys.columns cref ON cref.object_id = rt.object_id AND cref.column_id = fkc.referenced_column_id
        WHERE pt.name = @tableName AND ps.name = @schemaName
        ORDER BY fk.name, fkc.constraint_column_id
      `);

    return result.recordset.map((r) => ({
      name: r.FK_NAME as string,
      column: r.COLUMN_NAME as string,
      referencedSchema: r.REF_SCHEMA as string,
      referencedTable: r.REF_TABLE as string,
      referencedColumn: r.REF_COLUMN as string,
    })) as ForeignKey[];
  });

  return { database: target, table: `${schemaName}.${tableName}`, foreignKeys };
}
