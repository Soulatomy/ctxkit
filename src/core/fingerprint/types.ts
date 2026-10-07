export type OS = "windows" | "macos" | "linux" | "android" | "ios";

/**
 * A coherent, per-profile identity. Generated once and pinned to the profile so
 * it never drifts between sessions (drift = obvious tell).
 */
export interface Fingerprint {
  /** Deterministic seed = hash(profileId); lets us regenerate identical values. */
  seed: string;
  os: OS;
  userAgent: string;
  /** navigator.platform */
  platform: string;
  /** navigator.userAgentData (client hints) */
  uaMetadata: {
    brands: { brand: string; version: string }[];
    platform: string;
    platformVersion: string;
    mobile: boolean;
    architecture: string;
    bitness: string;
    fullVersionList: { brand: string; version: string }[];
  } | null;
  languages: string[];
  timezone: string;
  locale: string;
  screen: { width: number; height: number; colorDepth: number };
  viewport: { width: number; height: number };
  hardwareConcurrency: number;
  deviceMemory: number;
  webgl: { vendor: string; renderer: string };
  /** Seeds for deterministic canvas/audio noise. */
  canvasNoiseSeed: number;
  audioNoiseSeed: number;
  doNotTrack: "1" | "0" | null;
  colorScheme: "light" | "dark";
  /** navigator.maxTouchPoints (0 desktop; >0 mobile). */
  maxTouchPoints: number;
}

export interface FingerprintOverrides {
  os?: OS;
  timezone?: string;
  locale?: string;
  languages?: string[];
  screen?: { width: number; height: number; colorDepth: number };
  hardwareConcurrency?: number;
  deviceMemory?: number;
}
