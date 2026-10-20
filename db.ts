import sql from "mssql";

// ── Configuración ────────────────────────────────────────────────────────────

interface DbConfig {
  host: string;
  user: string;
  password: string;
  defaultDatabase: string | undefined;
  encrypt: boolean;
  trustServerCertificate: boolean;
  allowedDatabases: string[]; // vacío = todas las BD accesibles
}

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

  const parseBool = (value: string | undefined, fallback: boolean): boolean => {
    if (value === undefined) return fallback;
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  };

  const allowedDatabases = (process.env.DB_ALLOWED_DATABASES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  config = {
    host,
    user,
    password,
    defaultDatabase: process.env.DB_NAME || undefined,
    // encrypt por defecto true (seguro); configurable con DB_ENCRYPT
    encrypt: parseBool(process.env.DB_ENCRYPT, true),
    // trustServerCertificate por defecto true (útil en dev); configurable
    trustServerCertificate: parseBool(process.env.DB_TRUST_SERVER_CERTIFICATE, true),
    allowedDatabases,
  };

  return config;
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

// ── Pool por base de datos (con caché) ─────────────────────────────────────────

const pools = new Map<string, sql.ConnectionPool>();
// Promesas en vuelo para evitar conexiones duplicadas por carreras.
const connecting = new Map<string, Promise<sql.ConnectionPool>>();

/**
 * Obtiene (o crea) un pool de conexiones para la BD indicada.
 * Si no se indica, usa DB_NAME. Reconecta si el pool quedó caído.
 */
export async function getPool(database?: string): Promise<sql.ConnectionPool> {
  const cfg = loadConfig();
  const target = resolveDatabase(database);
  const key = target.toLowerCase();

  const existing = pools.get(key);
  if (existing && existing.connected) return existing;

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
      user: cfg.user,
      password: cfg.password,
      server: cfg.host,
      database: target,
      options: {
        encrypt: cfg.encrypt,
        trustServerCertificate: cfg.trustServerCertificate,
      },
    });

    // Evita que un error de red tire el proceso.
    pool.on("error", (err) => {
      console.error(`[db] Error en el pool "${target}":`, err.message);
    });

    await pool.connect();
    pools.set(key, pool);
    return pool;
  })();

  connecting.set(key, connectPromise);
  try {
    return await connectPromise;
  } finally {
    connecting.delete(key);
  }
}

/** Cierra todos los pools abiertos. */
export async function closePool(): Promise<void> {
  const all = Array.from(pools.values());
  pools.clear();
  await Promise.allSettled(all.map((p) => p.close()));
}
