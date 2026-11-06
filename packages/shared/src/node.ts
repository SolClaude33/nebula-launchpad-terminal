// Solo para procesos Node (servidor y componentes de servidor de Next). Nunca en el navegador.
import { homedir } from "node:os";
import { join } from "node:path";
import { PROFILES, type Profile } from "./index";

export function currentProfile(): Profile {
  const p = (process.env.NEBULA_PROFILE ?? "test").toLowerCase();
  if (!(PROFILES as readonly string[]).includes(p)) throw new Error(`NEBULA_PROFILE inválido: ${p}`);
  return p as Profile;
}

/** Carpeta de datos por perfil: ~/.nebula/<perfil> (NFR-SEC-007). Las bóvedas de test y mainnet nunca se mezclan. */
export function dataDir(profile: Profile = currentProfile()) {
  const base = process.env.NEBULA_DATA_DIR ?? join(homedir(), ".nebula");
  return join(base, profile);
}

export const sessionTokenPath = (profile?: Profile) => join(dataDir(profile), "run", "session-token");
