import { resolveDatabase, withAccount } from "../db";
import { parseTableName } from "./sqlIdentifier";
import sql from "mssql";

export interface ColumnInfo {
  name: string;
  type: string;
  maxLength: number | null;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  default: string | null;
  isIdentity: boolean;
  isPrimaryKey: boolean;
  ordinalPosition: number;
}

export interface DescribeTableResult {
  database: string;
  table: string;
  columns: ColumnInfo[];
  primaryKey: string[];
}

/**
 * Describe una tabla en formato estructurado (JSON): columnas con tipos,
 * nullabilidad, defaults, IDENTITY y marca de PK. Más consumible que un DDL.
 */
export async function describeTable(
  table: string,
  database?: string
): Promise<DescribeTableResult> {
  if (!table || typeof table !== "string") {
    throw new Error("El nombre de la tabla es requerido y debe ser un string.");
  }

  const { schema: schemaName, name: tableName } = parseTableName(table);
  const target = resolveDatabase(database);

  // Ejecuta con la cuenta principal y, si falla por permisos o no ve la tabla,
  // reintenta con la cuenta secundaria si está configurada.
  const columns = await withAccount(target, async ({ pool }) => {
    const result = await pool
      .request()
      .input("tableName", sql.NVarChar, tableName)
      .input("schemaName", sql.NVarChar, schemaName)
      .query(`
          SELECT
            c.COLUMN_NAME,
            c.DATA_TYPE,
            c.CHARACTER_MAXIMUM_LENGTH,
            c.NUMERIC_PRECISION,
            c.NUMERIC_SCALE,
            c.IS_NULLABLE,
            c.COLUMN_DEFAULT,
            c.ORDINAL_POSITION,
            COLUMNPROPERTY(OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME)), c.COLUMN_NAME, 'IsIdentity') AS IS_IDENTITY,
            CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PK
          FROM INFORMATION_SCHEMA.COLUMNS c
          LEFT JOIN (
            SELECT kcu.COLUMN_NAME
            FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
            JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
              ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
             AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
            WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
              AND tc.TABLE_NAME = @tableName
              AND tc.TABLE_SCHEMA = @schemaName
          ) pk ON pk.COLUMN_NAME = c.COLUMN_NAME
          WHERE c.TABLE_NAME = @tableName AND c.TABLE_SCHEMA = @schemaName
          ORDER BY c.ORDINAL_POSITION
        `);

    const cols = result.recordset.map((r) => ({
      name: r.COLUMN_NAME as string,
      type: (r.DATA_TYPE as string).toUpperCase(),
      maxLength: r.CHARACTER_MAXIMUM_LENGTH as number | null,
      precision: r.NUMERIC_PRECISION as number | null,
      scale: r.NUMERIC_SCALE as number | null,
      nullable: r.IS_NULLABLE === "YES",
      default: r.COLUMN_DEFAULT as string | null,
      isIdentity: r.IS_IDENTITY === 1,
      isPrimaryKey: r.IS_PK === 1,
      ordinalPosition: r.ORDINAL_POSITION as number,
    })) as ColumnInfo[];

    // Sin columnas = la cuenta actual no ve la tabla. Lanzamos para que
    // withAccount reintente con la cuenta secundaria; si ninguna la ve,
    // este error se propaga.
    if (!cols.length) {
      throw new Error(`La tabla "${schemaName}.${tableName}" no existe en la base de datos "${target}".`);
    }
    return cols;
  });

  const primaryKey = columns.filter((c) => c.isPrimaryKey).map((c) => c.name);

  return { database: target, table: `${schemaName}.${tableName}`, columns, primaryKey };
}
