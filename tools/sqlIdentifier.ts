/**
 * Utilidades para manejar identificadores de SQL Server de forma segura.
 */

/**
 * Escapa un identificador para usarlo entre corchetes: [identificador].
 * Duplica cualquier "]" para evitar romper el bracket quoting / inyección.
 */
export function quoteIdentifier(name: string): string {
  return `[${name.replace(/\]/g, "]]")}]`;
}

/**
 * Separa un nombre de tabla que puede venir como "schema.tabla" o "tabla".
 * Si no trae schema, usa "dbo" por defecto.
 */
export function parseTableName(table: string): { schema: string; name: string } {
  const trimmed = table.trim();
  const dotIndex = trimmed.indexOf(".");
  if (dotIndex === -1) {
    return { schema: "dbo", name: trimmed };
  }
  return {
    schema: trimmed.slice(0, dotIndex),
    name: trimmed.slice(dotIndex + 1),
  };
}
