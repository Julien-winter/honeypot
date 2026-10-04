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
  .chart-card { background: linear-gradient(180deg, rgba(26,26,36,.98), rgba(16,16,22,.98)); border: 1px solid #23232e; border-radius: 16px; padding: 18px 20px; margin-top: 16px; position: relative; overflow: hidden; box-shadow: 0 8px 28px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.04); }
  .chart-card::before { content:""; position:absolute; inset:0; background: radial-gradient(600px 200px at 50% 0%, rgba(52,211,153,.07), transparent 70%); pointer-events:none; }
  .legend { display: flex; justify-content: space-between; font-size: .85rem; color: #9a9ab0; margin-bottom: 10px; position: relative; }
  .legend b{ color:#e8e8ef; font-weight:700; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; box-shadow: 0 0 8px currentColor; }
  #chart { width: 100%; height: auto; display: block; position: relative; }
  .chart-tip{ position:absolute; pointer-events:none; background:#0f1117; border:1px solid #2a2a3a; border-radius:10px; padding:8px 10px; font-size:.78rem; color:#e8e8ef; box-shadow:0 10px 28px rgba(0,0,0,.5); opacity:0; transform:translateY(4px); transition:opacity .14s, transform .14s; white-space:nowrap; z-index:5; }
  .chart-tip.on{ opacity:1; transform:translateY(0); }
  .chart-tip .k{ color:#9a9ab0; font-size:.72rem; }
  .bar-rect{ transition: filter .15s; }
  .bar-rect:hover{ filter: brightness(1.15); }
  .foot { text-align: center; color: #71718a; font-size: .8rem; margin-top: 18px; }
  .foot a { color: #9a9ab0; }
  .dcard { background: #2b2d31; border-radius: 8px; overflow: hidden; margin-top: 16px; }
  .dbanner { height: 90px; background: linear-gradient(135deg, #5865F2, #8b96f8); }
  .dbody { padding: 0 16px 16px; }
  .dhead { display: flex; gap: 12px; align-items: flex-end; margin-top: -28px; margin-bottom: 8px; }
  .dicon { width: 56px; height: 56px; border-radius: 50%; background: #1e1f22; border: 4px solid #2b2d31; display: inline-flex; align-items: center; justify-content: center; overflow: hidden; font-weight: 800; font-size: 1.4rem; flex-shrink: 0; }
  .dicon img { width: 100%; height: 100%; }
  .dname { font-weight: 700; font-size: 1rem; padding-bottom: 4px; }
  .dcounts { color: #b5bac1; font-size: .85rem; margin: 2px 0 6px; }
  .dmember { display: flex; align-items: center; gap: 10px; padding: 5px 0; color: #dbdee1; font-size: .9rem; }
  .dav { position: relative; width: 32px; height: 32px; flex-shrink: 0; }
  .dav img { width: 32px; height: 32px; border-radius: 50%; display: block; }
  .davatar-fallback { width: 32px; height: 32px; border-radius: 50%; background: #5865F2; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; }
  .dstatus { position: absolute; right: -2px; bottom: -2px; width: 12px; height: 12px; border-radius: 50%; border: 3px solid #2b2d31; }
  .djoin { display: block; text-align: center; background: #57F287; color: #111; font-weight: 700; border-radius: 4px; padding: 10px; margin-top: 12px; text-decoration: none; }
  .djoin:hover { background: #4ad37e; }
  .foot code { background: #1c1c26; padding: 3px 8px; border-radius: 6px; font-size: .78rem; color: #e8e8ef; }
  .foot button { background: #23232e; color: #e8e8ef; border: 1px solid #34343f; border-radius: 8px; padding: 4px 12px; font-size: .78rem; cursor: pointer; margin-left: 6px; }
  .foot button:hover { background: #2c2c38; }
</style>
</head>
<body>
<div class="wrap">
  <nav>
    <div class="brand"><img src="/honeypot.svg" width="26" height="26" alt="Honeypot"> Honeypot</div>
    <div class="navlinks"><a href="/docs">Docs</a><a href="/arcade">Arcade</a><a href="/dashboard">Mod Dashboard</a><a href="/health">Health</a><a href="/api/auth/login">Login</a><a class="btn" id="inviteBtn" href="#">Invite Bot</a></div>
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
  <div class="chart-card" id="chartWrap">
    <div class="legend"><span><span class="dot" style="background:#34d399;color:#34d399"></span><b>Bans</b> <span style="opacity:.6">bars</span></span><span><span style="opacity:.6">line</span> <b>Servers</b><span class="dot" style="background:#f5a623;color:#f5a623;margin-left:6px;margin-right:0"></span></span></div>
    <div style="position:relative"><svg id="chart" viewBox="0 0 760 300" role="img" aria-label="Ban chart"></svg><div id="chartTip" class="chart-tip"></div></div>
  </div>
  <div class="chart-card" id="rankCard" style="display:none;margin-top:16px">
    <div style="font-weight:800;font-size:1.1rem;margin-bottom:10px">🏆 Top Protected Servers</div>
    <div style="overflow-x:auto"><table id="rankTable" style="width:100%;border-collapse:collapse;font-size:.9rem"><tr><th style="text-align:left;color:#9a9ab0;padding:8px;border-bottom:1px solid #23232e">#</th><th style="text-align:left;color:#9a9ab0;padding:8px;border-bottom:1px solid #23232e">Server</th><th style="text-align:right;color:#9a9ab0;padding:8px;border-bottom:1px solid #23232e">Bans</th></tr></table></div>
  </div>
  <div class="chart-card" id="growthCard" style="display:none;margin-top:16px">
    <div class="legend"><span><span class="dot" style="background:#60a5fa"></span>Total Bans</span><span>Total Servers<span class="dot" style="background:#f5a623;margin-left:6px;margin-right:0"></span></span></div>
    <svg id="growthChart" viewBox="0 0 760 220" role="img" aria-label="Growth chart"></svg>
  </div>
  <div class="dcard" id="community" style="display:none">
    <div class="dbanner"></div>
    <div class="dbody">
      <div class="dhead"><span class="dicon" id="commIcon">?</span><div><div class="dname" id="commName"></div></div></div>
      <div class="dcounts" id="commCounts"></div>
      <div id="commMembers"></div>
      <a class="djoin" id="commJoin" href="https://discord.gg/6QzDSBXQ6E">Join</a>
    </div>
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
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
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
    if (s.community) {
      document.getElementById('community').style.display = 'block';
      document.getElementById('commName').textContent = s.community.name;
      var cc = '<span class="dot" style="background:#23a55a"></span>' + fmt(s.community.online) + ' Online';
      if (s.community.total) cc += '&nbsp;&nbsp;<span class="dot" style="background:#80848e"></span>' + fmt(s.community.total) + ' Members';
      document.getElementById('commCounts').innerHTML = cc;
      var ic = document.getElementById('commIcon');
      if (s.community.icon) ic.innerHTML = '<img src="' + esc(s.community.icon) + '" width="56" height="56" alt="">';
      else ic.textContent = (s.community.name || '?').slice(0, 1);
      if (s.community.invite) document.getElementById('commJoin').href = s.community.invite;
      var mh = '';
      var list = s.community.members.slice(0, 8);
      for (var k = 0; k < list.length; k++) {
        var m = list[k];
        var col = m.status === 'idle' ? '#f0b232' : (m.status === 'dnd' ? '#f23f43' : '#23a55a');
        mh += '<div class="dmember"><span class="dav">';
        mh += m.avatar ? '<img src="' + esc(m.avatar) + '" alt="" loading="lazy">' : '<span class="davatar-fallback">' + esc(m.name.slice(0, 1)) + '</span>';
        mh += '<span class="dstatus" style="background:' + col + '"></span></span><span>' + esc(m.name) + '</span></div>';
      }
      document.getElementById('commMembers').innerHTML = mh;
    }
    renderTrend(s.daily || []);
    renderBusiest(s.daily || []);
    drawChart(s.daily || []);
    renderLeaderboard(s.leaderboard || []);
    drawGrowth(s.history || []);
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

function renderBusiest(daily) {  var best = null, i;
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

function renderLeaderboard(board) {
  if (!board.length) return;
  document.getElementById('rankCard').style.display = 'block';
  var medals = ['\u{1F947}', '\u{1F948}', '\u{1F949}'];
  var h = '<tr><th style="text-align:left;color:#9a9ab0;padding:8px;border-bottom:1px solid #23232e">#</th><th style="text-align:left;color:#9a9ab0;padding:8px;border-bottom:1px solid #23232e">Server</th><th style="text-align:right;color:#9a9ab0;padding:8px;border-bottom:1px solid #23232e">Bans</th></tr>';
  for (var i = 0; i < board.length; i++) {
    var rank = i < 3 ? medals[i] : ('#' + (i + 1));
    var gicon = board[i].icon
      ? '<img src="' + esc(board[i].icon) + '" width="28" height="28" alt="" loading="lazy" style="border-radius:50%;vertical-align:-8px;margin-right:8px">'
      : '<span style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:#5865F2;font-weight:700;margin-right:8px;vertical-align:-8px">' + esc((board[i].name || '?').slice(0, 1)) + '</span>';
    h += '<tr><td style="padding:8px;border-bottom:1px solid #1c1c26">' + rank + '</td>'
      + '<td style="padding:8px;border-bottom:1px solid #1c1c26">' + gicon + esc(board[i].name) + '</td>'
      + '<td style="padding:8px;border-bottom:1px solid #1c1c26;text-align:right;font-weight:700">' + fmt(board[i].moderations) + '</td></tr>';
  }
  document.getElementById('rankTable').innerHTML = h;
}

function drawGrowth(history) {
  if (history.length < 2) return;
  document.getElementById('growthCard').style.display = 'block';
  var svg = document.getElementById('growthChart');
  var W = 760, H = 220, L = 46, R = 46, T = 16, B = 30;
  var maxB = 0, maxG = 0, i;
  for (i = 0; i < history.length; i++) {
    if (history[i].moderations > maxB) maxB = history[i].moderations;
    if (history[i].guilds > maxG) maxG = history[i].guilds;
  }
  maxB = Math.max(maxB, 1); maxG = Math.max(maxG, 1);
  var niceB = (function(v){ if(v<=4) return 4; var n=Math.ceil(v/4)*4; if(n>1000){ var pow=Math.pow(10, Math.floor(Math.log10(n))-1); var step=pow; if(n/pow <2) step=pow; else if(n/pow<5) step=pow*2; else step=pow*5; n=Math.ceil(v/step)*step; n=Math.ceil(n/4)*4; } return n; })(maxB);
  var niceG = (function(v){ if(v<=4) return 4; var n=Math.ceil(v/4)*4; if(n>1000){ var pow=Math.pow(10, Math.floor(Math.log10(n))-1); var step=pow; if(n/pow <2) step=pow; else if(n/pow<5) step=pow*2; else step=pow*5; n=Math.ceil(v/step)*step; n=Math.ceil(n/4)*4; } return n; })(maxG);
  function X(idx) { return history.length === 1 ? ((L + W - R) / 2) : (L + (W - L - R) * idx / (history.length - 1)); }
  function YB(v) { return T + (H - T - B) * (1 - v / niceB); }
  function YG(v) { return T + (H - T - B) * (1 - v / niceG); }
  function smoothPath(pts) {
    if (pts.length < 2) return '';
    if (pts.length === 2) return 'M'+pts[0][0].toFixed(1)+','+pts[0][1].toFixed(1)+'L'+pts[1][0].toFixed(1)+','+pts[1][1].toFixed(1);
    var d = 'M'+pts[0][0].toFixed(1)+','+pts[0][1].toFixed(1);
    for (var j = 0; j < pts.length - 1; j++) {
      var p0 = pts[Math.max(j - 1, 0)];
      var p1 = pts[j];
      var p2 = pts[Math.min(j + 1, pts.length - 1)];
      var p3 = pts[Math.min(j + 2, pts.length - 1)];
      var tension = 0.3;
      var cp1x = p1[0] + (p2[0] - p0[0]) * tension;
      var cp1y = p1[1] + (p2[1] - p0[1]) * tension;
      var cp2x = p2[0] - (p3[0] - p1[0]) * tension;
      var cp2y = p2[1] - (p3[1] - p1[1]) * tension;
      d += 'C'+cp1x.toFixed(1)+','+cp1y.toFixed(1)+' '+cp2x.toFixed(1)+','+cp2y.toFixed(1)+' '+p2[0].toFixed(1)+','+p2[1].toFixed(1);
    }
    return d;
  }
  var h = '<defs>'
    + '<linearGradient id="gTotal" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#60a5fa" stop-opacity="0.3"/><stop offset="100%" stop-color="#60a5fa" stop-opacity="0.02"/></linearGradient>'
    + '<filter id="glowG"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>'
    + '</defs>';
  var g;
  for (g = 0; g <= 3; g++) {
    var y = T + (H - T - B) * g / 3;
    h += '<line x1="' + L + '" y1="' + y + '" x2="' + (W - R) + '" y2="' + y + '" stroke="#1e1e2a"/>';
    h += '<text x="' + (L - 8) + '" y="' + (y + 4) + '" fill="#60a5fa" font-size="11" text-anchor="end" font-family="Space Grotesk,system-ui" opacity="0.8">' + Math.round(niceB * (1 - g / 3)) + '</text>';
    h += '<text x="' + (W - R + 8) + '" y="' + (y + 4) + '" fill="#f5a623" font-size="11" text-anchor="start" font-family="Space Grotesk,system-ui" opacity="0.8">' + Math.round(niceG * (1 - g / 3)) + '</text>';
  }
  var ptsB = [], ptsG = [];
  for (i = 0; i < history.length; i++) {
    ptsB.push([X(i), YB(history[i].moderations)]);
    ptsG.push([X(i), YG(history[i].guilds)]);
  }
  var base = (H - B).toFixed(1);
  var pathB = smoothPath(ptsB);
  var pathG = smoothPath(ptsG);
  h += '<path d="' + pathB + 'L' + X(history.length - 1).toFixed(1) + ',' + base + 'L' + X(0).toFixed(1) + ',' + base + 'Z" fill="url(#gTotal)"/>';
  h += '<path d="' + pathB + '" fill="none" stroke="#60a5fa" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" filter="url(#glowG)"/>';
  h += '<path d="' + pathG + '" fill="none" stroke="#f5a623" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" filter="url(#glowG)" stroke-dasharray="6,3"/>';
  for (i = 0; i < history.length; i++) {
    h += '<circle cx="'+X(i).toFixed(1)+'" cy="'+YB(history[i].moderations).toFixed(1)+'" r="3.5" fill="#0a0a0f" stroke="#60a5fa" stroke-width="2"/>';
    h += '<circle cx="'+X(i).toFixed(1)+'" cy="'+YG(history[i].guilds).toFixed(1)+'" r="3" fill="#0a0a0f" stroke="#f5a623" stroke-width="1.5"/>';
  }
  var step = Math.max(1, Math.ceil(history.length / 8));
  for (i = 0; i < history.length; i += step) {
    h += '<text x="' + X(i).toFixed(1) + '" y="' + (H - 10) + '" fill="#71718a" font-size="11" text-anchor="middle" font-family="Space Grotesk,system-ui">' + esc(fmtDate(history[i].date)) + '</text>';
  }
  svg.innerHTML = h;
}

function drawChart(daily) {
  var svg = document.getElementById('chart');
  var W = 760, H = 300, L = 44, R = 34, T = 18, B = 38;
  // adaptive window: don't show 14 empty days when only 1 spike — looks deserted. Show 5→7→14 as data grows
  var padded = (function(){
    var map={}; for(var i=0;i<daily.length;i++) map[daily[i].date]=daily[i];
    var nonZero=0; for(var i=0;i<daily.length;i++) if(daily[i].bans>0||daily[i].servers>0) nonZero++;
    var windowSize = nonZero<=2 ? 5 : (nonZero<=5 ? 7 : 14);
    var last = daily.length ? new Date(daily[daily.length-1].date+'T12:00:00') : new Date();
    var out=[]; for(var k=windowSize-1;k>=0;k--){ var d=new Date(last); d.setDate(last.getDate()-k); var iso=d.toISOString().slice(0,10); out.push(map[iso]||{date:iso,bans:0,servers:0}); }
    return out;
  })();
  if (padded.every(function(d){ return d.bans===0 && d.servers===0; })) {
    svg.setAttribute('viewBox','0 0 '+W+' '+H);
    svg.innerHTML = '<defs><linearGradient id="emptyGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#34d399" stop-opacity="0.12"/><stop offset="100%" stop-color="#34d399" stop-opacity="0"/></linearGradient></defs>'
      + '<rect x="'+L+'" y="90" width="'+(W-L-R)+'" height="110" rx="10" fill="url(#emptyGrad)" stroke="#1e2a24"/>'
      + '<text x="'+(W/2)+'" y="138" fill="#71718a" font-size="13" text-anchor="middle" font-family="Space Grotesk,system-ui">No bans yet — chart fills as activity grows</text>'
      + '<text x="'+(W/2)+'" y="158" fill="#555" font-size="11" text-anchor="middle" font-family="Space Grotesk,system-ui">14-day window • updates live</text>';
    return;
  }
  daily = padded;
  svg.setAttribute('viewBox','0 0 '+W+' '+H);
  var maxV = 0, i, d;
  for (i = 0; i < daily.length; i++) { d=daily[i]; if(d.bans>maxV) maxV=d.bans; if(d.servers>maxV) maxV=d.servers; }
  maxV = Math.max(maxV, 1);
  var nice = (function(v){ if(v<=4) return 4; var n=Math.ceil(v/4)*4; if(n>1000){ var pow=Math.pow(10, Math.floor(Math.log10(n))-1); var step=pow; if(n/pow<2) step=pow; else if(n/pow<5) step=pow*2; else step=pow*5; n=Math.ceil(v/step)*step; n=Math.ceil(n/4)*4; } return n; })(maxV);
  function X(idx){ return L + (W-L-R) * idx / (daily.length-1); }
  function Y(v){ return T + (H-T-B)*(1 - v/nice); }
  function smoothPath(pts){
    if(pts.length<2) return '';
    if(pts.length===2) return 'M'+pts[0][0].toFixed(1)+','+pts[0][1].toFixed(1)+'L'+pts[1][0].toFixed(1)+','+pts[1][1].toFixed(1);
    var yMin=T, yMax=H-B;
    var s='M'+pts[0][0].toFixed(1)+','+pts[0][1].toFixed(1);
    for(var j=0;j<pts.length-1;j++){
      var p0=pts[Math.max(j-1,0)], p1=pts[j], p2=pts[Math.min(j+1,pts.length-1)], p3=pts[Math.min(j+2,pts.length-1)];
      var t=0.22;
      var cp1x=p1[0]+(p2[0]-p0[0])*t, cp1y=p1[1]+(p2[1]-p0[1])*t;
      var cp2x=p2[0]-(p3[0]-p1[0])*t, cp2y=p2[1]-(p3[1]-p1[1])*t;
      // clamp Y to not overshoot below baseline or above top — fixes dip under 0
      cp1y=Math.max(yMin, Math.min(yMax, cp1y));
      cp2y=Math.max(yMin, Math.min(yMax, cp2y));
      s+='C'+cp1x.toFixed(1)+','+cp1y.toFixed(1)+' '+cp2x.toFixed(1)+','+cp2y.toFixed(1)+' '+p2[0].toFixed(1)+','+p2[1].toFixed(1);
    }
    return s;
  }
  var barW = Math.max(10, Math.min(26, (W-L-R)/daily.length*0.62));
  var h = '<defs>'
    + '<linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#34d399" stop-opacity="0.95"/><stop offset="100%" stop-color="#1a8a5a" stop-opacity="0.35"/></linearGradient>'
    + '<linearGradient id="areaServ" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#f5a623" stop-opacity="0.22"/><stop offset="100%" stop-color="#f5a623" stop-opacity="0"/></linearGradient>'
    + '<filter id="barGlow"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>'
    + '<filter id="lineGlow"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>'
    + '</defs>';
  // grid
  for(var g=0;g<=4;g++){
    var y=T+(H-T-B)*g/4, v=Math.round(nice*(1-g/4));
    h+='<line x1="'+L+'" y1="'+y+'" x2="'+(W-R)+'" y2="'+y+'" stroke="'+(g===4?'#2a2a38':'#1a1a24')+'" stroke-width="1" stroke-dasharray="'+(g===4?'0':'4,6')+'"/>';
    h+='<text x="'+(L-7)+'" y="'+(y+4)+'" fill="#5a6a6a" font-size="11" text-anchor="end" font-family="Space Grotesk,system-ui">'+v+'</text>';
  }
  // bars for Bans — only where >0, hide 0-days (cleaner than tiny 2px dashes)
  for(i=0;i<daily.length;i++){
    var bv=daily[i].bans, x=X(i), y1=Y(bv), y0=Y(0), bh=y0-y1;
    if(bv>0){
      var rx=5;
      var stagger=(i*0.035).toFixed(2);
      h+='<rect class="bar-rect" x="'+(x-barW/2).toFixed(1)+'" y="'+y0.toFixed(1)+'" width="'+barW.toFixed(1)+'" height="0" rx="'+rx+'" fill="url(#barGrad)" stroke="#34d399" stroke-opacity="0.35">'
        +'<animate attributeName="y" from="'+y0.toFixed(1)+'" to="'+y1.toFixed(1)+'" dur="0.55s" begin="'+stagger+'s" fill="freeze" calcMode="spline" keySplines="0.22 1 0.36 1"/>'
        +'<animate attributeName="height" from="0" to="'+Math.max(bh,2).toFixed(1)+'" dur="0.55s" begin="'+stagger+'s" fill="freeze" calcMode="spline" keySplines="0.22 1 0.36 1"/>'
        +'</rect>';
      h+='<rect x="'+(x-barW/2+2).toFixed(1)+'" y="'+y1.toFixed(1)+'" width="'+(barW-4).toFixed(1)+'" height="2.5" rx="1.2" fill="#fff" opacity="0.22"><animate attributeName="opacity" from="0" to="0.22" dur="0.3s" begin="'+(parseFloat(stagger)+0.45).toFixed(2)+'s" fill="freeze"/></rect>';
      if(bh>14) h+='<text x="'+x.toFixed(1)+'" y="'+(y1-7).toFixed(1)+'" fill="#34d399" font-size="10" text-anchor="middle" font-weight="800" opacity="0">'+bv+'<animate attributeName="opacity" from="0" to="1" dur="0.25s" begin="'+(parseFloat(stagger)+0.5).toFixed(2)+'s" fill="freeze"/></text>';
    }
  }
  // line for Triggered Servers — isolate: no 0-baseline at all, single spike = isolated dot (no diagonal)
  var rawPts=[]; for(i=0;i<daily.length;i++) if(daily[i].servers>0) rawPts.push([X(i), Y(daily[i].servers)]);
  var linePath = rawPts.length>=2 ? smoothPath(rawPts) : '';
  if(linePath){
    var lastX = rawPts[rawPts.length-1][0].toFixed(1), firstX = rawPts[0][0].toFixed(1);
    var areaPath = linePath+'L'+lastX+','+(H-B)+'L'+firstX+','+(H-B)+'Z';
    h+='<path d="'+areaPath+'" fill="url(#areaServ)" opacity="0"><animate attributeName="opacity" from="0" to="1" dur="0.6s" begin="0.5s" fill="freeze"/></path>';
    h+='<path d="'+linePath+'" fill="none" stroke="#f5a623" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" filter="url(#lineGlow)" stroke-dasharray="1000" stroke-dashoffset="1000"><animate attributeName="stroke-dashoffset" from="1000" to="0" dur="0.9s" begin="0.45s" fill="freeze" calcMode="spline" keySplines="0.22 1 0.36 1"/></path>';
  }
  for(i=0;i<daily.length;i++){
    var sv=daily[i].servers; if(sv===0) continue;
    var xs=X(i).toFixed(1), ys=Y(sv).toFixed(1);
    var sd=(0.6+i*0.04).toFixed(2);
    h+='<g opacity="0"><animate attributeName="opacity" from="0" to="1" dur="0.25s" begin="'+sd+'s" fill="freeze"/><circle cx="'+xs+'" cy="'+ys+'" r="9" fill="#f5a623" opacity="0.10" filter="url(#barGlow)"/><circle cx="'+xs+'" cy="'+ys+'" r="3.8" fill="#0a0a0f" stroke="#f5a623" stroke-width="2"/></g>';
  }
  // hit-zones for tooltip (invisible)
  for(i=0;i<daily.length;i++){ h+='<rect x="'+(X(i)-barW/2-6).toFixed(1)+'" y="'+T+'" width="'+(barW+12).toFixed(1)+'" height="'+(H-T-B)+'" fill="transparent" data-idx="'+i+'" style="cursor:crosshair"/>'; }
  // x labels — show every 2nd for 14 days, highlight last
  for(i=0;i<daily.length;i++){
    var show = (i%2===1) || i===daily.length-1;
    if(!show) continue;
    var lbl=esc(fmtDate(daily[i].date));
    var isLast = i===daily.length-1;
    h+='<text x="'+X(i).toFixed(1)+'" y="'+(H-10)+'" fill="'+(isLast?'#e8e8ef':'#5a6a7a')+'" font-size="'+(isLast?'11':'10')+'" text-anchor="middle" font-weight="'+(isLast?'700':'400')+'" font-family="Space Grotesk,system-ui">'+lbl+'</text>';
    if(isLast){ h+='<circle cx="'+X(i).toFixed(1)+'" cy="'+(H-22)+'" r="2.2" fill="#f5a623"><animate attributeName="opacity" values="0.3;1;0.3" dur="1.6s" repeatCount="indefinite"/></circle>'; }
  }
  h+='<text x="'+L+'" y="'+(T-4)+'" fill="#4a5a5a" font-size="9" letter-spacing="0.7" font-family="Space Grotesk,system-ui">LAST 14 DAYS • DAILY</text>';
  svg.innerHTML=h;
  // tooltip interactivity
  (function(){
    var tip=document.getElementById('chartTip'); if(!tip) return;
    var xs=[]; for(var k=0;k<daily.length;k++) xs.push(X(k));
    var lastIdx=-1;
    function nearest(vbX){ var best=0, bd=1e9; for(var k=0;k<xs.length;k++){ var d=Math.abs(xs[k]-vbX); if(d<bd){bd=d; best=k;}} return best; }
    function show(e){
      var r=svg.getBoundingClientRect();
      var vbX = L + ((e.clientX - r.left)/r.width)*(W);
      var idx=nearest(vbX);
      if(idx===lastIdx && tip.classList.contains('on')) return;
      lastIdx=idx;
      var d=daily[idx];
      tip.innerHTML='<div class="k">'+esc(fmtDate(d.date))+'</div><div style="margin-top:3px;display:flex;gap:10px;align-items:center"><span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#34d399;box-shadow:0 0 6px #34d399"></span> <b>'+d.bans+'</b> bans</span><span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#f5a623;box-shadow:0 0 6px #f5a623"></span> <b>'+d.servers+'</b> servers</span></div>';
      tip.classList.add('on');
      var px=(xs[idx]-L)/(W-L-R)*r.width;
      var left=Math.min(r.width-156, Math.max(6, px-78));
      tip.style.left=left+'px';
      tip.style.top='48px';
    }
    function hide(){ tip.classList.remove('on'); lastIdx=-1; }
    svg.addEventListener('mousemove', show);
    svg.addEventListener('mouseleave', hide);
    svg.addEventListener('touchstart', function(e){ if(e.touches[0]) show(e.touches[0]); }, {passive:true});
  })();
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
