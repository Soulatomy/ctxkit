import type { Fingerprint, FingerprintOverrides } from "../fingerprint/types.js";
import type { ProxyConfig } from "../proxy/types.js";
import type { EngineName } from "../../hosts/types.js";

export interface Profile {
  id: string;
  name: string;
  engine: EngineName;
  fingerprint: Fingerprint;
  /** Inline proxy (legacy/quick) */
  proxy?: ProxyConfig;
  /** Reference to a ProxyStore entry; takes precedence over inline proxy. */
  proxyId?: string;
  notes?: string;
  tags?: string[];
  /** Grouping folder (free-form; flat, like GoLogin folders). */
  folder?: string;
  /** Optional status label (e.g. "warmup", "active", "banned"). */
  status?: string;
  /** Unpacked extension directories loaded into the browser. */
  extensions?: string[];
  createdAt: string;
  lastUsedAt?: string;
}

export interface CreateProfileInput {
  name: string;
  engine?: EngineName;
  proxy?: ProxyConfig;
  proxyId?: string;
  overrides?: FingerprintOverrides;
  notes?: string;
  tags?: string[];
  folder?: string;
  status?: string;
  extensions?: string[];
}

export interface UpdateProfileInput {
  name?: string;
  engine?: EngineName;
  proxy?: ProxyConfig | null;
  proxyId?: string | null;
  notes?: string;
  tags?: string[];
  folder?: string;
  status?: string;
  extensions?: string[];
  overrides?: FingerprintOverrides;
}

/** Portable profile config for export/import (no secrets beyond proxy creds). */
export interface ExportedProfile {
  name: string;
  engine: EngineName;
  overrides: FingerprintOverrides;
  proxy?: ProxyConfig;
  proxyId?: string;
  notes?: string;
  tags?: string[];
  folder?: string;
  status?: string;
  extensions?: string[];
}
