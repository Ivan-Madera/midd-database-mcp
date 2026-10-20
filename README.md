# midd-database-mcp

Servidor **MCP (Model Context Protocol)** local para **introspección de esquema de SQL Server**, con soporte **multi-base de datos**. Permite que un cliente MCP (Kiro, Claude Desktop, etc.) explore el esquema de una o varias bases de datos de un mismo servidor: listar BDs y tablas, obtener DDL, describir tablas en JSON, ver claves foráneas y buscar tablas/columnas por nombre.

> Es **solo lectura / introspección**. No ejecuta DML ni DDL sobre la base de datos; únicamente consulta las vistas de catálogo (`INFORMATION_SCHEMA` y `sys.*`).

---

## Requisitos

- **Node.js ≥ 20.6**
- Acceso de red al servidor SQL Server y una cuenta con permiso de lectura sobre las BDs que quieras inspeccionar.

## Instalación

```bash
npm install
```

## Configuración

Copia `.env.example` a `.env` y completa los valores:

```bash
cp .env.example .env
```

| Variable                      | Requerido | Default     | Descripción                                                                                   |
| ----------------------------- | --------- | ----------- | --------------------------------------------------------------------------------------------- |
| `DB_HOST`                     | Sí        | —           | Host/servidor de SQL Server.                                                                  |
| `DB_USER`                     | Sí        | —           | Usuario.                                                                                      |
| `DB_PASSWORD`                 | Sí        | —           | Contraseña.                                                                                   |
| `DB_NAME`                     | No        | —           | BD por defecto. Se usa cuando una tool no recibe `database`. Si se omite, `database` es obligatorio en cada llamada. |
| `DB_ALLOWED_DATABASES`        | No        | (todas)     | Allowlist separada por comas. Si está vacía, se permiten todas las BD accesibles por la cuenta. |
| `DB_ENCRYPT`                  | No        | `true`      | Cifra la conexión TLS.                                                                        |
| `DB_TRUST_SERVER_CERTIFICATE` | No        | `true`      | Acepta certificados no verificados. Útil en dev; ponlo en `false` en producción con cert válido. |

> **Seguridad:** `.env` está en `.gitignore` y no debe versionarse. Si tu cuenta ve BDs sensibles que no quieres exponer al modelo, usa `DB_ALLOWED_DATABASES` para limitar el alcance.

## Ejecución

```bash
# Desarrollo (TypeScript directo)
npm run dev

# Producción (compilar y correr)
npm run build
npm start
```

El servidor se comunica por **stdio** (entrada/salida estándar), que es como los clientes MCP lo invocan.

## Registro en un cliente MCP

Ejemplo de configuración (`mcp.json`):

```json
{
  "mcpServers": {
    "midd-database": {
      "command": "node",
      "args": ["C:/Propuestas/midd-database-mcp/dist/index.js"],
      "disabled": false
    }
  }
}
```

Alternativamente, para desarrollo puedes usar `ts-node` apuntando a `index.ts`.

---

## Comandos (tools) disponibles

Todas las tools que operan sobre una BD aceptan un parámetro opcional **`database`**. Si se omite, se usa `DB_NAME`. El nombre de tabla acepta el formato `schema.tabla` o solo `tabla` (en cuyo caso el schema por defecto es `dbo`).

### `list_databases`

Lista las bases de datos del servidor a las que la cuenta tiene acceso. Excluye las de sistema (`master`, `model`, `msdb`, `tempdb`) y respeta `DB_ALLOWED_DATABASES`.

- **Parámetros:** ninguno.
- **Devuelve:** array de nombres de BD.

```json
["MacropayPF", "Ventas", "RRHH"]
```

### `list_tables`

Lista todas las tablas base de una BD.

- **Parámetros:** `database?` (string, opcional).
- **Devuelve:** array de `schema.tabla`.

```json
["dbo.Clientes", "dbo.Pedidos", "ventas.Facturas"]
```

### `get_ddl`

Genera un `CREATE TABLE` sintético de una tabla, incluyendo tipos con longitud/precisión, `IDENTITY`, `DEFAULT` y la `PRIMARY KEY`.

- **Parámetros:** `table` (string, requerido), `database?` (string, opcional).
- **Devuelve:** texto con el DDL.

```sql
CREATE TABLE [dbo].[Clientes] (
  [Id] INT IDENTITY(1,1) NOT NULL,
  [Nombre] NVARCHAR(100) NOT NULL,
  [Saldo] DECIMAL(18,2) NULL DEFAULT ((0)),
  PRIMARY KEY ([Id])
);
```

### `describe_table`

Describe una tabla en **JSON estructurado**: cada columna con su tipo, nullabilidad, default, si es `IDENTITY` y si forma parte de la PK. Más fácil de consumir programáticamente que el DDL de texto.

- **Parámetros:** `table` (string, requerido), `database?` (string, opcional).
- **Devuelve:** objeto `{ database, table, columns[], primaryKey[] }`.

```json
{
  "database": "MacropayPF",
  "table": "dbo.Clientes",
  "columns": [
    {
      "name": "Id",
      "type": "INT",
      "maxLength": null,
      "precision": 10,
      "scale": 0,
      "nullable": false,
      "default": null,
      "isIdentity": true,
      "isPrimaryKey": true,
      "ordinalPosition": 1
    }
  ],
  "primaryKey": ["Id"]
}
```

### `get_foreign_keys`

Lista las claves foráneas de una tabla: columna origen y tabla/columna referenciada.

- **Parámetros:** `table` (string, requerido), `database?` (string, opcional).
- **Devuelve:** objeto `{ database, table, foreignKeys[] }`.

```json
{
  "database": "MacropayPF",
  "table": "dbo.Pedidos",
  "foreignKeys": [
    {
      "name": "FK_Pedidos_Clientes",
      "column": "ClienteId",
      "referencedSchema": "dbo",
      "referencedTable": "Clientes",
      "referencedColumn": "Id"
    }
  ]
}
```

### `search_tables`

Busca tablas cuyo nombre **contenga** el patrón (coincidencia parcial, case-insensitive). Si se indica `database`, busca solo ahí; si se omite, recorre **todas** las BD accesibles (respetando la allowlist).

- **Parámetros:** `pattern` (string, requerido), `database?` (string, opcional).
- **Devuelve:** array de `{ database, schema, table }`.

```json
[
  { "database": "MacropayPF", "schema": "dbo", "table": "Clientes" },
  { "database": "Ventas", "schema": "dbo", "table": "ClientesVIP" }
]
```

### `search_columns`

Busca columnas cuyo nombre **contenga** el patrón. Muy útil para encontrar en qué tabla (y BD) vive un campo como `email` o `id_cliente`. Si se omite `database`, recorre todas las BD accesibles.

- **Parámetros:** `pattern` (string, requerido), `database?` (string, opcional).
- **Devuelve:** array de `{ database, schema, table, column, type }`.

```json
[
  {
    "database": "MacropayPF",
    "schema": "dbo",
    "table": "Clientes",
    "column": "Email",
    "type": "NVARCHAR"
  }
]
```

---

## Flujo de uso típico

Para descubrir un esquema que no conoces:

1. **`list_databases`** → ver qué BDs tienes disponibles.
2. **`search_tables`** o **`list_tables`** → ubicar la tabla de interés.
3. **`describe_table`** o **`get_ddl`** → ver su estructura.
4. **`get_foreign_keys`** → entender sus relaciones.
5. **`search_columns`** → cuando buscas un campo pero no sabes en qué tabla está.

## Notas de diseño

- **Un pool de conexiones por base de datos**, cacheado y con reconexión automática si se cae.
- Los **identificadores se escapan** (`]` → `]]`) y los valores de búsqueda van **parametrizados**, evitando inyección en las consultas de catálogo.
- Las búsquedas multi-BD son **tolerantes a fallos**: si una BD no es accesible, se omite y la búsqueda continúa en el resto.

## Estructura del proyecto

```
.
├── index.ts               # Servidor MCP y registro de tools
├── db.ts                  # Config, allowlist y pool por BD
├── tools/
│   ├── sqlIdentifier.ts   # Escape de identificadores y parseo de nombres
│   ├── listDatabases.ts
│   ├── listTables.ts
│   ├── getDDL.ts
│   ├── describeTable.ts
│   ├── getForeignKeys.ts
│   ├── searchTables.ts
│   └── searchColumns.ts
├── .env.example
├── package.json
└── tsconfig.json
```
