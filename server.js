// Pairing site: enter your number -> get a code -> link in WhatsApp -> get a SESSION_ID
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const logger = require('pino')({ level: 'silent' });
const PORT = process.env.PORT || 3000;
const jobs = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));

function cleanup(job) {
  try { job.sock?.ev.removeAllListeners(); job.sock?.end(undefined); } catch {}
  fs.rm(job.dir, { recursive: true, force: true }, () => {});
  setTimeout(() => jobs.delete(job.id), 15 * 60000);
}
async function connect(job, first) {
  const { state, saveCreds } = await useMultiFileAuthState(job.dir);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({}));
  const sock = job.sock = makeWASocket({
    version, logger, printQRInTerminal: false, browser: Browsers.macOS('Safari'), syncFullHistory: false,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
  });
  sock.ev.on('creds.update', saveCreds);
  if (first && !state.creds.registered) {
    setTimeout(async () => {
      try { const c = await sock.requestPairingCode(job.number); job.code = c.match(/.{1,4}/g).join('-'); job.status = 'waiting'; }
      catch (e) { job.status = 'error'; job.error = 'Could not get a code: ' + e.message; cleanup(job); }
    }, 3000);
  }
  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (job.status === 'done' || job.status === 'error') return;
    if (connection === 'open') {
      await sleep(5000); // let creds finish saving
      try {
        const creds = fs.readFileSync(path.join(job.dir, 'creds.json'), 'utf8');
        job.session = 'WABOT~' + Buffer.from(creds).toString('base64'); job.status = 'done';
      } catch (e) { job.status = 'error'; job.error = 'Linked, but could not read session: ' + e.message; }
      cleanup(job);
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) { job.status = 'error'; job.error = 'WhatsApp rejected the link. Try again.'; return cleanup(job); }
      if (Date.now() - job.t < 5 * 60000) setTimeout(() => connect(job, false).catch(() => {}), 1000); // 515 restart after linking is normal
      else { job.status = 'error'; job.error = 'Timed out. Try again.'; cleanup(job); }
    }
  });
}
const PAGE = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Bot Pairing</title>
<style>:root{color-scheme:light dark}body{font-family:system-ui,sans-serif;max-width:460px;margin:0 auto;padding:24px}input,button{font-size:18px;padding:12px;width:100%;box-sizing:border-box;margin:8px 0;border-radius:10px;border:1px solid #888}button{background:#25d366;border:0;color:#000;font-weight:700}
#code{font-size:34px;letter-spacing:3px;text-align:center;font-weight:700;margin:16px 0}textarea{width:100%;height:140px;font-size:12px;box-sizing:border-box}</style>
<h2>🔗 Pair your WhatsApp bot</h2>
<input id=n placeholder="Number with country code, e.g. 2348012345678" inputmode=numeric>
<button onclick=go()>Get pairing code</button><div id=out></div>
<script>
const out=document.getElementById('out');
async function go(){const number=document.getElementById('n').value.replace(/\\D/g,'');
if(number.length<8)return out.textContent='Enter a valid number.';
out.textContent='Requesting code…';
const r=await fetch('/api/pair',{method:'POST',body:JSON.stringify({number})});const j=await r.json();
if(j.error)return out.textContent=j.error;poll(j.id)}
async function poll(id){const j=await (await fetch('/api/status/'+id)).json();
if(j.status==='error')return out.textContent='❌ '+j.error;
if(j.status==='done'){out.innerHTML='<p>✅ Linked! Copy this and set it as <b>SESSION_ID</b> in your bot:</p><textarea id=s readonly></textarea><button onclick="navigator.clipboard.writeText(s.value)">Copy</button><p>Keep it secret – it is full access to that WhatsApp account.</p>';s.value=j.session;return}
if(j.code)out.innerHTML='<div id=code>'+j.code+'</div><p>WhatsApp → Settings → Linked devices → Link a device → <b>Link with phone number instead</b> → enter this code.</p>';
setTimeout(()=>poll(id),2000)}
</script>`;
http.createServer(async (req, res) => {
  const json = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.method === 'POST' && req.url === '/api/pair') {
    let body = ''; for await (const ch of req) body += ch;
    let number = ''; try { number = String(JSON.parse(body).number).replace(/\D/g, ''); } catch {}
    if (number.length < 8 || number.length > 15) return json({ error: 'Invalid number' }, 400);
    if ([...jobs.values()].filter(j => j.status === 'starting' || j.status === 'waiting').length >= 3) return json({ error: 'Busy, try again in a minute.' }, 429);
    const id = crypto.randomBytes(8).toString('hex');
    const job = { id, number, status: 'starting', t: Date.now(), dir: fs.mkdtempSync(path.join(os.tmpdir(), 'pair-')) };
    jobs.set(id, job);
    connect(job, true).catch(e => { job.status = 'error'; job.error = e.message; });
    return json({ id });
  }
  const m = req.url.match(/^\/api\/status\/(\w+)/);
  if (m) { const j = jobs.get(m[1]); return j ? json({ status: j.status, code: j.code, session: j.session, error: j.error }) : json({ status: 'error', error: 'Expired, start again.' }); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE);
}).listen(PORT, () => console.log('Pair site on', PORT));
process.on('unhandledRejection', e => console.error(e?.message || e));
process.on('uncaughtException', e => console.error(e?.message || e));
