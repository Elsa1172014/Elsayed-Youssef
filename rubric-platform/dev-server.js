// Local dev server: serves public/ and runs the /api handlers the way Vercel does.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('./public/', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      const name = url.pathname.slice(5).replace(/[^a-z]/gi, '');
      let mod;
      try { mod = await import(pathToFileURL(fileURLToPath(new URL(`./api/${name}.js`, import.meta.url))).href); }
      catch { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"Not found"}'); }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
      let body; try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
      const request = Object.assign(req, { query: Object.fromEntries(url.searchParams), body });
      const response = Object.assign(res, {
        status(c) { res.statusCode = c; return response; },
        json(o) { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); },
      });
      try { return await mod.default(request, response); }
      catch (e) { res.statusCode = 500; return res.end(JSON.stringify({ error: e.message })); }
    }
    const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
    try {
      const data = await readFile(join(root, rel));
      res.writeHead(200, { 'Content-Type': types[extname(rel)] || 'application/octet-stream' });
      res.end(data);
    } catch { res.writeHead(404); res.end('Not found'); }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, () => console.log(`http://localhost:${port}`));
}
