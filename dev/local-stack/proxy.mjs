// Tiny stand-in for Supabase's API gateway: /auth/v1 -> GoTrue, /rest/v1 -> PostgREST,
// /functions/v1 and /storage/v1 -> local services (Edge Functions runner + storage
// stand-in), with CORS. Local development and CI only.
import http from 'node:http';
const PORT = Number(process.env.PROXY_PORT || 54321);
// [prefix, port, keepPrefix]
const routes = [['/auth/v1', 9999, false], ['/rest/v1', 3000, false], ['/functions/v1', 9100, true], ['/storage/v1', 9100, true]];
http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': req.headers.origin || '*', 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS', 'Access-Control-Expose-Headers': 'Content-Range, X-Total-Count', 'Access-Control-Allow-Credentials': 'true' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const route = routes.find(([p]) => req.url.startsWith(p));
  if (!route) { res.writeHead(404, cors); return res.end('not found'); }
  const path = route[2] ? req.url : (req.url.slice(route[0].length) || '/');
  const up = http.request({ host: '127.0.0.1', port: route[1], path, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${route[1]}`, 'x-forwarded-host': `127.0.0.1:${PORT}` } }, upRes => {
    const headers = { ...upRes.headers };
    for (const k of Object.keys(headers)) if (k.toLowerCase().startsWith('access-control-')) delete headers[k];
    res.writeHead(upRes.statusCode, { ...headers, ...cors }); upRes.pipe(res);
  });
  up.on('error', e => { res.writeHead(502, cors); res.end(String(e.message)); });
  req.pipe(up);
}).listen(PORT, '127.0.0.1', () => console.log(`proxy on ${PORT}`));
