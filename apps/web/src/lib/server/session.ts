import "server-only";
import { readFileSync } from "node:fs";
import { sessionTokenPath } from "@nebula/shared/node";

/** Lee el token que la API local escribe al arrancar. Vacío si la API no está corriendo. */
export function readSessionToken() {
  try {
    return readFileSync(sessionTokenPath(), "utf8").trim();
  } catch {
    return "";
  }
}
