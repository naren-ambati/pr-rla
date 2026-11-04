/**
 * Secret scrubbing for the broker's recorder and the plugin host's responses (the plugin and
 * broker fix round, findings 5 and 8).
 *
 * A server can echo a secret it was sent, and not always as sent: in a URL it is percent-encoded,
 * in a debug field base64-encoded, inside Basic auth paired with the username. Each secret is
 * replaced, in every one of these forms, by its placeholder (`prrla-cred:<ENV>`, or
 * `prrla-basic:<USER_ENV>:<TOKEN_ENV>` for a Basic pair):
 * - raw;
 * - percent-encoded (encodeURIComponent, upper- and lowercase hex) and form-encoded (URLSearchParams);
 * - base64 and base64url, padded or not;
 * - each of these as a JSON string escapes it: `\"` and `\\`, PHP's `\/`, and the `\u00XX` forms
 *   HTML-safe encoders (Gson, .NET) use for `= + < > & '`, so `JSON.parse` in the plugin cannot undo it.
 *
 * An identity (a credential declared `secret: false`, such as a Basic username or an account
 * e-mail) is not a secret: its value is left alone, so a participant list that names the user
 * still reads right. A Basic pair that contains it is still scrubbed, since it carries the token.
 *
 * Not covered, and stated in docs/security-model.md: a fragment of a secret, or one the server
 * transforms otherwise (hashed, reversed, split, or escaped in a way not listed here).
 */

export interface SecretValue {
  env: string;
  value: string;
  /** false: an identity, not scrubbed on its own. Default true. */
  secret?: boolean;
}

const b64 = (s: string) => Buffer.from(s).toString("base64");

/** A form as JSON encoders write it inside a string: standard escapes, PHP's `\/`, HTML-safe `\u00XX`. */
function jsonEscaped(f: string): string[] {
  const std = JSON.stringify(f).slice(1, -1);
  const html = (t: string, upper: boolean) => t.replace(/[=+<>&']/g, (c) => `\\u00${c.charCodeAt(0).toString(16)[upper ? "toUpperCase" : "toLowerCase"]()}`);
  const slash = (t: string) => t.replace(/\//g, "\\/");
  return [std, slash(std), html(std, false), html(std, true), slash(html(std, false)), slash(html(std, true))];
}

/** The forms a server may echo `value` in, longest first. */
export function secretForms(value: string): string[] {
  const pct = encodeURIComponent(value);
  const base = [value, pct, pct.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()), new URLSearchParams({ x: value }).toString().slice(2), b64(value), b64(value).replace(/=+$/, ""), Buffer.from(value).toString("base64url")];
  const forms = new Set(base.flatMap((f) => [f, ...jsonEscaped(f)]));
  return [...forms].filter((f) => f.length > 0).sort((a, b) => b.length - a.length);
}

/** Pairs of (form, placeholder) for these secrets, longest form first, so a longer form is replaced before a form inside it. */
export function scrubPairs(secrets: readonly SecretValue[]): [string, string][] {
  const pairs = new Map<string, string>();
  const set = secrets.filter((s) => s.value);
  for (const s of set) if (s.secret !== false) for (const f of secretForms(s.value)) if (!pairs.has(f)) pairs.set(f, `prrla-cred:${s.env}`);
  for (const a of set)
    for (const b of set) {
      if (b.secret === false) continue;
      const pair = b64(`${a.value}:${b.value}`);
      for (const f of [pair, pair.replace(/=+$/, "")].flatMap((x) => [x, ...jsonEscaped(x)])) pairs.set(f, `prrla-basic:${a.env}:${b.env}`);
    }
  return [...pairs].sort((x, y) => y[0].length - x[0].length);
}

/** Replaces every form of every secret in a string. */
export function scrubText(pairs: readonly [string, string][], text: string): string {
  let out = text;
  for (const [form, placeholder] of pairs) if (out.includes(form)) out = out.split(form).join(placeholder);
  return out;
}

/** The same, in bytes (a response body that may not be text). */
export function scrubBytes(pairs: readonly [string, string][], buf: Buffer): Buffer {
  let out = buf;
  for (const [form, placeholder] of pairs) {
    const secret = Buffer.from(form);
    let i = out.indexOf(secret);
    if (i < 0) continue;
    const parts: Buffer[] = [];
    let from = 0;
    while (i >= 0) {
      parts.push(out.subarray(from, i), Buffer.from(placeholder));
      from = i + secret.length;
      i = out.indexOf(secret, from);
    }
    parts.push(out.subarray(from));
    out = Buffer.concat(parts);
  }
  return out;
}
