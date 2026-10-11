// Builds a Vercel "Build Output API v3" bundle (.vercel/output): the static web app plus two self-contained
// serverless functions (API and daily cron). Bundling with esbuild avoids relying on Vercel tracing files that
// live outside this project folder (services/api, packages/core).
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const out = ".vercel/output";
rmSync(out, { recursive: true, force: true });

execFileSync("npm", ["run", "build", "--prefix", "../../apps/web", "--", "--outDir", `../../deploy/vercel/${out}/static`, "--emptyOutDir"], { stdio: "inherit" });

const banner = "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);";
for (const name of ["index", "cron"]) {
  const dir = `${out}/functions/api/${name}.func`;
  mkdirSync(dir, { recursive: true });
  await build({
    entryPoints: [`src/${name}.ts`],
    outfile: `${dir}/index.mjs`,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    banner: { js: banner },
    external: ["@electric-sql/pglite", "pg-native"], // dev-only / optional drivers
    legalComments: "none",
    logLevel: "warning",
  });
  mkdirSync(`${dir}/migrations`, { recursive: true });
  for (const f of readdirSync("../../services/api/migrations")) cpSync(`../../services/api/migrations/${f}`, `${dir}/migrations/${f}`);
  writeFileSync(`${dir}/.vc-config.json`, JSON.stringify({ runtime: "nodejs22.x", handler: "index.mjs", launcherType: "Nodejs", maxDuration: name === "cron" ? 60 : 30 }, null, 2));
  writeFileSync(`${dir}/package.json`, '{"type":"module"}');
}

const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src * data: blob:; media-src * blob:; connect-src *; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
writeFileSync(
  `${out}/config.json`,
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: "/(.*)", headers: { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "Content-Security-Policy": csp }, continue: true },
        { src: "/v1/(.*)", dest: "/api/index" },
        { src: "/healthz", dest: "/api/index" },
        { handle: "filesystem" },
        { src: "/(?!api/).*", dest: "/index.html" },
      ],
      crons: [{ path: "/api/cron", schedule: "0 3 * * *" }],
    },
    null,
    2,
  ),
);
console.log("Vercel output ready:", out);
