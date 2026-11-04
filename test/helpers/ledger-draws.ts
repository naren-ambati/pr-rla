import type { DrawForLedger, PublishContext } from "../../src/sdk/ledger.js";

/** Draws and the publish context the issue-ledger tests share (synthetic). */
const sha = (n: number) => n.toString(16).padStart(40, "0");
export const draw = (d: number, n: number, firstOccurrence = true): DrawForLedger => ({ draw: d, changeId: `json:acme/widgets#${n}`, url: `https://git.example.com/acme/widgets/pulls/${n}`, mergeSha: sha(n), firstOccurrence });
export const PUB: PublishContext = { window: "2026-q3", protocolSha256: "ab".repeat(32), registrationSha256: "cd".repeat(32), repo: "acme/widgets" };
