import type { EngineName, InjectionHost } from "./types.js";
import { ChromeLiteHost } from "./chrome-lite/index.js";
import { CamoufoxHost } from "./camoufox/index.js";

const HOSTS: Record<EngineName, () => InjectionHost> = {
  "chrome-lite": () => new ChromeLiteHost(),
  camoufox: () => new CamoufoxHost(),
};

export function getHost(name: EngineName): InjectionHost {
  const factory = HOSTS[name];
  if (!factory) throw new Error(`Unknown engine: ${name}. Known: ${Object.keys(HOSTS).join(", ")}`);
  return factory();
}

export function allHostNames(): EngineName[] {
  return Object.keys(HOSTS) as EngineName[];
}
