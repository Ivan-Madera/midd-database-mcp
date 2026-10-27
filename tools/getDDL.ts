import { resolveDatabase, withAccount } from "../db";
import { quoteIdentifier, parseTableName } from "./sqlIdentifier";
import sql from "mssql";

export interface GetDDLResult {
  database: string;
  table: string;
  ddl: string;
}

interface ColumnRow {
  COLUMN_NAME: string;
  DATA_TYPE: string;
  CHARACTER_MAXIMUM_LENGTH: number | null;
  NUMERIC_PRECISION: number | null;
  NUMERIC_SCALE: number | null;
  IS_NULLABLE: string;
  COLUMN_DEFAULT: string | null;
  IS_IDENTITY: number;
}

/** Construye la cadena de tipo (incluye longitud, precisión y escala). */
function formatType(c: ColumnRow): string {
  const type = c.DATA_TYPE.toUpperCase();

  // Tipos con longitud de caracteres.
  if (c.CHARACTER_MAXIMUM_LENGTH !== null) {
    const length = c.CHARACTER_MAXIMUM_LENGTH === -1 ? "MAX" : c.CHARACTER_MAXIMUM_LENGTH;
    return `${type}(${length})`;
  }

  // Tipos numéricos con precisión/escala.
  if (["DECIMAL", "NUMERIC"].includes(type) && c.NUMERIC_PRECISION !== null) {
    return `${type}(${c.NUMERIC_PRECISION},${c.NUMERIC_SCALE ?? 0})`;
  }

  return type;
}

/**
 * Genera un CREATE TABLE sintético con columnas (tipo, longitud/precisión,
 * nullabilidad, IDENTITY, DEFAULT) y la PRIMARY KEY si existe.
 */
export async function getDDL(table: string, database?: string): Promise<GetDDLResult> {
  if (!table || typeof table !== "string") {
    throw new Error("El nombre de la tabla es requerido y debe ser un string.");
  }

  const { schema: schemaName, name: tableName } = parseTableName(table);
  const target = resolveDatabase(database);

  // Ambas consultas (columnas y PK) se ejecutan con la MISMA cuenta para no
  // mezclar credenciales. Si la cuenta principal falla por permisos o no ve la
  // tabla, se reintenta todo con la cuenta secundaria; si ninguna la ve, el
  // error se propaga.
  const definitions = await withAccount(target, async ({ pool }) => {
    // Columnas, incluyendo defaults, precisión/escala e IDENTITY.
    const columnsResult = await pool
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
            COLUMNPROPERTY(OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME)), c.COLUMN_NAME, 'IsIdentity') AS IS_IDENTITY
          FROM INFORMATION_SCHEMA.COLUMNS c
          WHERE c.TABLE_NAME = @tableName AND c.TABLE_SCHEMA = @schemaName
          ORDER BY c.ORDINAL_POSITION
        `);

    // Sin columnas = la cuenta actual no ve la tabla. Lanzamos para que
    // withAccount reintente con la secundaria; si ninguna la ve, se propaga.
    if (!columnsResult.recordset.length) {
      throw new Error(`La tabla "${schemaName}.${tableName}" no existe en la base de datos "${target}".`);
    }

    const columns = (columnsResult.recordset as ColumnRow[]).map((c) => {
      const parts = [`  ${quoteIdentifier(c.COLUMN_NAME)} ${formatType(c)}`];
      if (c.IS_IDENTITY === 1) parts.push("IDENTITY(1,1)");
      parts.push(c.IS_NULLABLE === "YES" ? "NULL" : "NOT NULL");
      if (c.COLUMN_DEFAULT !== null) parts.push(`DEFAULT ${c.COLUMN_DEFAULT}`);
      return parts.join(" ");
    });

    // Primary key.
    const pkResult = await pool
      .request()
      .input("tableName", sql.NVarChar, tableName)
      .input("schemaName", sql.NVarChar, schemaName)
      .query(`
        SELECT kcu.COLUMN_NAME, kcu.ORDINAL_POSITION
        FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
        JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
          ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
         AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
        WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
          AND tc.TABLE_NAME = @tableName
          AND tc.TABLE_SCHEMA = @schemaName
        ORDER BY kcu.ORDINAL_POSITION
      `);

    const defs = [...columns];
    if (pkResult.recordset.length) {
      const pkCols = pkResult.recordset
        .map((r) => quoteIdentifier(r.COLUMN_NAME as string))
        .join(", ");
      defs.push(`  PRIMARY KEY (${pkCols})`);
    }
    return defs;
  });

  const ddl = `CREATE TABLE ${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)} (\n${definitions.join(",\n")}\n);`;

  return { database: target, table: `${schemaName}.${tableName}`, ddl };
}
