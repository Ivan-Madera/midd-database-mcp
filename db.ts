import sql from "mssql";

// ── Configuración ────────────────────────────────────────────────────────────

interface Credentials {
  user: string;
  password: string;
}

interface DbConfig {
  host: string;
  /** Cuenta principal (requerida). */
  primary: Credentials;
  /** Cuenta secundaria opcional. Si está presente, se usa como fallback. */
  secondary: Credentials | null;
  defaultDatabase: string | undefined;
  encrypt: boolean;
  trustServerCertificate: boolean;
  allowedDatabases: string[]; // vacío = todas las BD accesibles
  idleTimeoutMs: number; // 0 = nunca cerrar por inactividad
}

/** Identifica cuál de las cuentas se está usando. */
export type AccountKind = "primary" | "secondary";

let config: DbConfig | null = null;

function loadConfig(): DbConfig {
  if (config) return config;

  const host = process.env.DB_HOST;
  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;

  if (!host || !user || !password) {
    const missing = [
      !host && "DB_HOST",
      !user && "DB_USER",
      !password && "DB_PASSWORD",
    ].filter(Boolean);
    throw new Error(`Variables de entorno faltantes: ${missing.join(", ")}`);
  }

  // Cuenta secundaria OPCIONAL. Solo se activa si AMBAS variables están
  // presentes; si falta una de las dos, se ignora por completo (sin error).
  const user2 = process.env.DB_USER2?.trim();
  const password2 = process.env.DB_PASSWORD2;
  const secondary: Credentials | null =
    user2 && password2 ? { user: user2, password: password2 } : null;

  const parseBool = (value: string | undefined, fallback: boolean): boolean => {
    if (value === undefined) return fallback;
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  };

  const allowedDatabases = (process.env.DB_ALLOWED_DATABASES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Idle timeout: cierra los pools tras N ms sin uso. Default 5 min. 0 = nunca.
  const parseNonNegativeInt = (value: string | undefined, fallback: number): number => {
    if (value === undefined || value.trim() === "") return fallback;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return fallback;
    return Math.floor(n);
  };

  config = {
    host,
    primary: { user, password },
    secondary,
    defaultDatabase: process.env.DB_NAME || undefined,
    // encrypt por defecto true (seguro); configurable con DB_ENCRYPT
    encrypt: parseBool(process.env.DB_ENCRYPT, true),
    // trustServerCertificate por defecto true (útil en dev); configurable
    trustServerCertificate: parseBool(process.env.DB_TRUST_SERVER_CERTIFICATE, true),
    allowedDatabases,
    idleTimeoutMs: parseNonNegativeInt(process.env.DB_IDLE_TIMEOUT_MS, 5 * 60 * 1000),
  };

  return config;
}

/** Indica si hay una cuenta secundaria de fallback configurada. */
export function hasSecondaryAccount(): boolean {
  return loadConfig().secondary !== null;
}

/** Credenciales de la cuenta indicada (null si la secundaria no existe). */
function getCredentials(account: AccountKind): Credentials | null {
  const cfg = loadConfig();
  return account === "primary" ? cfg.primary : cfg.secondary;
}

// ── Allowlist de bases de datos ───────────────────────────────────────────────

/**
 * Valida que la BD solicitada esté permitida según DB_ALLOWED_DATABASES.
 * Si la allowlist está vacía, se permiten todas las BD accesibles por la cuenta.
 * La comparación es case-insensitive.
 */
export function assertDatabaseAllowed(database: string): void {
  const { allowedDatabases } = loadConfig();
  if (allowedDatabases.length === 0) return;

  const allowed = allowedDatabases.some(
    (db) => db.toLowerCase() === database.toLowerCase()
  );
  if (!allowed) {
    throw new Error(
      `La base de datos "${database}" no está en la lista permitida (DB_ALLOWED_DATABASES).`
    );
  }
}

/** Devuelve la lista de BD permitidas por configuración (vacío = todas). */
export function getAllowedDatabases(): string[] {
  return loadConfig().allowedDatabases;
}

/**
 * Resuelve la BD objetivo: usa la provista o cae a DB_NAME (default).
 * Lanza si no hay ninguna y valida contra la allowlist.
 */
export function resolveDatabase(database?: string): string {
  const { defaultDatabase } = loadConfig();
  const target = database?.trim() || defaultDatabase;
  if (!target) {
    throw new Error(
      "No se especificó una base de datos y no hay DB_NAME por defecto configurado."
    );
  }
  assertDatabaseAllowed(target);
  return target;
}

// ── Pool por cuenta + base de datos (con caché) ────────────────────────────────
// La clave combina la cuenta y la BD para no mezclar credenciales distintas
// sobre la misma base de datos.

const pools = new Map<string, sql.ConnectionPool>();
// Promesas en vuelo para evitar conexiones duplicadas por carreras.
const connecting = new Map<string, Promise<sql.ConnectionPool>>();
// Temporizadores de inactividad por pool.
const idleTimers = new Map<string, NodeJS.Timeout>();

function poolKey(account: AccountKind, database: string): string {
  return `${account}::${database.toLowerCase()}`;
}

/**
 * (Re)inicia el temporizador de inactividad de un pool. Al expirar, cierra
 * la conexión para liberar la sesión en el servidor. La siguiente llamada
 * a getPool() la reabrirá de forma transparente.
 */
function scheduleIdleClose(key: string): void {
  const { idleTimeoutMs } = loadConfig();

  const prev = idleTimers.get(key);
  if (prev) clearTimeout(prev);

  if (idleTimeoutMs <= 0) return; // 0 = nunca cerrar por inactividad

  const timer = setTimeout(() => {
    idleTimers.delete(key);
    const pool = pools.get(key);
    if (!pool) return;
    pools.delete(key);
    void pool
      .close()
      .then(() => {
        console.error(`[db] Pool "${key}" cerrado por inactividad (${idleTimeoutMs} ms).`);
      })
      .catch(() => {
        /* ignorar errores al cerrar */
      });
  }, idleTimeoutMs);

  // No mantener vivo el proceso solo por este temporizador.
  timer.unref?.();
  idleTimers.set(key, timer);
}

/**
 * Obtiene (o crea) un pool de conexiones para la cuenta y BD indicadas.
 * Si no se indica BD, usa DB_NAME. Reconecta si el pool quedó caído.
 * Cada uso reinicia el temporizador de inactividad del pool.
 */
export async function getPool(
  database?: string,
  account: AccountKind = "primary"
): Promise<sql.ConnectionPool> {
  const cfg = loadConfig();
  const target = resolveDatabase(database);
  const credentials = getCredentials(account);
  if (!credentials) {
    throw new Error(`No hay credenciales configuradas para la cuenta "${account}".`);
  }

  const key = poolKey(account, target);

  const existing = pools.get(key);
  if (existing && existing.connected) {
    scheduleIdleClose(key);
    return existing;
  }

  // Limpiar un pool caído antes de reconectar.
  if (existing && !existing.connected) {
    pools.delete(key);
    try {
      await existing.close();
    } catch {
      /* ignorar errores al cerrar un pool ya caído */
    }
  }

  const inFlight = connecting.get(key);
  if (inFlight) return inFlight;

  const connectPromise = (async () => {
    const pool = new sql.ConnectionPool({
      user: credentials.user,
      password: credentials.password,
      server: cfg.host,
      database: target,
      options: {
        encrypt: cfg.encrypt,
        trustServerCertificate: cfg.trustServerCertificate,
      },
    });

    // Evita que un error de red tire el proceso.
    pool.on("error", (err) => {
      console.error(`[db] Error en el pool "${key}":`, err.message);
    });

    await pool.connect();
    pools.set(key, pool);
    scheduleIdleClose(key);
    return pool;
  })();

  connecting.set(key, connectPromise);
  try {
    return await connectPromise;
  } finally {
    connecting.delete(key);
  }
}

// ── Ejecución con fallback a la cuenta secundaria ──────────────────────────────

/** Contexto que recibe el callback de `withAccount`. */
export interface AccountRunContext {
  pool: sql.ConnectionPool;
  account: AccountKind;
  database: string;
}

/**
 * Ejecuta `fn` contra la BD indicada usando la cuenta principal y, si hay una
 * cuenta secundaria configurada, reintenta con ella SOLO cuando la cuenta
 * principal lanza un error (típicamente falta de permiso a la BD/objeto).
 *
 * Un resultado vacío (0 filas) NO dispara el fallback: significa que la cuenta
 * principal sí pudo consultar y simplemente no había coincidencias.
 *
 * Si ambas cuentas fallan, relanza el error de la secundaria (o el de la
 * principal si no hay secundaria).
 */
export async function withAccount<T>(
  database: string | undefined,
  fn: (ctx: AccountRunContext) => Promise<T>
): Promise<T> {
  const target = resolveDatabase(database);
  const accounts: AccountKind[] = hasSecondaryAccount()
    ? ["primary", "secondary"]
    : ["primary"];

  let lastError: unknown;

  for (const account of accounts) {
    try {
      const pool = await getPool(target, account);
      return await fn({ pool, account, database: target });
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (account === "primary" && accounts.length > 1) {
        console.error(
          `[db] Cuenta principal falló en "${target}" (${message}); probando cuenta secundaria.`
        );
        continue;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? "Error desconocido al ejecutar la consulta."));
}

/** Cierra todos los pools abiertos y cancela los temporizadores de inactividad. */
export async function closePool(): Promise<void> {
  for (const timer of idleTimers.values()) clearTimeout(timer);
  idleTimers.clear();

  const all = Array.from(pools.values());
  pools.clear();
  await Promise.allSettled(all.map((p) => p.close()));
}
