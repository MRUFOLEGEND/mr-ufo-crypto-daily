(function(){
  var DATA=[],META=null;
  var F={level:'ob',tf:'all',dir:'all',st:'all',q:''};
  try{var sv=JSON.parse(localStorage.getItem('wedge-scan-f')||'null');if(sv)for(var k in F)if(sv[k]!=null)F[k]=sv[k]}catch(e){}
  function fp(x){if(x==null||!isFinite(x))return '–';var a=Math.abs(x);var d=a>=1000?1:a>=100?2:a>=1?4:a>=0.01?5:7;return (+x.toFixed(d)).toLocaleString('en-US',{maximumFractionDigits:d})}
  function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
  var lvlCls={'WATCH':'bias-bull','WEAK':'bias-neutral','TESTED OB':'bias-neutral','NO OB':'bias-neutral'};
  function pass(h){
    if(F.level==='ob'&&!(h.level==='WATCH'||h.level==='WEAK'))return false;
    if(F.level==='watch'&&h.level!=='WATCH')return false;
    if(F.tf!=='all'&&h.tf!==F.tf)return false;
    if(F.dir!=='all'&&h.dir!==F.dir)return false;
    if(F.st!=='all'&&h.status!==F.st)return false;
    if(F.q&&h.sym.indexOf(F.q.toUpperCase())<0)return false;
    return true;
  }
  function id(h,i){return 'w-'+h.sym+'-'+h.tf+'-'+h.dir+'-'+h.status+'-'+i}
  function chart(h){
    var W=480,H=250,pl=6,pr=110,pt=10,pb=18,bars=h.bars,n=bars.length,fut=6,N=n+fut,bw=(W-pl-pr)/N;
    var lo=Infinity,hi=-Infinity;bars.forEach(function(b){lo=Math.min(lo,b[2]);hi=Math.max(hi,b[1])});
    [h.stop,h.entry].forEach(function(v){lo=Math.min(lo,v);hi=Math.max(hi,v)});
    if(h.ob){lo=Math.min(lo,h.ob.lo);hi=Math.max(hi,h.ob.hi)}
    var pad=(hi-lo)*0.04;lo-=pad;hi+=pad;
    var y=function(v){return pt+(hi-v)/(hi-lo)*(H-pt-pb)},x=function(k){return pl+(k+0.5)*bw};
    var s='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+esc(h.sym+' '+h.tf+' '+h.type)+' chart">';
    if(h.ob){var oc=h.dir==='short'?'#ff3d5a':'#00d97e';s+='<rect x="'+pl+'" y="'+y(h.ob.hi).toFixed(1)+'" width="'+(W-pl-pr)+'" height="'+Math.max(2,y(h.ob.lo)-y(h.ob.hi)).toFixed(1)+'" fill="'+oc+'" fill-opacity=".12" stroke="'+oc+'" stroke-opacity=".6" stroke-dasharray="4 3"/>';
      s+='<text x="'+(pl+4)+'" y="'+(y(h.ob.hi)-3).toFixed(1)+'" font-size="12" fill="'+oc+'" font-family="monospace">4H '+(h.dir==='short'?'SUPPLY':'DEMAND')+' OB</text>'}
    if(h.zone&&h.zone.hi>lo&&h.zone.lo<hi){var zc=h.dir==='short'?'#00d97e':'#ff3d5a';s+='<rect x="'+pl+'" y="'+y(Math.min(hi,h.zone.hi)).toFixed(1)+'" width="'+(W-pl-pr)+'" height="'+Math.max(2,y(Math.max(lo,h.zone.lo))-y(Math.min(hi,h.zone.hi))).toFixed(1)+'" fill="'+zc+'" fill-opacity=".07"/>'}
    for(var k=0;k<n;k++){var b=bars[k],up=b[3]>=b[0],c=up?'#00d97e':'#ff3d5a',inW=k>=h.start;
      s+='<line x1="'+x(k).toFixed(1)+'" x2="'+x(k).toFixed(1)+'" y1="'+y(b[1]).toFixed(1)+'" y2="'+y(b[2]).toFixed(1)+'" stroke="'+c+'" stroke-opacity="'+(inW?1:.45)+'"/>';
      var yt=y(Math.max(b[0],b[3])),yb=y(Math.min(b[0],b[3]));s+='<rect x="'+(x(k)-bw*0.35).toFixed(1)+'" y="'+yt.toFixed(1)+'" width="'+(bw*0.7).toFixed(1)+'" height="'+Math.max(1,yb-yt).toFixed(1)+'" fill="'+c+'" fill-opacity="'+(inW?1:.45)+'"/>'}
    function ln(A,B,col){var s1=(Math.log(B[1])-Math.log(A[1]))/(B[0]-A[0]),k0=h.start,k1=N-1,v=function(k){return Math.exp(Math.log(A[1])+s1*(k-A[0]))};return '<line x1="'+x(k0).toFixed(1)+'" y1="'+y(v(k0)).toFixed(1)+'" x2="'+x(k1).toFixed(1)+'" y2="'+y(v(k1)).toFixed(1)+'" stroke="'+col+'" stroke-width="1.6"/>'}
    s+=ln(h.lines.tA,h.lines.tB,'#4e7fff')+ln(h.lines.oA,h.lines.oB,'#9b59f5');
    function hl(v,col,lab){var off=v<lo?'↓':v>hi?'↑':'';if(off){lab=lab+off+' '+fp(v);v=v<lo?lo+(hi-lo)*0.01:hi-(hi-lo)*0.01}var yy=y(v).toFixed(1);return '<line x1="'+pl+'" x2="'+(W-pr)+'" y1="'+yy+'" y2="'+yy+'" stroke="'+col+'" stroke-dasharray="5 4" stroke-width="1.2"/><text x="'+(W-pr+4)+'" y="'+(+yy+4)+'" font-size="12" fill="'+col+'" font-family="monospace">'+lab+'</text>'}
    s+=hl(h.entry,'#ffffff',h.status==='TRIGGERED'?'ENTRY':'TRIGGER')+hl(h.stop,'#ff3d5a','STOP')+hl(h.t1,'#00d97e','2R');
    s+='<line x1="'+x(n-0.5).toFixed(1)+'" x2="'+x(n-0.5).toFixed(1)+'" y1="'+pt+'" y2="'+(H-pb)+'" stroke="#2a2f48"/><text x="'+(x(n-0.5)+3).toFixed(1)+'" y="'+(H-5)+'" font-size="12" fill="#8891b0" font-family="monospace">now</text>';
    return s+'</svg>';
  }
  function mark(v){return v===true?'<span class="m y">✓</span>':v===false?'<span class="m n">✗</span>':'<span class="m u">–</span>'}
  function card(h,i){
    var sh=h.dir==='short',tfl=h.tf,P=h.pts,trig=sh?'lower':'upper',out=sh?'upper':'lower';
    var tv='https://www.tradingview.com/chart/?symbol=OKX:'+h.sym+'USDT.P';
    var status=h.status==='FORMING'?'<span class="bias bias-neutral">Forming</span>':'<span class="bias '+(sh?'bias-bear':'bias-bull')+'">Triggered '+h.barsSinceBreak+' candle'+(h.barsSinceBreak===1?'':'s')+' ago</span>';
    var rz=h.rrZone==null?'none found':h.rrZone.toFixed(1)+'R';
    var der=h.der&&h.der.funding!=null?('funding '+h.der.funding.toFixed(4)+'%, OI '+(h.der.oiChg==null?'n/a':(h.der.oiChg>0?'+':'')+h.der.oiChg.toFixed(1)+'%')+' in 24h'):'not fetched (no fresh OB)';
    var s='<article class="card wc" id="'+id(h,i)+'"><div class="card-hdr"><div class="top"><span class="sym">'+h.sym+'</span><span class="tf">'+tfl+'</span><span class="bias '+(sh?'bias-bear':'bias-bull')+'">'+h.type+' → '+(sh?'short':'long')+' idea</span></div><span class="card-hint">'+h.dur+' candles · '+h.touches+' touches</span></div><div class="card-body">';
    s+='<div class="top" style="display:flex;gap:8px;flex-wrap:wrap"><span class="bias '+lvlCls[h.level]+'"'+(h.level==='WATCH'?'':' style="'+(h.level==='WEAK'?'':'color:var(--dim);border-color:var(--border);background:var(--surface2)')+'"')+'>'+h.level+' · '+h.score+'/6</span>'+status+'</div>';
    s+='<div class="chart">'+chart(h)+'</div>';
    s+='<div class="lv"><div><span>'+(h.status==='TRIGGERED'?'Entry (break close)':'Trigger')+'</span><b>'+fp(h.entry)+'</b></div><div><span>Stop</span><b style="color:var(--bear)">'+fp(h.stop)+'</b></div><div><span>Target 1 · 2R</span><b style="color:var(--bull)">'+fp(h.t1)+'</b></div><div><span>Risk</span><b>'+h.riskPct.toFixed(2)+'%</b></div><div><span>R to '+(sh?'demand':'supply')+'</span><b class="'+(h.rrZone!=null&&h.rrZone>=2?'pos':'neg')+'">'+rz+'</b></div><div><span>Wedge base</span><b>'+fp(h.base)+' · '+h.rrBase.toFixed(1)+'R</b></div></div>';
    s+='<div class="rules">';
    if(h.status==='FORMING'){s+='<p class="v"><b>Validation:</b> a '+tfl+' candle closes '+(sh?'below':'above')+' the '+trig+' line, now at <b>'+fp(h.trigNow)+'</b> and '+(h.trigSlopePct>=0?'rising ':'falling ')+Math.abs(h.trigSlopePct).toFixed(2)+'% per candle.</p>';
      s+='<p class="x"><b>Setup void:</b> a '+tfl+' candle closes '+(sh?'above':'below')+' the '+out+' line (now '+fp(h.outerNow)+') before the trigger.</p>'}
    else{s+='<p class="v"><b>Validated:</b> closed through the '+trig+' line '+h.barsSinceBreak+' candle(s) ago at '+fp(h.entry)+'. Price now '+fp(h.lastClose)+' = <b class="'+(h.movedR>=0?'pos':'neg')+'">'+(h.movedR>=0?'+':'')+h.movedR.toFixed(2)+'R</b>'+(h.movedR>0.5?' (late: don\'t chase)':'')+'.</p>'}
    s+='<p class="x"><b>Invalidation:</b> stop at '+fp(h.stop)+(h.ob?(sh?', above the order-block top':', below the order-block bottom'):(sh?', above the wedge high':', below the wedge low'))+' + 0.25 ATR.</p>';
    s+='<p class="t"><b>Targets:</b> 2R at '+fp(h.t1)+(h.zone?'; next '+(sh?'demand':'supply')+' zone '+fp(h.zone.lo)+'–'+fp(h.zone.hi)+' ('+rz+')':'')+'; wedge base '+fp(h.base)+'.'+(h.rrZone!=null&&h.rrZone<2?' <b class="neg">Less than 2R to the next zone: skip by rule 8.</b>':'')+'</p></div>';
    s+='<div class="cl">';
    s+='<div>'+mark(P.location)+'<span class="k">1 Order block</span><span class="d">'+(h.ob?('4H '+(sh?'supply':'demand')+' '+fp(h.ob.lo)+'–'+fp(h.ob.hi)+(h.ob.fresh?', fresh':', already tested')):(h.anyOb?'only a tested OB nearby':'none at the wedge extreme'))+'</span></div>';
    s+='<div>'+mark(P.volume)+'<span class="k">2 Volume</span><span class="d">last third '+h.volFade.toFixed(2)+'× first third'+(h.breakVol!=null?', break candle '+h.breakVol.toFixed(1)+'× avg':', break volume pending')+'</span></div>';
    s+='<div>'+mark(P.sweep)+'<span class="k">3 Sweep</span><span class="d">'+(P.sweep?'wick through the '+out+' line, closed back inside':'no throw-over in the last third')+'</span></div>';
    s+='<div>'+mark(P.divergence)+'<span class="k">4 RSI div.</span><span class="d">'+(P.divergence?(sh?'bearish':'bullish')+' divergence over the last two swings':'none')+'</span></div>';
    s+='<div>'+mark(P.derivatives)+'<span class="k">5 Derivatives</span><span class="d">'+der+'</span></div>';
    s+='<div>'+mark(P.context)+'<span class="k">6 Context</span><span class="d">coin 4H trend '+(h.trend.coin?'✓':'✗')+', BTC vs 4H EMA50 '+(h.trend.btc?'✓':'✗')+'</span></div>';
    s+='<div><span class="m u">?</span><span class="k">7–8 Your call</span><span class="d">confirm the close and the 2R room on your own chart</span></div></div>';
    s+='<div class="links"><a href="'+tv+'" target="_blank" rel="noopener">Open '+h.sym+' on TradingView ↗</a></div>';
    return s+'</div></article>';
  }
  function tiles(){
    var c=function(k){return DATA.filter(function(h){return h.level===k}).length},coins={};DATA.forEach(function(h){coins[h.sym]=1});
    var f=DATA.filter(function(h){return h.status==='FORMING'}).length;
    document.getElementById('tiles').innerHTML='<div class="card gate"><span class="lbl">Wedges found</span><span class="big">'+DATA.length+'</span><p>On '+Object.keys(coins).length+' of '+META.coins+' coins. '+f+' forming, '+(DATA.length-f)+' broke in the last 3 candles.</p></div>'+
      '<div class="card gate"><span class="lbl">Watch</span><span class="big" style="color:var(--bull)">'+c('WATCH')+'</span><p>Ends in a fresh 4H order block + at least 2 of the 5 extra checks.</p></div>'+
      '<div class="card gate"><span class="lbl">Weak</span><span class="big" style="color:var(--neutral)">'+c('WEAK')+'</span><p>Fresh order block, but fewer than 2 extra checks.</p></div>'+
      '<div class="card gate"><span class="lbl">No fresh OB</span><span class="big" style="color:var(--dim)">'+(c('TESTED OB')+c('NO OB'))+'</span><p>'+c('TESTED OB')+' at an order block that was already tested, '+c('NO OB')+' with no order block. The backtest says: coin flip.</p></div>';
  }
  function iso(ms){return new Date(ms).toISOString().slice(0,16).replace('T',' ')+' UTC'}
  function ago(ms){var m=Math.round((Date.now()-ms)/60000);return m<1?'just now':m<60?m+' min ago':Math.floor(m/60)+'h '+(m%60)+'m ago'}
  function stamp(){if(!META)return;document.getElementById('stamp').innerHTML='Scan '+iso(META.at)+' · <b>'+ago(META.at)+'</b><br>OKX public API · '+META.coins+' USDT perps · 15m / 1H / 4H';
    var w=document.getElementById('stale');if(w)w.hidden=!(window.WEDGE_SRC&&Date.now()-META.at>45*60000);}
  setInterval(stamp,15000);
  function render(){
    if(!META)return;tiles();stamp();
    var rows='',cards='',shown=0;
    DATA.forEach(function(h,i){if(!pass(h))return;shown++;var sh=h.dir==='short';
      rows+='<tr><td class="sym"><a href="#'+id(h,i)+'">'+h.sym+'</a></td><td>'+h.tf+'</td><td class="'+(sh?'neg':'pos')+'">'+(sh?'Rising → short':'Falling → long')+'</td><td>'+(h.status==='FORMING'?'Forming':'Triggered '+h.barsSinceBreak)+'</td><td>'+h.level+'</td><td>'+h.score+'/6</td><td>'+fp(h.entry)+'</td><td class="neg">'+fp(h.stop)+'</td><td class="pos">'+fp(h.t1)+'</td><td>'+h.riskPct.toFixed(1)+'%</td><td class="'+(h.rrZone!=null&&h.rrZone>=2?'pos':'')+'">'+(h.rrZone==null?'–':h.rrZone.toFixed(1)+'R')+'</td></tr>';
      cards+=card(h,i)});
    document.getElementById('tb').innerHTML=rows;document.getElementById('cards').innerHTML=cards;
    document.getElementById('none').hidden=shown>0;document.getElementById('shown').textContent=shown+' of '+DATA.length+' wedges shown';
    [].slice.call(document.querySelectorAll('.chip')).forEach(function(b){b.setAttribute('aria-pressed',F[b.getAttribute('data-f')]===b.getAttribute('data-v'))});
    try{localStorage.setItem('wedge-scan-f',JSON.stringify(F))}catch(e){}
  }
  [].slice.call(document.querySelectorAll('.chip')).forEach(function(b){b.addEventListener('click',function(){F[b.getAttribute('data-f')]=b.getAttribute('data-v');render()})});
  var q=document.getElementById('q');q.value=F.q;q.addEventListener('input',function(){F.q=q.value.trim();render()});
  function setData(j){DATA=j.list||[];META=j;render()}
  var btn=document.getElementById('refresh'),st=document.getElementById('rstatus'),conn=document.getElementById('conn');
  function load(){
    var t0=Date.now(),prev=META?META.at:null;btn.disabled=true;btn.textContent='Loading…';
    fetch(window.WEDGE_SRC+'?t='+t0,{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(function(j){
      var ms=Date.now()-t0;setData(j);
      var w=DATA.filter(function(h){return h.level==='WATCH'}).length;
      st.className='rs ok';st.textContent='✓ Loaded at '+new Date().toISOString().slice(11,19)+' UTC in '+(ms/1000).toFixed(1)+'s · '+DATA.length+' wedges · '+w+' watch'+(prev&&prev===j.at?' · no newer scan yet':'');
      conn.className='bias bias-bull';conn.textContent='Scan data reachable · '+ms+' ms';
    }).catch(function(e){
      st.className='rs bad';st.textContent='✗ Refresh failed: '+e.message+'. '+(META?'Still showing the scan from '+iso(META.at)+'.':'No data loaded. Try again in a minute.');
      conn.className='bias bias-bear';conn.textContent='Scan data unreachable';
    }).then(function(){btn.disabled=false;btn.textContent='Refresh';st.classList.add('flash');setTimeout(function(){st.classList.remove('flash')},1200)});
  }
  if(window.WEDGE_EMBED){setData(window.WEDGE_EMBED)}else{btn.addEventListener('click',load);load()}
})();
