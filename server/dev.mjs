import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createProxyHandler } from './proxy.mjs';
import { connectionFromEnvironment } from './connection.mjs';
import { attachSpeechProxy } from './speech.mjs';

export function createDevelopmentServer(options = {}) {
  const root = options.root ?? fileURLToPath(new URL('..', import.meta.url));
  const connection = options.connection ?? connectionFromEnvironment();
  const proxy = connection ? createProxyHandler(connection, options.clientOptions) : null;
  const require = createRequire(import.meta.url);
  const dependencyRoots = new Map();
  async function dependencyRoot(name) {
    if (dependencyRoots.has(name)) return dependencyRoots.get(name);
    let directory = path.dirname(require.resolve(name));
    while (true) {
      try {
        const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
        if (manifest.name === name) { dependencyRoots.set(name, directory); return directory; }
      } catch {}
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error('Dependency root not found');
      directory = parent;
    }
  }
  let speech;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/api/speech/transcribe' && request.method === 'POST') { await speech(request, response); return; }
    if (url.pathname === '/api/ai' && request.method === 'POST') {
      if (proxy) await proxy(request, response);
      else { response.writeHead(503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'not_configured', message: '请设置 AI_BASE_URL、AI_MODEL 与 AI_API_KEY' } })); }
      return;
    }
    try {
      const pathname = decodeURIComponent(url.pathname === '/' ? '/examples/index.html' : url.pathname);
      let target = path.resolve(root, `.${pathname}`);
      let allowedRoot = path.resolve(root);
      const dependency = /^\/node_modules\/((?:@[^/]+\/)?[^/]+)\/(.+)$/.exec(pathname);
      if (dependency) { allowedRoot = await dependencyRoot(dependency[1]); target = path.resolve(allowedRoot, dependency[2]); }
      if (!target.startsWith(`${allowedRoot}${path.sep}`)) throw new Error('Invalid path');
      const info = await stat(target);
      if (!info.isFile()) throw new Error('Not a file');
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' }[path.extname(target)] ?? 'application/octet-stream';
      response.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` });
      response.end(await readFile(target));
    } catch { response.writeHead(404); response.end('Not found'); }
  });
  speech = attachSpeechProxy(server, options.speech);
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4177);
  const server = createDevelopmentServer();
  server.listen(port, '127.0.0.1', () => console.log(`jsPsych AI: http://127.0.0.1:${port}`));
}
