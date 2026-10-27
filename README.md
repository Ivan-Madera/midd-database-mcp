# midd-database-mcp

Servidor **MCP (Model Context Protocol)** local para **introspección de esquema de SQL Server**, con soporte **multi-base de datos**. Permite que un cliente MCP (Kiro, Claude Desktop, etc.) explore el esquema de una o varias bases de datos de un mismo servidor: listar BDs, tablas, vistas y stored procedures, obtener DDL, describir tablas, vistas y procedimientos en JSON, ver claves foráneas, leer la definición de una vista o un procedimiento y buscar tablas/columnas por nombre.

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
| `DB_USER2`                    | No        | —           | Usuario de la cuenta de respaldo. Ver *Cuenta secundaria de respaldo*.                        |
| `DB_PASSWORD2`                | No        | —           | Contraseña de la cuenta de respaldo. Debe ir junto con `DB_USER2`.                            |
| `DB_NAME`                     | No        | —           | BD por defecto. Se usa cuando una tool no recibe `database`. Si se omite, `database` es obligatorio en cada llamada. |
| `DB_ALLOWED_DATABASES`        | No        | (todas)     | Allowlist separada por comas. Si está vacía, se permiten todas las BD accesibles por la cuenta. |
| `DB_ENCRYPT`                  | No        | `true`      | Cifra la conexión TLS.                                                                        |
| `DB_TRUST_SERVER_CERTIFICATE` | No        | `true`      | Acepta certificados no verificados. Útil en dev; ponlo en `false` en producción con cert válido. |
| `DB_IDLE_TIMEOUT_MS`          | No        | `300000`    | Cierra los pools de conexión tras N ms sin uso para liberar sesiones en el servidor. `0` = nunca. |

> **Seguridad:** `.env` está en `.gitignore` y no debe versionarse. Si tu cuenta ve BDs sensibles que no quieres exponer al modelo, usa `DB_ALLOWED_DATABASES` para limitar el alcance.

### Cuenta secundaria de respaldo (opcional)

A veces la cuenta principal no tiene permiso sobre todos los componentes. Para
cubrir esos huecos puedes configurar una segunda cuenta **opcional** con
`DB_USER2` y `DB_PASSWORD2`:

- Solo se activa si **ambas** variables están definidas. Si falta cualquiera de
  las dos, la cuenta secundaria se ignora por completo (sin error): el servidor
  se comporta igual que antes.
- Cuando está configurada, cada consulta se intenta primero con la cuenta
  principal y se reintenta con la secundaria si la principal **falla**
  (típicamente por falta de permiso a la BD u objeto).
- En las tools sobre un objeto concreto (`describe_table`, `get_ddl`,
  `get_foreign_keys`, `describe_procedure`, `get_procedure_definition`,
  `describe_view`, `get_view_definition`), si la cuenta principal **no ve el
  objeto** también se reintenta con la secundaria; si ninguna de las dos lo ve,
  el error "no existe" se propaga. En `get_procedure_definition` y
  `get_view_definition`, además, si la definición no se puede leer (objeto
  cifrado con `WITH ENCRYPTION` o sin `VIEW DEFINITION`) también se intenta con
  la otra cuenta.
- En las tools de listado y búsqueda (`list_databases`, `list_tables`,
  `list_views`, `list_procedures`, `search_tables`, `search_columns`), un
  resultado vacío **no** dispara el fallback: significa que la cuenta sí pudo
  consultar y no había coincidencias.
- Las conexiones de cada cuenta se mantienen en pools separados, por lo que no
  se mezclan credenciales.

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

**¿Qué hace?** Te dice qué bases de datos puedes ver con tu usuario. Es el primer paso cuando no sabes qué hay disponible en el servidor.

No muestra las bases de datos internas del sistema (`master`, `model`, `msdb`, `tempdb`), y si configuraste una lista permitida (`DB_ALLOWED_DATABASES`), solo muestra esas.

- **Parámetros:** ninguno.
- **Devuelve:** una lista con los nombres de las bases de datos.

```json
["MacropayPF", "Ventas", "RRHH"]
```

### `list_tables`

**¿Qué hace?** Te muestra todas las tablas que hay dentro de una base de datos. Útil para ver qué información se guarda ahí.

Si no indicas una base de datos, usa la que tengas puesta por defecto (`DB_NAME`).

- **Parámetros:** `database` (opcional) — el nombre de la base de datos.
- **Devuelve:** una lista de tablas en formato `esquema.tabla`.

```json
["dbo.Clientes", "dbo.Pedidos", "ventas.Facturas"]
```

### `get_ddl`

**¿Qué hace?** Te arma el "molde" de una tabla: la instrucción `CREATE TABLE` que la crearía desde cero. Sirve para ver de un vistazo qué columnas tiene, de qué tipo son, cuáles se pueden dejar vacías y cuál es la columna clave.

Incluye el tipo de cada columna (y su tamaño), si se genera sola (`IDENTITY`), el valor por defecto y la clave principal (`PRIMARY KEY`).

- **Parámetros:**
  - `table` (obligatorio) — el nombre de la tabla.
  - `database` (opcional) — la base de datos; si no la pones, usa la de por defecto.
- **Devuelve:** el texto de la tabla en formato SQL.

```sql
CREATE TABLE [dbo].[Clientes] (
  [Id] INT IDENTITY(1,1) NOT NULL,
  [Nombre] NVARCHAR(100) NOT NULL,
  [Saldo] DECIMAL(18,2) NULL DEFAULT ((0)),
  PRIMARY KEY ([Id])
);
```

### `describe_table`

**¿Qué hace?** Es parecido a `get_ddl`, pero en vez de darte texto SQL, te devuelve la información de la tabla ordenada en forma de datos (JSON). Es la mejor opción cuando otro programa (o la IA) necesita leer la estructura campo por campo.

Por cada columna te dice: su nombre, su tipo, si se puede dejar vacía, su valor por defecto, si se genera sola y si es parte de la clave principal.

- **Parámetros:**
  - `table` (obligatorio) — el nombre de la tabla.
  - `database` (opcional) — la base de datos; si no la pones, usa la de por defecto.
- **Devuelve:** un objeto con los datos de la tabla y sus columnas.

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

**¿Qué hace?** Te muestra cómo se conecta una tabla con otras. Las "claves foráneas" son columnas que apuntan a otra tabla (por ejemplo, la columna `ClienteId` de la tabla de pedidos apunta a la tabla de clientes). Sirve para entender qué tablas están relacionadas entre sí.

- **Parámetros:**
  - `table` (obligatorio) — el nombre de la tabla.
  - `database` (opcional) — la base de datos; si no la pones, usa la de por defecto.
- **Devuelve:** la lista de relaciones: qué columna apunta a qué tabla y columna.

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

**¿Qué hace?** Busca tablas por nombre, aunque solo sepas una parte. Por ejemplo, si buscas `cliente`, encuentra `Clientes`, `ClientesVIP`, etc. No distingue mayúsculas de minúsculas.

Si no indicas una base de datos, busca en **todas** las que puedes ver (muy útil cuando no recuerdas en cuál está la tabla).

- **Parámetros:**
  - `pattern` (obligatorio) — el texto a buscar dentro del nombre de la tabla.
  - `database` (opcional) — para buscar solo en una base de datos.
- **Devuelve:** la lista de tablas que coinciden, con su base de datos y esquema.

```json
[
  { "database": "MacropayPF", "schema": "dbo", "table": "Clientes" },
  { "database": "Ventas", "schema": "dbo", "table": "ClientesVIP" }
]
```

### `search_columns`

**¿Qué hace?** Busca columnas (campos) por nombre en cualquier tabla. Es la herramienta ideal cuando sabes qué dato buscas pero no en qué tabla está guardado. Por ejemplo, buscar `email` te dice en qué tablas existe una columna de correo.

Si no indicas una base de datos, busca en **todas** las que puedes ver.

- **Parámetros:**
  - `pattern` (obligatorio) — el texto a buscar dentro del nombre de la columna.
  - `database` (opcional) — para buscar solo en una base de datos.
- **Devuelve:** la lista de columnas que coinciden, indicando en qué base de datos, tabla y de qué tipo son.

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

### `list_procedures`

**¿Qué hace?** Te muestra todos los stored procedures (procedimientos almacenados) de una base de datos. Útil para ver qué lógica de negocio hay guardada en la BD. No incluye los procedimientos de sistema.

Si no indicas una base de datos, usa la que tengas puesta por defecto (`DB_NAME`).

- **Parámetros:** `database` (opcional) — el nombre de la base de datos.
- **Devuelve:** una lista de procedimientos en formato `esquema.procedimiento`.

```json
["dbo.sp_CrearCliente", "dbo.sp_ReporteVentas", "ventas.sp_CerrarMes"]
```

### `describe_procedure`

**¿Qué hace?** Te muestra los parámetros de un stored procedure sin tener que leer todo su código: cómo se llama cada parámetro, de qué tipo es y si es de entrada (`IN`), salida (`OUT`) o ambos (`INOUT`). Ideal para saber cómo invocar un procedimiento.

- **Parámetros:**
  - `procedure` (obligatorio) — el nombre del procedimiento.
  - `database` (opcional) — la base de datos; si no la pones, usa la de por defecto.
- **Devuelve:** un objeto con los datos del procedimiento y su lista de parámetros.

```json
{
  "database": "MacropayPF",
  "procedure": "dbo.sp_CrearCliente",
  "parameters": [
    {
      "name": "@Nombre",
      "type": "NVARCHAR",
      "maxLength": 100,
      "precision": null,
      "scale": null,
      "mode": "IN",
      "isResult": false,
      "ordinalPosition": 1
    },
    {
      "name": "@NuevoId",
      "type": "INT",
      "maxLength": null,
      "precision": 10,
      "scale": 0,
      "mode": "INOUT",
      "isResult": false,
      "ordinalPosition": 2
    }
  ]
}
```

### `get_procedure_definition`

**¿Qué hace?** Te devuelve el código completo del stored procedure (el texto `CREATE PROCEDURE ...`). Sirve para entender exactamente qué hace por dentro. Requiere el permiso `VIEW DEFINITION` sobre el objeto; si el procedimiento está cifrado (`WITH ENCRYPTION`) o la cuenta no tiene ese permiso, la definición no se puede leer (y ahí la cuenta secundaria de respaldo ayuda).

- **Parámetros:**
  - `procedure` (obligatorio) — el nombre del procedimiento.
  - `database` (opcional) — la base de datos; si no la pones, usa la de por defecto.
- **Devuelve:** el texto del procedimiento en formato SQL.

```sql
CREATE PROCEDURE [dbo].[sp_CrearCliente]
  @Nombre NVARCHAR(100),
  @NuevoId INT OUTPUT
AS
BEGIN
  INSERT INTO dbo.Clientes (Nombre) VALUES (@Nombre);
  SET @NuevoId = SCOPE_IDENTITY();
END
```

### `list_views`

**¿Qué hace?** Te muestra todas las vistas de una base de datos. Una vista es una consulta guardada que se comporta como una tabla virtual; útil para ver qué consultas predefinidas hay disponibles. No incluye las vistas de sistema.

Si no indicas una base de datos, usa la que tengas puesta por defecto (`DB_NAME`).

- **Parámetros:** `database` (opcional) — el nombre de la base de datos.
- **Devuelve:** una lista de vistas en formato `esquema.vista`.

```json
["dbo.vw_ClientesActivos", "ventas.vw_ResumenMensual"]
```

### `describe_view`

**¿Qué hace?** Te muestra las columnas que expone una vista, ordenadas en forma de datos (JSON): el nombre de cada columna, su tipo y si puede quedar vacía. A diferencia de una tabla, una vista no tiene columna que se genere sola (`IDENTITY`) ni clave principal propia, por eso el resultado se limita a las columnas.

- **Parámetros:**
  - `view` (obligatorio) — el nombre de la vista.
  - `database` (opcional) — la base de datos; si no la pones, usa la de por defecto.
- **Devuelve:** un objeto con los datos de la vista y sus columnas.

```json
{
  "database": "MacropayPF",
  "view": "dbo.vw_ClientesActivos",
  "columns": [
    {
      "name": "Id",
      "type": "INT",
      "maxLength": null,
      "precision": 10,
      "scale": 0,
      "nullable": false,
      "ordinalPosition": 1
    },
    {
      "name": "Nombre",
      "type": "NVARCHAR",
      "maxLength": 100,
      "precision": null,
      "scale": null,
      "nullable": false,
      "ordinalPosition": 2
    }
  ]
}
```

### `get_view_definition`

**¿Qué hace?** Te devuelve el código completo de la vista (el texto `CREATE VIEW ...`). Sirve para entender exactamente qué consulta ejecuta por dentro. Requiere el permiso `VIEW DEFINITION` sobre el objeto; si la vista está cifrada (`WITH ENCRYPTION`) o la cuenta no tiene ese permiso, la definición no se puede leer (y ahí la cuenta secundaria de respaldo ayuda).

- **Parámetros:**
  - `view` (obligatorio) — el nombre de la vista.
  - `database` (opcional) — la base de datos; si no la pones, usa la de por defecto.
- **Devuelve:** el texto de la vista en formato SQL.

```sql
CREATE VIEW [dbo].[vw_ClientesActivos]
AS
  SELECT Id, Nombre
  FROM dbo.Clientes
  WHERE Activo = 1
```

---

## Flujo de uso típico

Para descubrir un esquema que no conoces:

1. **`list_databases`** → ver qué BDs tienes disponibles.
2. **`search_tables`** o **`list_tables`** → ubicar la tabla de interés.
3. **`describe_table`** o **`get_ddl`** → ver su estructura.
4. **`get_foreign_keys`** → entender sus relaciones.
5. **`search_columns`** → cuando buscas un campo pero no sabes en qué tabla está.
6. **`list_procedures`** → ver qué stored procedures hay en la BD.
7. **`describe_procedure`** o **`get_procedure_definition`** → ver los parámetros o el código de un procedimiento.
8. **`list_views`** → ver qué vistas hay en la BD.
9. **`describe_view`** o **`get_view_definition`** → ver las columnas que expone una vista o el código que la define.

## Ciclo de vida y conexiones

Al usar transporte **stdio**, el proceso del servidor lo **arranca y detiene el cliente MCP**: vive mientras el cliente lo tenga conectado y se apaga al cerrarlo. No es un servicio que corra 24/7.

Las conexiones a la BD se manejan así:

- Se abren **de forma perezosa** (lazy): solo cuando una tool necesita una BD por primera vez.
- Se **cierran solas tras inactividad** (`DB_IDLE_TIMEOUT_MS`, 5 min por defecto) para no mantener sesiones ocupadas en el servidor. La siguiente llamada reconecta de forma transparente.

Resultado: el MCP responde al instante cuando lo usas y no deja conexiones colgando cuando no.

## Notas de diseño

- **Un pool de conexiones por base de datos**, cacheado y con reconexión automática si se cae.
- Los **identificadores se escapan** (`]` → `]]`) y los valores de búsqueda van **parametrizados**, evitando inyección en las consultas de catálogo.
- Las búsquedas multi-BD son **tolerantes a fallos**: si una BD no es accesible, se omite y la búsqueda continúa en el resto.
- El `.env` se carga con un cargador propio (`env.ts`) sin dependencias, para no escribir nada en **stdout** (canal reservado al protocolo MCP).

## Estructura del proyecto

```
.
├── index.ts               # Servidor MCP y registro de tools
├── env.ts                 # Carga del .env sin dependencias (stdout limpio)
├── db.ts                  # Config, allowlist, idle-timeout y pool por BD
├── tools/
│   ├── sqlIdentifier.ts   # Escape de identificadores y parseo de nombres
│   ├── listDatabases.ts
│   ├── listTables.ts
│   ├── getDDL.ts
│   ├── describeTable.ts
│   ├── getForeignKeys.ts
│   ├── searchTables.ts
│   ├── searchColumns.ts
│   ├── listProcedures.ts
│   ├── describeProcedure.ts
│   ├── getProcedureDefinition.ts
│   ├── listViews.ts
│   ├── describeView.ts
│   └── getViewDefinition.ts
├── .env.example
├── package.json
└── tsconfig.json
```
