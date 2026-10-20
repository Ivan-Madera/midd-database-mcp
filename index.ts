import path from "path";
import dotenv from "dotenv";

// Carga el .env desde la raíz del proyecto, funcione en dev (ts-node, __dirname = raíz)
// o compilado (node dist/index.js, __dirname = dist/). No sobreescribe variables ya
// presentes en el entorno del sistema.
dotenv.config({ path: path.resolve(__dirname, ".env") });
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { listDatabases } from "./tools/listDatabases";
import { listTables } from "./tools/listTables";
import { getDDL } from "./tools/getDDL";
import { describeTable } from "./tools/describeTable";
import { getForeignKeys } from "./tools/getForeignKeys";
import { searchTables } from "./tools/searchTables";
import { searchColumns } from "./tools/searchColumns";
import { closePool } from "./db";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Respuesta de texto plano. */
function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

/** Respuesta JSON formateada. */
function json(value: unknown) {
  return text(JSON.stringify(value, null, 2));
}

/** Respuesta de error. */
function errorResponse(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

// ── Servidor MCP ────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "midd-database-mcp",
  version: "1.1.0",
});

const databaseParam = {
  database: z
    .string()
    .optional()
    .describe("Base de datos objetivo. Si se omite, usa DB_NAME por defecto."),
};

// ── Tool: list_databases ──────────────────────────────────────────────────────

// @ts-ignore - Evita error TS2589: Type instantiation is excessively deep
server.tool(
  "list_databases",
  "Lista las bases de datos del servidor a las que la cuenta tiene acceso (excluye las de sistema y respeta la allowlist).",
  {},
  async () => {
    try {
      const result = await listDatabases();
      return json(result.databases);
    } catch (err) {
      return errorResponse(err);
    }
  }
);

// ── Tool: list_tables ───────────────────────────────────────────────────────

// @ts-ignore - Evita error TS2589: Type instantiation is excessively deep
server.tool(
  "list_tables",
  "Lista todas las tablas de una base de datos. Acepta 'database' opcional.",
  databaseParam,
  async ({ database }) => {
    try {
      const result = await listTables(database);
      return json(result.tables);
    } catch (err) {
      return errorResponse(err);
    }
  }
);

// ── Tool: get_ddl ───────────────────────────────────────────────────────────

// @ts-ignore - Evita error TS2589: Type instantiation is excessively deep
server.tool(
  "get_ddl",
  "Obtiene un CREATE TABLE sintético (columnas, tipos, IDENTITY, DEFAULT y PRIMARY KEY) de una tabla.",
  {
    table: z.string().describe("Nombre de la tabla ('schema.tabla' o 'tabla')."),
    ...databaseParam,
  },
  async ({ table, database }) => {
    try {
      const result = await getDDL(table, database);
      return text(result.ddl);
    } catch (err) {
      return errorResponse(err);
    }
  }
);

// ── Tool: describe_table ──────────────────────────────────────────────────────

// @ts-ignore - Evita error TS2589: Type instantiation is excessively deep
server.tool(
  "describe_table",
  "Describe una tabla en JSON estructurado: columnas (tipo, nullabilidad, default, IDENTITY, PK) y lista de PK.",
  {
    table: z.string().describe("Nombre de la tabla ('schema.tabla' o 'tabla')."),
    ...databaseParam,
  },
  async ({ table, database }) => {
    try {
      const result = await describeTable(table, database);
      return json(result);
    } catch (err) {
      return errorResponse(err);
    }
  }
);

// ── Tool: get_foreign_keys ────────────────────────────────────────────────────

// @ts-ignore - Evita error TS2589: Type instantiation is excessively deep
server.tool(
  "get_foreign_keys",
  "Lista las claves foráneas (FK) de una tabla: columna origen y tabla/columna referenciada.",
  {
    table: z.string().describe("Nombre de la tabla ('schema.tabla' o 'tabla')."),
    ...databaseParam,
  },
  async ({ table, database }) => {
    try {
      const result = await getForeignKeys(table, database);
      return json(result);
    } catch (err) {
      return errorResponse(err);
    }
  }
);

// ── Tool: search_tables ───────────────────────────────────────────────────────

// @ts-ignore - Evita error TS2589: Type instantiation is excessively deep
server.tool(
  "search_tables",
  "Busca tablas por nombre (coincidencia parcial) en una BD o en todas las accesibles si se omite 'database'.",
  {
    pattern: z.string().describe("Texto a buscar dentro del nombre de la tabla."),
    ...databaseParam,
  },
  async ({ pattern, database }) => {
    try {
      const result = await searchTables(pattern, database);
      return json(result.matches);
    } catch (err) {
      return errorResponse(err);
    }
  }
);

// ── Tool: search_columns ──────────────────────────────────────────────────────

// @ts-ignore - Evita error TS2589: Type instantiation is excessively deep
server.tool(
  "search_columns",
  "Busca columnas por nombre (coincidencia parcial) en una BD o en todas las accesibles si se omite 'database'.",
  {
    pattern: z.string().describe("Texto a buscar dentro del nombre de la columna."),
    ...databaseParam,
  },
  async ({ pattern, database }) => {
    try {
      const result = await searchColumns(pattern, database);
      return json(result.matches);
    } catch (err) {
      return errorResponse(err);
    }
  }
);

// ── Inicio ──────────────────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  await closePool();
  process.exit(0);
}

async function main(): Promise<void> {
  console.error("Iniciando MCP midd-database-mcp...");
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Error fatal al iniciar el servidor MCP:", err);
  process.exit(1);
});
