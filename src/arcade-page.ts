// Arcade page — local-only ROM via EmulatorJS + four retro games (tabs, lazy).
// ROMs stay client-side (blob URL, never uploaded).

export const arcadeHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Honeypot &ndash; Arcade</title>
<link rel="icon" href="/honeypot.svg" type="image/svg+xml">
<link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0a0a0f; color: #e8e8ef; font-family: "Space Grotesk", system-ui, sans-serif; min-height: 100vh; padding: 0 16px 64px; position: relative; }
  body::before { content:""; position: fixed; inset: 0; background:
    linear-gradient(rgba(88,101,242,.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(88,101,242,.05) 1px, transparent 1px);
    background-size: 36px 36px; pointer-events: none; z-index: -1; }
  body::after { content:""; position: fixed; inset: 0; background: repeating-linear-gradient(0deg, rgba(0,0,0,.18) 0 2px, transparent 2px, transparent 4px); pointer-events: none; opacity: .18; z-index: -1; }
  .wrap { max-width: 1020px; margin: 0 auto; }
  nav { display: flex; justify-content: space-between; align-items: center; padding: 18px 4px; flex-wrap: wrap; gap: 10px; }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 1.1rem; }
  .navlinks { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .navlinks a { color: #9a9ab0; text-decoration: none; font-size: .9rem; padding: 8px 12px; border-radius: 8px; border: 1px solid transparent; }
  .navlinks a:hover { background: #1c1c26; color: #fff; }
  .navlinks a.active { background: #1c1c26; color: #fff; border-color: #5865F2; }
  h1 { font-family: "Press Start 2P", monospace; font-size: 1.45rem; margin: 18px 0 6px; text-shadow: 0 0 10px rgba(245,166,35,.5); letter-spacing: -1px; }
  .sub { color: #9a9ab0; font-size: .9rem; margin-bottom: 16px; line-height: 1.5; }
  .tabs { display:flex; gap:8px; flex-wrap:wrap; margin: 12px 0; }
  .tab { background: #1c1c26; color: #9a9ab0; border: 1px solid #34343f; border-radius: 10px; padding: 8px 14px; font-weight: 700; cursor: pointer; font-size: .88rem; }
  .tab.active { background: linear-gradient(135deg, #f5a623, #f97316); color: #111; border-color: transparent; box-shadow: 0 0 14px rgba(245,166,35,.35); }
  .card { background: rgba(20, 20, 28, .94); border: 1px solid #23232e; border-radius: 14px; padding: 18px 20px; margin-top: 12px; }
  .card.retro { border-color: #5865F2; box-shadow: 0 0 0 1px rgba(88,101,242,.15), 0 10px 28px rgba(0,0,0,.45); }
  canvas { background: #0a0a0f; border: 1px solid #34343f; border-radius: 8px; display: block; margin: 10px auto; outline: none; image-rendering: pixelated; }
  canvas:focus { border-color: #f5a623; box-shadow: 0 0 0 2px rgba(245,166,35,.25); }
  .muted { color: #9a9ab0; font-size: .85rem; }
  .controls { font-size: .78rem; color: #b5bac1; margin-top: 8px; text-align: center; }
  .btn { background: linear-gradient(135deg, #f5a623, #f97316); color: #111; font-weight: 700; border-radius: 10px; padding: 7px 14px; border: 0; cursor: pointer; }
  .btn.ghost { background: #23232e; color: #e8e8ef; border: 1px solid #34343f; }
  .score { font-family: "Press Start 2P", monospace; font-size: .7rem; text-align: center; margin-top: 6px; color: #f5a623; }
  .tile { position:absolute; display:flex;align-items:center;justify-content:center;border-radius:6px;font-weight:800;transition: transform .09s cubic-bezier(.22,1,.36,1), top .09s cubic-bezier(.22,1,.36,1), left .09s cubic-bezier(.22,1,.36,1); will-change: transform, top, left; box-shadow: inset 0 1px 0 rgba(255,255,255,.22), 0 2px 8px rgba(0,0,0,.25); }
  .tile.pop { animation: pop .18s cubic-bezier(.22,1,.36,1); }
  .tile.merged { animation: pop .18s cubic-bezier(.22,1,.36,1), mergedGlow .45s ease; }
  @keyframes pop { 0% { transform: scale(.78); } 60% { transform: scale(1.08); } 100% { transform: scale(1); } }
  @keyframes mergedGlow { 0% { box-shadow: 0 0 0 rgba(245,166,35,0), inset 0 1px 0 rgba(255,255,255,.22); } 35% { box-shadow: 0 0 14px rgba(245,166,35,.55), inset 0 1px 0 rgba(255,255,255,.4); } 100% { box-shadow: inset 0 1px 0 rgba(255,255,255,.22), 0 2px 8px rgba(0,0,0,.25); } }
  #board2048Wrap{ position:relative;width:260px;height:260px;margin:10px auto; background:#1c1c26; padding:6px; border-radius:8px; outline:none; overflow:hidden; }
  #board2048Bg{ position:absolute; inset:6px; display:grid; grid-template-columns:repeat(4,1fr); gap:6px; }
  #board2048Bg div{ background:#2b2d31; border-radius:6px; }
  #board2048{ position:absolute; inset:6px; }
  .foot { text-align: center; color: #71718a; font-size: .8rem; margin-top: 28px; }
  .foot a { color: #9a9ab0; }
  .hidden { display: none !important; }
  input[type="file"] { color: #e8e8ef; font-size: .85rem; }
  code { background: #1c1c26; padding: 2px 6px; border-radius: 6px; font-size: .8rem; }
  #game { width: 100%; max-width: 800px; height: 450px; margin: 12px auto; background: #000; border-radius: 8px; overflow: hidden; display: none; aspect-ratio: 16/9; }
  #game canvas { margin: 0; border: 0; }
</style>
</head>
<body>
<div class="wrap">
  <nav>
    <div class="brand"><img src="/honeypot.svg" width="26" height="26" alt="Honeypot"> Honeypot</div>
    <div class="navlinks"><a href="/">Stats</a><a href="/docs">Docs</a><a href="/arcade" class="active">Arcade</a><a href="/dashboard">Dashboard</a></div>
  </nav>

  <h1>ARCADE</h1>
  <div class="sub">Retro corner — ROMs stay <b>only on your device</b> (blob URL, never uploaded). Tabs are lazy: only the active game runs. Click a tab to play.</div>

  <div class="tabs">
    <button type="button" class="tab active" data-tab="rom">📂 ROM Slot</button>
    <button type="button" class="tab" data-tab="tetris">🧱 Tetris</button>
    <button type="button" class="tab" data-tab="2048">🔢 2048</button>
  </div>

  <div id="pane-rom" class="card retro">
    <div style="font-weight:800;margin-bottom:8px">📂 Local ROM (not uploaded) — <span style="color:#34d399">GB / GBC / GBA / NES / SNES / NDS / N64</span></div>
    <div class="muted" style="margin-bottom:10px">Pick a legally owned dump. File stays local (blob URL, never uploaded). <b>N64 works</b> — Super Mario 64, OoT, etc. run via Muppen64+ core. <b>.cci/.3ds</b> not playable in-browser (needs Citra/Azahar desktop). Keyboard: Arrow keys + A/C buttons mapped.</div>
    <input id="romInput" type="file" accept=".gb,.gbc,.gba,.nes,.smc,.sfc,.sfc,.nds,.n64,.z64,.v64,.3ds,.cci,.cxi,.cia,.zip,.7z">
    <div class="muted" id="romInfo" style="margin-top:10px;white-space:pre-wrap"></div>
    <div id="game"></div>
    <div class="controls" id="romHint" style="display:none">EmulatorJS — click inside to focus, then use keyboard. File stays local, never uploaded.</div>
  </div>

  <div id="pane-tetris" class="card hidden" tabindex="0">
    <div style="font-weight:800">🧱 Tetris — <span class="muted" style="font-weight:400">ghost + smooth drop • next preview</span></div>
    <div class="score" id="tetrisScore">Score: 0</div>
    <div style="display:flex;gap:12px;justify-content:center;align-items:flex-start;flex-wrap:wrap">
      <canvas id="tetris" width="200" height="400" tabindex="0"></canvas>
      <div style="display:flex;flex-direction:column;gap:8px;align-items:center">
        <div style="background:#1c1c26;border:1px solid #2a2a3a;border-radius:8px;padding:8px"><div class="muted" style="font-size:.72rem;text-align:center;margin-bottom:4px">NEXT</div><canvas id="tetrisNext" width="64" height="64" style="background:transparent;border:0;margin:0"></canvas></div>
        <div class="muted" style="font-size:.72rem;text-align:center;max-width:110px">Ghost shows landing<br>Hold ↓ for soft drop</div>
      </div>
    </div>
    <div class="controls">← → move &nbsp; ↓ soft drop &nbsp; ↑ rotate &nbsp; Space hard drop &nbsp; <button type="button" id="tetrisBtn" class="btn ghost" style="padding:4px 10px;font-size:.8rem;margin-left:6px">Restart</button></div>
  </div>

  <div id="pane-2048" class="card hidden" tabindex="0">
    <div style="font-weight:800">🔢 2048 — <span class="muted" style="font-weight:400">smooth slide • swipe too</span></div>
    <div class="score" id="s2048Score">Score: 0</div>
    <div id="board2048Wrap" tabindex="0"><div id="board2048Bg"><div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div></div><div id="board2048"></div></div>
    <div class="controls">Arrows / WASD / swipe to slide &nbsp; <button type="button" id="b2048Btn" class="btn ghost" style="padding:4px 10px;font-size:.8rem;margin-left:6px">New game</button></div>
  </div>

  <div class="foot"><a href="/">Stats</a> &middot; <a href="/dashboard">Dashboard</a> &middot; <a href="/health">Health</a></div>
</div>

<script>
var activeGame = 'rom';
var inited = { rom:true, tetris:false, '2048':false };
function switchTab(name){
  activeGame = name;
  document.querySelectorAll('.tab').forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-tab')===name); });
  document.getElementById('pane-rom').classList.toggle('hidden', name!=='rom');
  document.getElementById('pane-tetris').classList.toggle('hidden', name!=='tetris');
  document.getElementById('pane-2048').classList.toggle('hidden', name!=='2048');
  if(name==='tetris' && !inited.tetris){ initTetris(); inited.tetris=true; }
  if(name==='2048' && !inited['2048']){ init2048(); inited['2048']=true; }
  var focusMap={tetris:'tetris','2048':'board2048Wrap',rom:'romInput'};
  var el=document.getElementById(focusMap[name]); if(el) el.focus();
}
document.querySelectorAll('.tab').forEach(function(btn){
  btn.addEventListener('click', function(){ switchTab(btn.getAttribute('data-tab')); });
});

// ---- Retro ROM Library (IndexedDB, local only) ----
var ejsBlobUrl=null;
var ROM_DB=null;
function openRomDB(){ return new Promise(function(res,rej){
  var req=indexedDB.open('honeypot-arcade',1);
  req.onupgradeneeded=function(){ var db=req.result; if(!db.objectStoreNames.contains('roms')) db.createObjectStore('roms',{keyPath:'id'}); };
  req.onsuccess=function(){ ROM_DB=req.result; res(ROM_DB); };
  req.onerror=function(){ rej(req.error); };
});}
function coreForExt(ext){
  var m={gb:'gb',gbc:'gb',gba:'gba',nes:'nes',smc:'snes',sfc:'snes',snes:'snes',nds:'nds',n64:'n64',z64:'n64',zip:'gba'};
  return m[ext]||null;
}
function renderLibrary(){
  var lib=document.getElementById('romLibrary');
  if(!lib) return;
  openRomDB().then(function(db){
    var tx=db.transaction('roms','readonly');
    var st=tx.objectStore('roms');
    var req=st.getAll();
    req.onsuccess=function(){
      var arr=req.result||[];
      if(!arr.length){ lib.innerHTML='<div class="muted">Library empty — add your own dumps. They stay in this browser (IndexedDB), never on server.</div>'; return; }
      var h='<div style="display:grid;gap:6px">';
      for(var i=0;i<arr.length;i++){
        var r=arr[i];
        var sizeMB=(r.size/1024/1024).toFixed(1);
        var canPlay = !!coreForExt((r.ext||'').toLowerCase());
        h+='<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;padding:8px;background:#1c1c26;border-radius:8px;border:1px solid #2a2a3a">'
          +'<div><b>'+esc(r.name)+'</b> <span class="muted">'+sizeMB+' MB &middot; .'+esc(r.ext||'')+'</span>'+(canPlay?'':' <span style="color:#f87171;font-size:.75rem">3DS — desktop only</span>')+'</div>'
          +'<div style="display:flex;gap:6px">'+(canPlay?'<button type="button" data-play="'+esc(r.id)+'" style="background:#1c3a2a;color:#34d399;border:1px solid #234434;border-radius:6px;padding:4px 10px;cursor:pointer">Play</button>':'')
          +'<button type="button" data-del="'+esc(r.id)+'" style="background:#3a1c1c;color:#f87171;border:1px solid #442323;border-radius:6px;padding:4px 10px;cursor:pointer">Delete</button></div></div>';
      }
      lib.innerHTML=h+'</div>';
      lib.querySelectorAll('button[data-play]').forEach(function(b){ b.addEventListener('click', function(){ playRom(b.getAttribute('data-play')); }); });
      lib.querySelectorAll('button[data-del]').forEach(function(b){ b.addEventListener('click', function(){ deleteRom(b.getAttribute('data-del')); }); });
    };
  });
}
function deleteRom(id){
  openRomDB().then(function(db){
    var tx=db.transaction('roms','readwrite');
    tx.objectStore('roms').delete(id);
    tx.oncomplete=function(){ renderLibrary(); };
  });
}
function playRom(id){
  openRomDB().then(function(db){
    var tx=db.transaction('roms','readonly');
    var req=tx.objectStore('roms').get(id);
    req.onsuccess=function(){
      var r=req.result;
      if(!r) return;
      var ext=(r.ext||'').toLowerCase();
      var core=coreForExt(ext);
      var info=document.getElementById('romInfo');
      var gameDiv=document.getElementById('game');
      var hint=document.getElementById('romHint');
      if(!core){
        var gDiv2=document.getElementById('game');
        if(gDiv2){ gDiv2.style.display='block'; gDiv2.innerHTML='<div style="padding:12px;background:#1c1c26;border-radius:8px;border:1px solid #f87171"><b>3DS/CCI</b> — browser cannot reliably run 2GB images. Use Citra/Azahar desktop. File stays local.</div>'; }
        if(info) info.textContent='3DS/CCI selected ('+r.name+') — browser cannot run 3DS directly ('+ (r.size/1024/1024).toFixed(0) +' MB). Use desktop.';
        return;
      }
      if(ejsBlobUrl) { try{ URL.revokeObjectURL(ejsBlobUrl); }catch(e){} }
      var blob=new Blob([r.data], {type:'application/octet-stream'});
      ejsBlobUrl=URL.createObjectURL(blob);
      window.EJS_player='#game';
      window.EJS_core=core;
      window.EJS_gameUrl=ejsBlobUrl;
      window.EJS_pathtodata='https://cdn.emulatorjs.org/stable/data/';
      window.EJS_startOnLoaded=true;
      window.EJS_resolution='1280x720';
      window.EJS_threads=true;
      if(gameDiv){ gameDiv.style.display='block'; gameDiv.innerHTML=''; }
      if(hint) hint.style.display='block';
      if(info) info.textContent='Launching '+r.name+' ('+core+' core) — local blob, never uploaded.';
      var old=document.getElementById('ejs-loader');
      if(old) old.remove();
      var s=document.createElement('script');
      s.id='ejs-loader';
      s.src='https://cdn.emulatorjs.org/stable/data/loader.js';
      document.body.appendChild(s);
    };
  });
}
document.getElementById('romInput').addEventListener('change', function(ev){
  var files=ev.target.files;
  if(!files || !files.length) return;
  var info=document.getElementById('romInfo');
  openRomDB().then(function(db){
    var added=0;
    function next(i){
      if(i>=files.length){ if(info) info.textContent='Added '+added+' file(s) to local library.'; renderLibrary(); ev.target.value=''; return; }
      var f=files[i];
      var ext=(f.name.split('.').pop()||'').toLowerCase();
      var is3DS=['3ds','cci','cxi','cia'].indexOf(ext)>=0;
      if(is3DS && f.size>150*1024*1024){
        var tx=db.transaction('roms','readwrite');
        tx.objectStore('roms').put({id:Date.now()+'-'+i, name:f.name, ext:ext, size:f.size, data:new ArrayBuffer(0)});
        tx.oncomplete=function(){ added++; next(i+1); };
        return;
      }
      var reader=new FileReader();
      reader.onload=function(){
        try{
          var tx=db.transaction('roms','readwrite');
          tx.objectStore('roms').put({id:Date.now()+'-'+i+'-'+Math.random().toString(36).slice(2,7), name:f.name, ext:ext, size:f.size, data:reader.result});
          tx.oncomplete=function(){ added++; next(i+1); };
          tx.onerror=function(){ next(i+1); };
        }catch(e){ next(i+1); }
      };
      reader.onerror=function(){ next(i+1); };
      reader.readAsArrayBuffer(f);
    }
    next(0);
  });
});
document.getElementById('romClear').addEventListener('click', function(){
  if(!confirm('Clear local ROM library (browser only)?')) return;
  openRomDB().then(function(db){
    var tx=db.transaction('roms','readwrite');
    tx.objectStore('roms').clear();
    tx.oncomplete=function(){ renderLibrary(); var info=document.getElementById('romInfo'); if(info) info.textContent='Library cleared (local only).'; };
  });
});
renderLibrary();

// ---- Tetris (lazy) — ghost, smooth, next, flash ----
function initTetris(){
  var c=document.getElementById('tetris'), ctx=c.getContext('2d');
  var nc=document.getElementById('tetrisNext'), nctx=nc?nc.getContext('2d'):null;
  var W=10,H=20,S=20, board, cur, next, score=0, dropTimer=0, dropInterval=520, animY=0, flashRows=null, flashT=0;
  var colors=['#000','#f87171','#34d399','#60a5fa','#f5a623','#a78bfa','#f472b6','#22d3ee'];
  var shapes=[
    {m:[[1,1,1,1]], c:1}, {m:[[1,1,1],[0,1,0]], c:2}, {m:[[1,1,0],[0,1,1]], c:3},
    {m:[[0,1,1],[1,1,0]], c:4}, {m:[[1,1],[1,1]], c:5}, {m:[[1,1,1],[1,0,0]], c:6}, {m:[[1,1,1],[0,0,1]], c:7}
  ];
  function rot(m){ var h=m.length,w=m[0].length, r=[]; for(var x=0;x<w;x++){ r[x]=[]; for(var y=h-1;y>=0;y--) r[x][h-1-y]=m[y][x]; } return r; }
  function newBoard(){ board=[]; for(var y=0;y<H;y++){ board[y]=[]; for(var x=0;x<W;x++) board[y][x]=0; } }
  function pick(){ return shapes[Math.floor(Math.random()*shapes.length)]; }
  function spawn(){ var s=next||pick(); next=pick(); cur={m:s.m, c:s.c, x:Math.floor(W/2- s.m[0].length/2), y:-2, yReal:-2}; if(collides(cur.x,cur.y,cur.m)) { newBoard(); score=0; document.getElementById('tetrisScore').textContent='Score: '+score; } animY=cur.yReal; drawNext(); }
  function collides(nx,ny,m){ m=m||cur.m; for(var y=0;y<m.length;y++) for(var x=0;x<m[y].length;x++) if(m[y][x]){ var px=nx+x, py=ny+y; if(px<0||px>=W||py>=H|| (py>=0 && board[py][px])) return true; } return false; }
  function ghostY(){ var gy=cur.y; while(!collides(cur.x,gy+1,cur.m)) gy++; return gy; }
  function merge(){ for(var y=0;y<cur.m.length;y++) for(var x=0;x<cur.m[y].length;x++) if(cur.m[y][x]){ var py=cur.y+y, px=cur.x+x; if(py>=0) board[py][px]=cur.c; } }
  function clearLines(){
    var rows=[]; for(var y=H-1;y>=0;y--) if(board[y].every(function(v){return v;})) rows.push(y);
    if(!rows.length) return false;
    flashRows=rows.slice(); flashT=0;
    return true;
  }
  function doClear(){
    if(!flashRows) return;
    var rows=flashRows.slice().sort(function(a,b){return b-a;});
    for(var i=0;i<rows.length;i++){ board.splice(rows[i],1); board.unshift(Array(W).fill(0)); }
    score+=[0,100,300,500,800][rows.length]||800;
    document.getElementById('tetrisScore').textContent='Score: '+score;
    flashRows=null;
  }
  function drawNext(){
    if(!nctx) return;
    nctx.clearRect(0,0,nc.width,nc.height);
    if(!next) return;
    var m=next.m, ccol=next.c;
    var offX=Math.floor((4-m[0].length)/2), offY=Math.floor((4-m.length)/2);
    for(var y=0;y<m.length;y++) for(var x=0;x<m[y].length;x++) if(m[y][x]){
      var px=(offX+x)*14+4, py=(offY+y)*14+4;
      var grad=nctx.createLinearGradient(px,py,px+12,py+12);
      grad.addColorStop(0, colors[ccol]); grad.addColorStop(1, '#0a0a0f');
      nctx.fillStyle=grad; nctx.fillRect(px,py,12,12);
      nctx.fillStyle='rgba(255,255,255,.18)'; nctx.fillRect(px,py,12,2);
    }
  }
  function draw(){
    // lerp animY toward cur.yReal
    animY += (cur.yReal - animY) * 0.22;
    if(Math.abs(cur.yReal-animY)<0.01) animY=cur.yReal;
    ctx.clearRect(0,0,c.width,c.height);
    // subtle grid
    ctx.fillStyle='#11111a'; ctx.fillRect(0,0,c.width,c.height);
    ctx.strokeStyle='#1c1c26'; ctx.lineWidth=0.5;
    for(var gx=0;gx<=W;gx++){ ctx.beginPath(); ctx.moveTo(gx*S,0); ctx.lineTo(gx*S,H*S); ctx.stroke(); }
    for(var gy=0;gy<=H;gy++){ ctx.beginPath(); ctx.moveTo(0,gy*S); ctx.lineTo(W*S,gy*S); ctx.stroke(); }
    // board
    for(var y=0;y<H;y++) for(var x=0;x<W;x++) if(board[y][x]){
      var flashing = flashRows && flashRows.indexOf(y)>=0;
      var col=colors[board[y][x]];
      if(flashing){
        var t=flashT/160;
        var f=(Math.sin(t*14)+1)/2;
        ctx.fillStyle='rgba(255,255,255,'+(0.35+f*0.35)+')';
        ctx.fillRect(x*S,y*S,S,S);
      } else {
        var grad=ctx.createLinearGradient(x*S,y*S,x*S+S,y*S+S);
        grad.addColorStop(0, col); grad.addColorStop(1, '#0a0a0f');
        ctx.fillStyle=grad; ctx.fillRect(x*S+1,y*S+1,S-2,S-2);
        ctx.fillStyle='rgba(255,255,255,.22)'; ctx.fillRect(x*S+1,y*S+1,S-2,3);
      }
    }
    if(!cur) return;
    // ghost
    var gy=ghostY();
    if(gy!==cur.y){
      ctx.save(); ctx.globalAlpha=0.22;
      for(var y=0;y<cur.m.length;y++) for(var x=0;x<cur.m[y].length;x++) if(cur.m[y][x]){
        ctx.strokeStyle=colors[cur.c]; ctx.lineWidth=1.2; ctx.strokeRect((cur.x+x)*S+1,(gy+y)*S+1,S-2,S-2);
        ctx.fillStyle=colors[cur.c]; ctx.globalAlpha=0.08; ctx.fillRect((cur.x+x)*S+1,(gy+y)*S+1,S-2,S-2); ctx.globalAlpha=0.22;
      }
      ctx.restore();
    }
    // current with smooth y
    var drawY = animY;
    for(var y=0;y<cur.m.length;y++) for(var x=0;x<cur.m[y].length;x++) if(cur.m[y][x]){
      var py=(drawY+y)*S, px=(cur.x+x)*S;
      var col=colors[cur.c];
      var grad=ctx.createLinearGradient(px,py,px+S,py+S);
      grad.addColorStop(0, col); grad.addColorStop(1, '#0a0a0f');
      ctx.fillStyle=grad; ctx.fillRect(px+1,py+1,S-2,S-2);
      ctx.fillStyle='rgba(255,255,255,.28)'; ctx.fillRect(px+1,py+1,S-2,3);
      ctx.fillStyle='rgba(255,255,255,.06)'; ctx.fillRect(px+1,py+1,2,S-2);
    }
  }
  function tick(dt){
    if(activeGame!=='tetris' || !cur) return;
    if(flashRows){ flashT+=dt; if(flashT>160){ doClear(); spawn(); } draw(); return; }
    dropTimer+=dt;
    if(dropTimer>dropInterval){ dropTimer=0; if(!collides(cur.x,cur.y+1,cur.m)){ cur.y++; cur.yReal++; } else { merge(); if(clearLines()){ /* wait flash */ } else spawn(); } }
    draw();
  }
  var last=performance.now();
  function loop(now){ var dt=now-last; last=now; tick(dt); requestAnimationFrame(loop); }
  var dasLeft=0, dasRight=0;
  function onKey(e){
    if(activeGame!=='tetris' || !cur || flashRows) return;
    if(e.key==='ArrowLeft'){ cur.x=collides(cur.x-1,cur.y,cur.m)?cur.x:cur.x-1; e.preventDefault(); draw(); }
    else if(e.key==='ArrowRight'){ cur.x=collides(cur.x+1,cur.y,cur.m)?cur.x:cur.x+1; e.preventDefault(); draw(); }
    else if(e.key==='ArrowDown'){ if(!collides(cur.x,cur.y+1,cur.m)){ cur.y++; cur.yReal=cur.y; score+=1; document.getElementById('tetrisScore').textContent='Score: '+score; } e.preventDefault(); draw(); }
    else if(e.key==='ArrowUp'){ var r=rot(cur.m); if(!collides(cur.x,cur.y,r)) cur.m=r; e.preventDefault(); draw(); }
    else if(e.code==='Space'){ var gy=ghostY(); var dist=gy-cur.y; cur.y=gy; cur.yReal=gy; merge(); if(!clearLines()) spawn(); else score+=dist*2; document.getElementById('tetrisScore').textContent='Score: '+score; e.preventDefault(); draw(); }
  }
  document.addEventListener('keydown', onKey);
  document.getElementById('tetrisBtn').addEventListener('click', function(){ newBoard(); score=0; document.getElementById('tetrisScore').textContent='Score: 0'; flashRows=null; spawn(); document.getElementById('tetris').focus(); activeGame='tetris'; });
  newBoard(); spawn(); requestAnimationFrame(loop); draw();
}

// ---- 2048 — smooth slide with absolute tiles + swipe ----
function init2048(){
  var boardEl=document.getElementById('board2048'), scoreEl=document.getElementById('s2048Score'), wrapEl=document.getElementById('board2048Wrap');
  var g, score=0, tiles={}, nextId=1;
  // tiles: id -> {v, x, y}
  // g holds tile id per cell or 0
  function emptyIdx(){ var a=[]; for(var i=0;i<16;i++) if(!g[i]) a.push(i); return a; }
  function add(){
    var e=emptyIdx(); if(!e.length) return null;
    var idx=e[Math.floor(Math.random()*e.length)];
    var v=Math.random()<0.9?2:4;
    var id='t'+(nextId++);
    g[idx]=id; tiles[id]={v:v, id:id, merged:false};
    return {idx:idx, id:id};
  }
  function init(){ g=Array(16).fill(0); tiles={}; nextId=1; score=0; add(); add(); render([], []); scoreEl.textContent='Score: 0'; var o=document.getElementById('over2048'); if(o) o.remove(); }
  function slideInfo(rowIds){
    // rowIds: array 4 ids (or 0)
    var vals=rowIds.map(function(id){ return id?tiles[id].v:0; });
    var filtered=vals.map(function(v,i){ return {v:v, id:rowIds[i]}; }).filter(function(o){return o.v;});
    var outIds=Array(4).fill(0), outVs=Array(4).fill(0), s=0, mergedFlags=[];
    var j=0;
    for(var i=0;i<filtered.length;i++){
      if(filtered[i].v===filtered[i+1]?.v){
        // merge i and i+1 -> keep first id, bump value, retire second
        var nid=filtered[i].id;
        outIds[j]=nid; outVs[j]=filtered[i].v*2; s+=filtered[i].v*2; mergedFlags[j]=true;
        // mark second id as merged-away (will be removed)
        var remId=filtered[i+1].id;
        // we keep remId to animate to same cell then disappear; store for render
        mergedFlags[j+'_rem']=remId;
        i++; j++;
      } else {
        outIds[j]=filtered[i].id; outVs[j]=filtered[i].v; j++;
      }
    }
    return {ids:outIds, vs:outVs, score:s, merged:mergedFlags};
  }
  function move(dir){
    if(activeGame!=='2048') return;
    var before=g.slice();
    var beforeVals={}; for(var i=0;i<16;i++) if(g[i]) beforeVals[g[i]]=tiles[g[i]].v;
    var moved=false, totalScore=0, animInfos=[];
    var newTilesPos={}; // id -> {from, to}
    // snapshot positions before move
    var posBefore={}; for(var i=0;i<16;i++) if(g[i]) posBefore[g[i]]=i;
    for(var r=0;r<4;r++){
      var idx=[], vals=[];
      for(var j=0;j<4;j++){
        var p = dir==='left'? r*4+j : dir==='right'? r*4+3-j : dir==='up'? j*4+r : (3-j)*4+r;
        idx.push(p);
      }
      var rowIds=idx.map(function(p){return g[p];});
      var res=slideInfo(rowIds);
      totalScore+=res.score;
      for(var k=0;k<4;k++){
        var dest=idx[k];
        var nid=res.ids[k];
        // record animation: tile nid moves to dest
        if(nid){
          var from=posBefore[nid];
          // if merged, the second tile also animates to same dest
          if(res.merged[k]){
            var rem=res.merged[k+'_rem'];
            if(rem!=null) animInfos.push({id:rem, from:posBefore[rem], to:dest, mergedAway:true});
            // update value
            tiles[nid].v=res.vs[k];
            tiles[nid].merged=true;
          }
          animInfos.push({id:nid, from:from, to:dest, merged: !!res.merged[k]});
          newTilesPos[nid]=dest;
        }
        g[dest]=nid||0;
      }
    }
    // check moved
    for(var i=0;i<16;i++) if(g[i]!==before[i]) moved=true;
    // also value changes count as moved
    if(!moved){
      // check if any merge changed value
      for(var id in tiles) if(beforeVals[id]!==undefined && beforeVals[id]!==tiles[id].v) moved=true;
    }
    if(moved){
      // first render with animation from->to (tiles slide)
      render(animInfos, []);
      score+=totalScore;
      // after slide duration, add new tile and clean merged flags
      setTimeout(function(){
        // remove merged-away tiles
        animInfos.forEach(function(a){ if(a.mergedAway) delete tiles[a.id]; });
        // clear merged flag for next move
        for(var id in tiles) tiles[id].merged=false;
        var added=add();
        render([], added?[added.id]:[]);
        if(emptyIdx().length===0 && !canMove()) setTimeout(function(){
          var over=document.getElementById('over2048');
          if(!over){
            over=document.createElement('div');
            over.id='over2048';
            over.style.cssText='position:absolute;inset:0;background:rgba(0,0,0,.82);display:flex;flex-direction:column;align-items:center;justify-content:center;border-radius:8px;backdrop-filter:blur(2px)';
            over.innerHTML='<div style="font-family:Press Start 2P,monospace;font-size:1rem;color:#f5a623;text-shadow:0 0 8px rgba(245,166,35,.6)">GAME OVER</div><div id="overScore" style="margin:10px 0;color:#e8e8ef;font-weight:700"></div><button type="button" id="overBtn" style="background:linear-gradient(135deg,#f5a623,#f97316);color:#111;font-weight:700;border:0;border-radius:8px;padding:8px 16px;cursor:pointer;box-shadow:0 4px 12px rgba(245,166,35,.35)">New game</button>';
            wrapEl.appendChild(over);
            document.getElementById('overBtn').addEventListener('click', function(){ over.remove(); init(); wrapEl.focus(); });
          }
          document.getElementById('overScore').textContent='Score: '+score;
          over.style.display='flex';
        }, 120);
      }, 92);
    } else {
      // reset merged flags if no move
      for(var id in tiles) tiles[id].merged=false;
    }
    scoreEl.textContent='Score: '+score;
  }
  function canMove(){ for(var i=0;i<16;i++) if(!g[i]) return true; for(var y=0;y<4;y++) for(var x=0;x<4;x++){ var id=g[y*4+x]; if(!id) continue; var v=tiles[id].v; if(x<3 && g[y*4+x+1] && tiles[g[y*4+x+1]].v===v) return true; if(y<3 && g[(y+1)*4+x] && tiles[g[(y+1)*4+x]].v===v) return true; } return false; }
  function render(animInfos, newIds){
    // animInfos: [{id, from, to, merged, mergedAway}]
    // newIds: ids of freshly spawned tiles to pop
    var fromMap={}; animInfos.forEach(function(a){ fromMap[a.id]=a.from; });
    // clear boardEl but keep tiles absolutely positioned
    boardEl.innerHTML='';
    var cell=61.5, gap=6; // 4*61.5+3*6 = 264 ~ fits 260+ padding
    // we use computed: left = (col)*(61+6?) Let's compute exact: wrap 260 with padding 6 -> inner 248 -> per cell (248-18)/4=57.5
    // Use precise: col* (57.5+6)
    var cs=57.5;
    for(var id in tiles){
      var v=tiles[id].v;
      // find current pos
      var pos=-1; for(var i=0;i<16;i++) if(g[i]===id) pos=i;
      // if animating away (mergedAway) it was removed already? But during first phase we still show it sliding
      if(pos===-1){
        // still animating away — use its to
        var ai=animInfos.find(function(a){return a.id===id;});
        if(ai) pos=ai.to; else continue;
      }
      var col=pos%4, row=Math.floor(pos/4);
      var left=col*(cs+6), top=row*(cs+6);
      var from=fromMap[id];
      var isNew = newIds && newIds.indexOf(id)>=0;
      var isMerged = tiles[id].merged;
      var d=document.createElement('div');
      var cls='tile';
      if(isNew) cls+=' pop';
      if(isMerged) cls+=' merged';
      d.className=cls;
      // if animating, set initial position via transform without transition, then trigger transition to final
      if(from!=null && from!==pos){
        var fcol=from%4, frow=Math.floor(from/4);
        var fl=fcol*(cs+6), ft=frow*(cs+6);
        d.style.cssText='width:'+cs+'px;height:'+cs+'px;left:'+fl+'px;top:'+ft+'px;background:'+(v? 'hsl('+(30+Math.log2(v)*16)+',72%,48%)' : '#2b2d31')+';color:'+(v?'#fff':'transparent')+';font-size:'+(v>999?'17px': v>99?'20px':'22px');
        d.textContent=v;
        boardEl.appendChild(d);
        // force reflow then move
        void d.offsetWidth;
        d.style.left=left+'px'; d.style.top=top+'px';
      } else {
        d.style.cssText='width:'+cs+'px;height:'+cs+'px;left:'+left+'px;top:'+top+'px;background:'+(v? 'hsl('+(30+Math.log2(v)*16)+',72%,48%)' : '#2b2d31')+';color:'+(v?'#fff':'transparent')+';font-size:'+(v>999?'17px': v>99?'20px':'22px');
        d.textContent=v;
        if(isNew){
          d.style.transform='scale(.0)'; void d.offsetWidth; d.style.transform='scale(1)';
        }
        boardEl.appendChild(d);
      }
    }
    // also render animating-away tiles that are not in tiles map anymore? They were deleted after timeout, but during first phase they still exist; we handled above.
    // For slidings where tile moves but we already placed it, the merged-away tiles also need to be rendered sliding
    animInfos.forEach(function(a){
      if(!a.mergedAway) return;
      // this tile was removed from tiles, but we need to render it sliding to dest then it will disappear
      var pos=a.to, from=a.from;
      if(from===pos) return;
      // value of removed tile is same as before merge (half of merged)
      var fv=Math.floor((tiles[a.id]?.v||2)/1); // fallback
      // we don't have v, recover from before
      // Use half of target tile's value
      var targetId=animInfos.find(function(x){return x.to===pos && !x.mergedAway;})?.id;
      var targetV=targetId?tiles[targetId].v:4;
      var v=targetV/2;
      var cs2=57.5;
      var col2=from%4, row2=Math.floor(from/4);
      var fl=col2*(cs2+6), ft=row2*(cs2+6);
      var cl=pos%4, rt=Math.floor(pos/4);
      var tl=cl*(cs2+6), tt=rt*(cs2+6);
      var d=document.createElement('div');
      d.className='tile';
      d.style.cssText='width:'+cs2+'px;height:'+cs2+'px;left:'+fl+'px;top:'+ft+'px;background:hsl('+(30+Math.log2(v)*16)+',72%,48%);color:#fff;font-size:'+(v>99?'20px':'22px')+';opacity:1';
      d.textContent=v;
      boardEl.appendChild(d);
      void d.offsetWidth;
      d.style.left=tl+'px'; d.style.top=tt+'px'; d.style.opacity='0.0';
    });
  }
  function onKey(e){
    if(activeGame!=='2048') return;
    var k=e.key.toLowerCase();
    if(k==='arrowleft' || k==='a') { move('left'); e.preventDefault(); }
    else if(k==='arrowright' || k==='d') { move('right'); e.preventDefault(); }
    else if(k==='arrowup' || k==='w') { move('up'); e.preventDefault(); }
    else if(k==='arrowdown' || k==='s') { move('down'); e.preventDefault(); }
  }
  document.addEventListener('keydown', onKey);
  document.getElementById('b2048Btn').addEventListener('click', function(){ init(); wrapEl.focus(); activeGame='2048'; });
  // swipe
  var sx=0, sy=0;
  wrapEl.addEventListener('touchstart', function(e){ var t=e.touches[0]; sx=t.clientX; sy=t.clientY; }, {passive:true});
  wrapEl.addEventListener('touchend', function(e){
    if(activeGame!=='2048') return;
    var t=e.changedTouches[0]; var dx=t.clientX-sx, dy=t.clientY-sy;
    if(Math.max(Math.abs(dx),Math.abs(dy))<18) return;
    if(Math.abs(dx)>Math.abs(dy)) move(dx>0?'right':'left'); else move(dy>0?'down':'up');
  }, {passive:true});
  wrapEl.addEventListener('keydown', onKey);
  init();
}

</script>
</body>
</html>`;
