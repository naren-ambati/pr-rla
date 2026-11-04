import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A fixed P-256 signing key for test audits (synthetic: generated for the tests on 2026-11-04, never used anywhere
 * else). Since time round B a registration names its signing key inside its signed bytes, so two registrations of
 * the same config at the same clock are byte-identical only under the same key: tests that compare two runs
 * (NFR6) install this one where `register` would otherwise create a fresh key.
 */
export const TEST_SIGNING_KEY_PEM =
  "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgxvDqyWD56YfiY6IT\nlAGpGXOaFtI42cfHyCOU/cGxG52hRANCAAS2UH53aMr5RN4KjqRRjC7JZfAkLzhA\nAYzX8M9Ekg1B0y637Tp960hAqEAnxE4aEcZ4G3iRU+9nWk9q6FWYkgnV\n-----END PRIVATE KEY-----\n";

/** Writes the fixed key where `register` looks for it by default (`.pr-rla/signing-key.pem`, git-ignored). */
export function installTestSigningKey(dir: string): void {
  mkdirSync(join(dir, ".pr-rla"), { recursive: true });
  writeFileSync(join(dir, ".pr-rla", "signing-key.pem"), TEST_SIGNING_KEY_PEM, { mode: 0o600 });
}
