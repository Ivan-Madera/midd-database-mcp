import fs from "fs";
import path from "path";

/**
 * Carga variables de entorno desde un archivo .env sin dependencias externas.
 *
 * Importante para un server MCP sobre stdio: este cargador NO escribe nada en
 * stdout (a diferencia de dotenv v17, que imprime "tips" y contamina el canal
 * reservado al protocolo MCP). No sobreescribe variables ya presentes en el
 * entorno del proceso.
 *
 * Soporta:
 *  - comentarios con # (línea completa)
 *  - KEY=VALUE con espacios alrededor del '='
 *  - valores entre comillas simples o dobles (se les quitan las comillas)
 */
function parseAndApply(filePath: string): void {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return; // el archivo no existe o no es legible: se ignora
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!key) continue;

    let value = line.slice(eq + 1).trim();
    // Quitar comillas envolventes si las hay.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // No sobreescribir lo que ya venga del entorno del sistema.
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/**
 * Carga el .env de la raíz del proyecto en ambos modos de ejecución:
 *  - dev (ts-node): __dirname = raíz            -> acierta el primer path
 *  - compilado (node dist/index.js): __dirname = dist/ -> acierta el segundo
 */
export function loadEnv(baseDir: string): void {
  parseAndApply(path.resolve(baseDir, ".env"));
  parseAndApply(path.resolve(baseDir, "..", ".env"));
}
