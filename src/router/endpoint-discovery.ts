import { readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectEndpointContracts, type Endpoint } from "#app/router/endpoints";

export interface EndpointDiscoveryOptions {
  /** Defaults to .js. Source runners must explicitly select .ts or .mts. */
  extension?: ".js" | ".mjs" | ".ts" | ".mts";
}

/** Loads only immediate *.endpoint files. Request handlers are never executed.
 * Context and metadata type parameters are a caller assertion across the module boundary.
 */
export async function loadEndpoints<TContext = unknown, TMetadata = unknown>(
  directory: string | URL,
  options: EndpointDiscoveryOptions = {},
): Promise<Endpoint<TContext, TMetadata>[]> {
  const extension = options.extension ?? ".js";
  if (![".js", ".mjs", ".ts", ".mts"].includes(extension)) throw new Error(`Unsupported endpoint extension: ${extension}`);
  const path = directory instanceof URL ? fileURLToPath(directory) : resolve(directory);
  const entries = (await readdir(path, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith(`.endpoint${extension}`))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (!entries.length) throw new Error(`No endpoint declarations found in ${path}`);
  const endpoints: Endpoint<TContext, TMetadata>[] = [];
  for (const entry of entries) {
    const { default: module } = await import(pathToFileURL(join(path, entry.name)).href);
    if (!Array.isArray(module)) throw new Error(`Invalid endpoint module: ${entry.name}`);
    endpoints.push(...module as Endpoint<TContext, TMetadata>[]);
  }
  collectEndpointContracts(endpoints);
  return endpoints;
}
