// Step "comment" of action.yml: posts the status line on the audit issue, when `comment: true`.
// A failed comment is a warning, never a failed job: the audit's result does not depend on it.
//
// The token goes only to GITHUB_API_URL, and only when that is https (or a loopback address, which
// is how the test harness stands in for the API).
import { existsSync, readFileSync } from "node:fs";

const env = process.env;
const warn = (m) => console.log(`::warning title=pr-rla comment::${m}`);

const file = env.PRRLA_COMMENT_FILE;
const issue = env.INPUT_COMMENT_ISSUE ?? "";
const repo = env.GITHUB_REPOSITORY ?? "";
const token = env.GITHUB_TOKEN ?? "";
const api = (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");

if (!file || !existsSync(file)) {
  console.log("no status line to post (the command printed no JSON result); no comment");
} else if (!/^[0-9]+$/.test(issue)) {
  warn("comment: true needs an audit issue number: set comment-issue, or run on an issues event");
} else if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
  warn("GITHUB_REPOSITORY is not owner/name");
} else if (!token) {
  warn("no token to post the comment with");
} else {
  let url;
  try {
    url = new URL(`${api}/repos/${repo}/issues/${issue}/comments`);
  } catch {
    url = null;
  }
  const loopback = url && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (!url || (url.protocol !== "https:" && !loopback)) {
    warn("GITHUB_API_URL is not an https URL; the token was not sent");
  } else {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "pr-rla-github-action",
        },
        body: JSON.stringify({ body: readFileSync(file, "utf8") }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) console.log(`posted the status line on ${repo}#${issue}`);
      else warn(`GitHub answered ${res.status} to the comment on ${repo}#${issue} (a comment needs issues: write)`);
    } catch (e) {
      warn(`the comment could not be posted: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
