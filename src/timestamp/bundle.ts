import { readFileSync } from "node:fs";
import shipped from "./trust-bundle.json" with { type: "json" };

/**
 * The timestamp-authority trust bundle shipped in the package
 * (`src/timestamp/trust-bundle.json`, built by scripts/update-trust-bundle.mjs).
 * A token counts only if its chain reaches an anchor pinned here for its authority.
 * Anchors are only ever added; removed ones stay as historical (contracts.md, versioning).
 */

export interface BundleCert {
  subject: string;
  /** SHA-256 of the DER certificate, hex. */
  sha256: string;
  notBefore: string;
  notAfter: string;
  pem: string;
  /** Where this certificate came from, for review. */
  source: string;
  /** Anchors only: true if it was confirmed from a source other than the authority's own token response. */
  independent?: boolean;
}

export interface BundleAuthority {
  /** Tokens from one operator count once (k-of-n is over operators). */
  operator: string;
  url: string;
  /** In `init`'s default list. */
  defaultEnabled: boolean;
  notes: string;
  anchors: BundleCert[];
  /** CA certificates between the signer and an anchor, current and historical. */
  intermediates: BundleCert[];
}

export interface TrustBundle {
  schema: "pr-rla/tsa-trust-bundle/v1";
  /** Date stamp, e.g. "2026-11"; recorded in each registration (informational). */
  version: string;
  defaults: { authorities: string[]; minTokens: number };
  authorities: Record<string, BundleAuthority>;
}

export const SHIPPED_TRUST_BUNDLE = shipped as unknown as TrustBundle;

/** The four authorities `init` writes, with k = 2 (founder decision D1). */
export const DEFAULT_AUTHORITIES: readonly string[] = SHIPPED_TRUST_BUNDLE.defaults.authorities;
export const DEFAULT_MIN_TOKENS: number = SHIPPED_TRUST_BUNDLE.defaults.minTokens;
export const TOLERANCE_SECONDS = 600;
export const DEFAULT_ACCURACY_SECONDS = 60;

/** Extra anchors (and authorities) from a file, as `verify --tsa-trust` takes them: the same shape, any subset. */
export interface TrustBundleExtra {
  authorities: Record<string, Partial<BundleAuthority> & { anchors?: BundleCert[]; intermediates?: BundleCert[] }>;
}

export function readTrustExtra(path: string): TrustBundleExtra {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<TrustBundleExtra>;
  if (!raw || typeof raw !== "object" || typeof raw.authorities !== "object" || raw.authorities === null) throw new Error(`${path}: a trust file needs an "authorities" object`);
  return raw as TrustBundleExtra;
}

/**
 * Adds anchors without editing the package: certificates are unioned per authority,
 * and a new authority id needs an operator and a URL. A shipped authority's
 * operator and URL cannot be changed.
 */
export function mergeTrust(base: TrustBundle, extras: readonly TrustBundleExtra[]): TrustBundle {
  const out: TrustBundle = { ...base, authorities: { ...base.authorities } };
  for (const extra of extras) {
    for (const [id, a] of Object.entries(extra.authorities)) {
      const cur = out.authorities[id];
      const union = (x: BundleCert[] = [], y: BundleCert[] = []) => [...x, ...y.filter((c) => !x.some((d) => d.sha256 === c.sha256))];
      if (cur) out.authorities[id] = { ...cur, anchors: union(cur.anchors, a.anchors), intermediates: union(cur.intermediates, a.intermediates) };
      else {
        if (!a.operator || !a.url) throw new Error(`trust file: new authority "${id}" needs an operator and a url`);
        out.authorities[id] = { operator: a.operator, url: a.url, defaultEnabled: false, notes: a.notes ?? "added by a trust file", anchors: a.anchors ?? [], intermediates: a.intermediates ?? [] };
      }
    }
  }
  return out;
}

export function operatorOf(bundle: TrustBundle, tsa: string): string | null {
  return bundle.authorities[tsa]?.operator ?? null;
}

/** Distinct operators among authority ids (k cannot exceed it). */
export function operatorCount(bundle: TrustBundle, ids: readonly string[]): number {
  return new Set(ids.map((id) => operatorOf(bundle, id) ?? `?${id}`)).size;
}
