import { describe, expect, it } from "vitest";
import { GitHubHttp } from "../src/providers/github/http.js";
import { LedgerHttp, nextLink } from "../src/ledgers/http.js";
import { HttpClient } from "../src/sdk/http.js";

// Final fix round, item 6 (synthetic: a fake fetch, no network). A rel="next" link is the server's word; the built-in
// clients put the token in the headers of every request they make, so a next link on another origin used to receive it.
const TOKEN = "ghp_" + "A".repeat(36);

function fakeFetch(next: string) {
  const seen: { url: string; authorization: string | null }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    seen.push({ url: String(url), authorization: h.get("authorization") });
    return new Response("[]", { status: 200, headers: { link: `<${next}>; rel="next"`, "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

describe("a next-page link on another origin never receives the credential", () => {
  it("GitHubHttp.rest refuses it", async () => {
    const f = fakeFetch("https://evil.example/steal");
    const http = new GitHubHttp({ token: TOKEN, fetch: f.fetch, apiUrl: "https://api.github.com", maxRetries: 0 });
    const page = await http.rest("/repos/o/r/pulls");
    expect(page.next).toBe("https://evil.example/steal");
    await expect(http.rest(page.next!)).rejects.toThrow(/refusing it, it is not on the API origin https:\/\/api\.github\.com/);
    expect(f.seen.map((s) => s.url)).toEqual(["https://api.github.com/repos/o/r/pulls"]);
  });

  it("GitHubHttp.rest still follows a next link on its own origin, GitHub Enterprise's too", async () => {
    for (const root of ["https://api.github.com", "https://ghe.example.com/api/v3"]) {
      const f = fakeFetch(`${root}/repos/o/r/pulls?page=2`);
      const http = new GitHubHttp({ token: TOKEN, fetch: f.fetch, apiUrl: root, maxRetries: 0 });
      const page = await http.rest("/repos/o/r/pulls");
      await http.rest(page.next!);
      expect(f.seen.map((s) => s.url)).toEqual([`${root}/repos/o/r/pulls`, `${root}/repos/o/r/pulls?page=2`]);
      expect(f.seen.every((s) => s.authorization === `Bearer ${TOKEN}`)).toBe(true);
    }
  });

  it("a different port, scheme or host is another origin", async () => {
    const f = fakeFetch("x");
    const http = new GitHubHttp({ token: TOKEN, fetch: f.fetch, apiUrl: "https://api.github.com", maxRetries: 0 });
    for (const u of ["https://api.github.com:8443/x", "http://api.github.com/x", "https://api.github.com.evil.example/x", "https://api.github.com@evil.example/x"]) await expect(http.rest(u), u).rejects.toThrow(/refusing/);
    expect(f.seen).toEqual([]);
  });

  it("LedgerHttp (the issue ledgers' client) refuses it", async () => {
    const f = fakeFetch("https://evil.example/steal");
    const http = new LedgerHttp({ ledger: "gitlab-issues", baseUrl: "https://gitlab.com/api/v4/projects/1", headers: { authorization: `Bearer ${TOKEN}` }, fetch: f.fetch });
    const r = await http.get("/issues");
    const next = nextLink(r.headers)!;
    expect(next).toBe("https://evil.example/steal");
    await expect(http.get(next)).rejects.toThrow(/refusing https:\/\/evil\.example\/steal/);
    expect(f.seen.map((s) => s.url)).toEqual(["https://gitlab.com/api/v4/projects/1/issues"]);
    // Its own origin is followed.
    await http.get("https://gitlab.com/api/v4/projects/1/issues?page=2");
    expect(f.seen).toHaveLength(2);
  });

  it("the SDK's HttpClient (the GitLab and Bitbucket providers') refuses it", async () => {
    const f = fakeFetch("https://evil.example/steal");
    const http = new HttpClient({ provider: "bitbucket-cloud", baseUrl: "https://api.bitbucket.org/2.0", headers: { authorization: `Bearer ${TOKEN}` }, fetch: f.fetch, maxRetries: 0 });
    await http.get("/repositories/w");
    await expect(http.get("https://evil.example/steal")).rejects.toThrow(/refusing https:\/\/evil\.example\/steal/);
    expect(f.seen.map((s) => s.url)).toEqual(["https://api.bitbucket.org/2.0/repositories/w"]);
    await http.get("https://api.bitbucket.org/2.0/repositories/w?page=2");
    expect(f.seen).toHaveLength(2);
  });
});
