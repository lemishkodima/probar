import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import handler from '../api/lead.js';
const root = resolve(import.meta.dirname, '../public');
const types = { '.html':'text/html; charset=utf-8', '.css':'text/css', '.js':'text/javascript', '.svg':'image/svg+xml', '.webp':'image/webp', '.jpg':'image/jpeg', '.mp4':'video/mp4' };
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/lead') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 2048) { res.writeHead(413).end(); return; } }
      req.body = body;
      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (value) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); return res; };
      return await handler(req, res);
    }
    const file = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404).end('Not found'); }
}).listen(Number(process.env.PORT || 4173), '127.0.0.1', () => console.log('Preview: http://127.0.0.1:4173'));
