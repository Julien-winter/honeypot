// Public stats dashboard (single file, no dependencies).
// Served by stats-server.ts at GET /. Only aggregate numbers, no user data.

export const pageHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Honeypot &ndash; Live Statistics</title>
<link rel="icon" href="/honeypot.svg" type="image/svg+xml">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: radial-gradient(1200px 500px at 50% -10%, #16202e 0%, #0a0a0f 60%); color: #e8e8ef; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; min-height: 100vh; padding: 0 16px 64px; }
  .wrap { max-width: 1080px; margin: 0 auto; }
  nav { display: flex; justify-content: space-between; align-items: center; padding: 18px 4px; }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 1.1rem; }
  .navlinks { display: flex; gap: 10px; align-items: center; }
  .navlinks a { color: #9a9ab0; text-decoration: none; font-size: .9rem; padding: 8px 12px; border-radius: 8px; }
  .navlinks a:hover { background: #1c1c26; color: #fff; }
  .btn { display: inline-block; background: linear-gradient(135deg, #f5a623, #f97316); color: #111 !important; font-weight: 700; border-radius: 10px; padding: 9px 18px !important; text-decoration: none; }
  h1 { text-align: center; font-size: 2.2rem; margin: 26px 0 6px; letter-spacing: -0.5px; }
  .sub { text-align: center; color: #9a9ab0; font-size: .9rem; margin-bottom: 26px; }
  .pill { display: inline-flex; align-items: center; gap: 8px; background: #14141c; border: 1px solid #23232e; border-radius: 999px; padding: 7px 16px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
  @media (max-width: 860px) { .grid { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 560px) { .grid { grid-template-columns: 1fr; } }
  .card { background: rgba(20, 20, 28, .9); border: 1px solid #23232e; border-radius: 14px; padding: 18px 20px; }
  .card .label { font-size: .8rem; color: #9a9ab0; margin-bottom: 6px; text-transform: uppercase; letter-spacing: .4px; }
  .card .value { font-size: 1.9rem; font-weight: 800; }
  .card .extra { font-size: .8rem; color: #9a9ab0; margin-top: 6px; }
  .green { color: #34d399; } .blue { color: #60a5fa; } .orange { color: #f5a623; } .red { color: #f87171; } .gray { color: #71718a; }
  .chart-card { background: rgba(20, 20, 28, .9); border: 1px solid #23232e; border-radius: 14px; padding: 18px 20px; margin-top: 16px; }
  .legend { display: flex; justify-content: space-between; font-size: .85rem; color: #9a9ab0; margin-bottom: 8px; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; }
  #chart { width: 100%; height: auto; display: block; }
  .foot { text-align: center; color: #71718a; font-size: .8rem; margin-top: 18px; }
  .foot a { color: #9a9ab0; }
  .foot code { background: #1c1c26; padding: 3px 8px; border-radius: 6px; font-size: .78rem; color: #e8e8ef; }
  .foot button { background: #23232e; color: #e8e8ef; border: 1px solid #34343f; border-radius: 8px; padding: 4px 12px; font-size: .78rem; cursor: pointer; margin-left: 6px; }
  .foot button:hover { background: #2c2c38; }
</style>
</head>
<body>
<div class="wrap">
  <nav>
    <div class="brand"><img src="/honeypot.svg" width="26" height="26" alt="Honeypot"> Honeypot</div>
    <div class="navlinks"><a href="/docs">Docs</a><a href="/dashboard">Mod Dashboard</a><a href="/health">Health</a><a class="btn" id="inviteBtn" href="#">Invite Bot</a></div>
  </nav>
  <h1><img src="/honeypot.svg" width="38" height="38" alt="Honeypot" style="vertical-align:-7px"> Live Statistics</h1>
  <div class="sub"><span class="pill" id="statusbar"><span class="dot" style="background:#71718a"></span><span id="statusText">Connecting&hellip;</span></span></div>
  <div class="grid">
    <div class="card"><div class="label">Bans (7d)</div><div class="value green" id="bans7d">&ndash;</div><div class="extra" id="trend7d"></div></div>
    <div class="card"><div class="label">Total Bans</div><div class="value blue" id="totalBans">&ndash;</div><div class="extra" id="byAction"></div></div>
    <div class="card"><div class="label">Busiest Day</div><div class="value orange" id="busyDay">&ndash;</div><div class="extra" id="busyDaySub"></div></div>
    <div class="card"><div class="label">Triggered Servers (7d)</div><div class="value orange" id="servers7d">&ndash;</div></div>
    <div class="card"><div class="label">Total Servers</div><div class="value blue" id="totalServers">&ndash;</div></div>
    <div class="card"><div class="label">Honeypot Channels</div><div class="value green" id="totalChannels">&ndash;</div></div>
  </div>
  <div class="chart-card">
    <div class="legend"><span><span class="dot" style="background:#34d399"></span>Bans Issued</span><span>Triggered Servers<span class="dot" style="background:#f5a623;margin-left:6px;margin-right:0"></span></span></div>
    <svg id="chart" viewBox="0 0 760 280" role="img" aria-label="Ban chart"></svg>
  </div>
  <div class="foot" id="updated">Loading&hellip;</div>
  <div class="foot donate" id="donate" style="display:none">Hosting costs money &ndash; support with LTC: <code id="ltcAddr"></code> <button id="copyBtn" type="button">Copy</button></div>
  <div class="foot">Auto-refresh every 60s &middot; <a href="/dashboard">Mod Dashboard (Login)</a> &middot; <a href="/health">Health</a> &middot; <a href="/terms">Terms</a> &middot; <a href="/privacy">Privacy</a></div>
</div>
<script>
function fmt(n) { return Number(n || 0).toLocaleString('en-US'); }
function fmtUptime(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  var d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  if (d > 0) return d + 'd ' + h + 'h ' + m + 'm';
  if (h > 0) return h + 'h ' + m + 'm';
  if (m > 0) return m + 'm';
  return sec + 's';
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
function fmtDate(iso) {
  var parts = String(iso).split('-');
  if (parts.length !== 3) return String(iso);
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return months[Number(parts[1]) - 1] + ' ' + Number(parts[2]);
}

async function load() {
  try {
    var r = await fetch('api/stats', { cache: 'no-store' });
    if (!r.ok) throw new Error('http ' + r.status);
    var s = await r.json();
    document.getElementById('bans7d').textContent = fmt(s.bans7d);
    document.getElementById('totalBans').textContent = fmt(s.totalBans);
    document.getElementById('byAction').textContent = 'incl. ' + fmt(s.byAction ? s.byAction.ban : 0) + ' bans / ' + fmt(s.byAction ? s.byAction.softban : 0) + ' softbans';
    document.getElementById('servers7d').textContent = fmt(s.triggeredServers7d);
    document.getElementById('totalServers').textContent = fmt(s.totalServers);
    document.getElementById('totalChannels').textContent = fmt(s.totalChannels);
    if (s.inviteUrl) document.getElementById('inviteBtn').href = s.inviteUrl;
    if (s.donateLtc) {
      document.getElementById('ltcAddr').textContent = s.donateLtc;
      document.getElementById('donate').style.display = 'block';
    }
    renderTrend(s.daily || []);
    renderBusiest(s.daily || []);
    drawChart(s.daily || []);
    var sb = document.getElementById('statusbar');
    sb.innerHTML = '<span class="dot" style="background:#34d399"></span><span>Online &middot; Uptime ' + esc(fmtUptime(s.uptimeSec)) + ' &middot; since ' + esc(new Date(s.startedAt).toLocaleString('en-US')) + '</span>';
    document.getElementById('updated').textContent = 'Updated: ' + new Date(s.updatedAt).toLocaleString('en-US');
  } catch (e) {
    document.getElementById('updated').textContent = 'Failed to load stats.';
    document.getElementById('statusbar').innerHTML = '<span class="dot" style="background:#f87171"></span><span>Offline &ndash; bot unreachable</span>';
  }
}

function renderTrend(daily) {
  var el = document.getElementById('trend7d');
  if (daily.length < 14) { el.textContent = 'trend needs 14 days of data'; return; }
  var recent = 0, prev = 0, i;
  for (i = 0; i < 14; i++) {
    if (i < 7) prev += daily[i].bans;
    else recent += daily[i].bans;
  }
  if (prev <= 0) { el.textContent = recent > 0 ? 'first data coming in' : ''; return; }
  var pct = Math.round((recent - prev) / prev * 100);
  var cls = pct > 0 ? 'red' : (pct < 0 ? 'green' : 'gray');
  var arrow = pct > 0 ? '\u25B2 ' : (pct < 0 ? '\u25BC ' : '');
  el.innerHTML = '<span class="' + cls + '">' + arrow + (pct > 0 ? '+' : '') + pct + '%</span> vs previous 7d';
}

function renderBusiest(daily) {
  var best = null, i;
  for (i = 0; i < daily.length; i++) {
    if (!best || daily[i].bans > best.bans) best = daily[i];
  }
  if (!best || best.bans <= 0) {
    document.getElementById('busyDay').textContent = '\u2013';
    document.getElementById('busyDaySub').textContent = 'no bans recorded yet';
    return;
  }
  document.getElementById('busyDay').textContent = fmtDate(best.date);
  document.getElementById('busyDaySub').textContent = fmt(best.bans) + ' bans';
}

function drawChart(daily) {
  var svg = document.getElementById('chart');
  var W = 760, H = 280, L = 46, R = 46, T = 12, B = 30;
  if (!daily.length) { svg.innerHTML = '<text x="380" y="140" fill="#71718a" text-anchor="middle">No data yet</text>'; return; }
  var maxB = 1, maxS = 1, i, d;
  for (i = 0; i < daily.length; i++) {
    d = daily[i];
    if (d.bans > maxB) maxB = d.bans;
    if (d.servers > maxS) maxS = d.servers;
  }
  function X(i) { return daily.length === 1 ? (L + (W - L - R) / 2) : (L + (W - L - R) * i / (daily.length - 1)); }
  function YB(v) { return T + (H - T - B) * (1 - v / maxB); }
  function YS(v) { return T + (H - T - B) * (1 - v / maxS); }
  var h = '';
  var g;
  for (g = 0; g <= 4; g++) {
    var y = T + (H - T - B) * g / 4;
    var bv = Math.round(maxB * (1 - g / 4));
    var sv = Math.round(maxS * (1 - g / 4));
    h += '<line x1="' + L + '" y1="' + y + '" x2="' + (W - R) + '" y2="' + y + '" stroke="#23232e"/>';
    h += '<text x="' + (L - 6) + '" y="' + (y + 4) + '" fill="#34d399" font-size="11" text-anchor="end">' + bv + '</text>';
    h += '<text x="' + (W - R + 6) + '" y="' + (y + 4) + '" fill="#f5a623" font-size="11">' + sv + '</text>';
  }
  var pb = '', ps = '';
  for (i = 0; i < daily.length; i++) {
    pb += (i ? 'L' : 'M') + X(i).toFixed(1) + ',' + YB(daily[i].bans).toFixed(1);
    ps += (i ? 'L' : 'M') + X(i).toFixed(1) + ',' + YS(daily[i].servers).toFixed(1);
  }
  var base = (H - B).toFixed(1);
  h += '<path d="' + pb + 'L' + X(daily.length - 1).toFixed(1) + ',' + base + 'L' + X(0).toFixed(1) + ',' + base + 'Z" fill="#34d399" opacity="0.10"/>';
  h += '<path d="' + pb + '" fill="none" stroke="#34d399" stroke-width="2.5"/>';
  h += '<path d="' + ps + '" fill="none" stroke="#f5a623" stroke-width="2"/>';
  for (i = 0; i < daily.length; i++) {
    h += '<circle cx="' + X(i).toFixed(1) + '" cy="' + YB(daily[i].bans).toFixed(1) + '" r="3" fill="#34d399"/>';
    h += '<circle cx="' + X(i).toFixed(1) + '" cy="' + YS(daily[i].servers).toFixed(1) + '" r="3" fill="#f5a623"/>';
  }
  var step = Math.max(1, Math.ceil(daily.length / 7));
  for (i = 0; i < daily.length; i += step) {
    h += '<text x="' + X(i).toFixed(1) + '" y="' + (H - 8) + '" fill="#71718a" font-size="11" text-anchor="middle">' + esc(fmtDate(daily[i].date)) + '</text>';
  }
  svg.innerHTML = h;
}

load();
setInterval(load, 60000);
document.getElementById('copyBtn').addEventListener('click', function () {
  var t = document.getElementById('ltcAddr').textContent;
  var btn = document.getElementById('copyBtn');
  function done(ok) {
    btn.textContent = ok ? 'Copied!' : 'Copy failed';
    setTimeout(function () { btn.textContent = 'Copy'; }, 2000);
  }
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(t).then(function () { done(true); }, function () { done(false); });
  } else {
    var ta = document.createElement('textarea');
    ta.value = t;
    document.body.appendChild(ta);
    ta.select();
    try { done(document.execCommand('copy')); } catch (e) { done(false); }
    document.body.removeChild(ta);
  }
});
</script>
</body>
</html>`;
