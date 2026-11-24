const $=i=>document.getElementById(i);
const log=m=>{const l=$('log');l.textContent+=m+'\n';l.scrollTop=1e9};
const alog=m=>{const l=$('audlog');l.textContent+=m+'\n'};
const hexish=s=>/^[0-9a-f]{64}$/.test(String(s||'').toLowerCase());
const relays=()=>[...new Set($('relays').value.split(/\s+/).map(s=>s.trim()).filter(u=>/^wss:\/\//.test(u)))];
const chunk=(a,n)=>{const o=[];for(let i=0;i<a.length;i+=n)o.push(a.slice(i,i+n));return o};
const baseD=()=>$('d').value.trim()||'extended';
// 1 for "extended", N for "extended-N", 0 for anything else
const chunkIndex=(d,base)=>{
  if(d===base) return 1;
  if(!d.startsWith(base+'-')) return 0;
  const n=d.slice(base.length+1);
  return /^\d+$/.test(n)?+n:0;
};
const newest=map=>{ const e=[...map.values()].sort((a,b)=>b.created_at-a.created_at)[0]; return e; };
const tagsOf=e=>Array.isArray(e&&e.tags)?e.tags:[];
const tagValue=(e,name)=>{ const t=tagsOf(e).find(t=>Array.isArray(t)&&t[0]===name); return t?t[1]:undefined; };
const pTags=e=>[...new Set(tagsOf(e).filter(t=>Array.isArray(t)&&t[0]==='p'&&hexish(t[1])).map(t=>t[1].toLowerCase()))];
let members=[],signer=null,me=null,busy=false;

async function getSigner(){
  for(let i=0;i<20;i++){ if(window.nostr&&window.nostr.signEvent) return window.nostr;
    await new Promise(r=>setTimeout(r,100)); }
  throw new Error(location.protocol==='file:'
    ?'Opened as a file. Serve from http://localhost:8000/ instead.'
    :'No NIP-07 signer found. Enable Alby (or another NIP-07 extension) for this site, then reload.');
}

function queryRelay(url,filters,onEvent,timeoutMs){
  return new Promise(done=>{
    let ws,timer=0,settled=false;
    const finish=why=>{ if(settled)return; settled=true; clearTimeout(timer);
      try{ws&&ws.close()}catch(e){} log(`  ${url}: ${why}`); done(); };
    timer=setTimeout(()=>finish('timeout'),timeoutMs);
    try{ ws=new WebSocket(url); }catch(e){ return finish('bad url'); }
    const sub='q'+Math.random().toString(36).slice(2,8);
    ws.onopen=()=>ws.send(JSON.stringify(['REQ',sub,...filters]));
    ws.onmessage=m=>{ let d; try{d=JSON.parse(m.data)}catch(e){return}
      if(d[0]==='EVENT'&&d[1]===sub&&d[2]&&typeof d[2]==='object') onEvent(d[2]);
      else if(d[0]==='EOSE'&&d[1]===sub) finish('done');
      else if(d[0]==='CLOSED'&&d[1]===sub) finish('closed: '+(d[2]||'')); };
    ws.onerror=()=>finish('error');
    ws.onclose=()=>finish('closed');
  });
}

function publishEvent(url,signed){
  return new Promise(res=>{
    let ws,timer=0,settled=false;
    const finish=(ok,why)=>{ if(settled)return; settled=true; clearTimeout(timer);
      log(`  ${url}: ${why}`); try{ws&&ws.close()}catch(e){} res(ok); };
    timer=setTimeout(()=>finish(false,'timeout'),12000);
    try{ ws=new WebSocket(url); }catch(e){ return finish(false,'bad url'); }
    ws.onopen=()=>ws.send(JSON.stringify(['EVENT',signed]));
    ws.onmessage=m=>{ let d; try{d=JSON.parse(m.data)}catch(e){return}
      if(d[0]==='OK'&&d[1]===signed.id) finish(!!d[2],d[2]?'OK true':'OK false '+(d[3]||''));
      else if(d[0]==='NOTICE') log(`  notice ${url}: ${d[1]}`); };
    ws.onerror=()=>finish(false,'error');
    ws.onclose=()=>finish(false,'closed');
  });
}

$('go').onclick=async()=>{
  if(busy) return; busy=true;
  $('go').disabled=true; $('pub').disabled=$('dl').disabled=true;
  $('log').textContent=''; $('preview').innerHTML=''; members=[]; me=null;
  try{
    try{ signer=await getSigner(); }catch(e){ return log(e.message); }
    try{ me=(await signer.getPublicKey()).toLowerCase(); }
    catch(e){ return log('Could not read your public key: '+e.message); }
    log('me: '+me);
    const rs=relays(); if(!rs.length) return log('Add at least one wss:// relay.');
    log(`relays: ${rs.length}`);

    // my follow list
    const mine=new Map();
    await Promise.all(rs.map(u=>queryRelay(u,[{kinds:[3],authors:[me]}],e=>{
      const p=mine.get(e.pubkey); if(!p||e.created_at>p.created_at) mine.set(e.pubkey,e); },15000)));
    const myEvent=newest(mine);
    if(!myEvent) return log('Could not fetch your kind 3 follow list — add more relays.');
    const follows=[...new Set(pTags(myEvent))].filter(p=>p!==me);
    log(`follows: ${follows.length}`); if(!follows.length) return log('Follow list looks empty.');

    // mute list (for exclusion)
    const muteMap=new Map();
    await Promise.all(rs.map(u=>queryRelay(u,[{kinds:[10000],authors:[me]}],e=>{
      const p=muteMap.get(e.pubkey); if(!p||e.created_at>p.created_at) muteMap.set(e.pubkey,e); },8000)));
    const muted=new Set(newest(muteMap)?pTags(newest(muteMap)):[]);
    log(`muted: ${muted.size}`);

    // their follow lists — keep only the newest copy per author so one person
    // cannot be counted twice just because two relays serve different versions
    const followSet=new Set(follows);
    const filters=chunk(follows,200).map(authors=>({kinds:[3],authors}));
    const latest=new Map();
    log(`querying ${filters.length} chunk(s)…`);
    await Promise.all(rs.map(u=>queryRelay(u,filters,e=>{
      if(!followSet.has(e.pubkey)) return;
      const prev=latest.get(e.pubkey);
      if(!prev||e.created_at>prev.created_at||(e.created_at===prev.created_at&&e.id>prev.id)) latest.set(e.pubkey,e);
    },30000)));
    log(`follow lists seen: ${latest.size} of ${follows.length}`);

    const counts=new Map();
    for(const e of latest.values()){
      for(const p of pTags(e)){
        if(p===me||followSet.has(p)||muted.has(p)) continue;
        counts.set(p,(counts.get(p)||0)+1);
      }
    }
    log(`second-degree candidates: ${counts.size}`);

    const th=Math.max(1,+$('th').value||10), max=Math.max(1,+$('max').value||1000);
    const ranked=[...counts.entries()].sort((a,b)=>b[1]-a[1]);
    const qualified=ranked.filter(([,c])=>c>=th);
    members=qualified.slice(0,max).map(([p])=>p);
    log(`qualified at ≥${th}: ${qualified.length}; keeping ${members.length}`);
    if(!members.length) return log('Nothing qualified — lower the threshold.');

    $('preview').innerHTML='<h2>Top candidates</h2><table><tr><th>pubkey</th><th>followed by</th></tr>'
      +ranked.slice(0,10).map(([p,c])=>`<tr><td><code>${p.slice(0,16)}…</code></td><td>${c}</td></tr>`).join('')
      +'</table>';
    $('pub').disabled=$('dl').disabled=false;
    log('review the top candidates, then Sign & publish.');
  } finally {
    busy=false; $('go').disabled=false;
  }
};

$('pub').onclick=async()=>{
  if(busy||!signer||!members.length) return;
  busy=true; $('go').disabled=$('pub').disabled=$('dl').disabled=true;
  try{
    const raw=+$('cs').value||700, size=Math.max(100,Math.min(800,raw));
    if(size!==raw) log(`chunk size adjusted to ${size}: relays reject events over ~64 KB.`);
    const groups=chunk(members,size);
    const base=baseD();
    const name=($('title').value.trim()||base);
    const rs=relays();
    for(let i=0;i<groups.length;i++){
      const d=i===0?base:`${base}-${i+1}`;
      const tags=[['d',d],['title',groups.length>1?`${name} ${i+1}`:name]];
      for(const p of groups[i]) tags.push(['p',p]);
      const ev={kind:30000,created_at:Math.floor(Date.now()/1000),tags,content:'',pubkey:me};
      log(`signing ${d} with ${groups[i].length} members…`);
      let signed; try{ signed=await signer.signEvent(ev); }catch(e){ return log('signing failed: '+e); }
      const bytes=new TextEncoder().encode(JSON.stringify(signed)).length;
      log(`event id: ${signed.id} (${bytes} bytes)`);
      if(bytes>65000){ log(`  ${d} is too large for most relays — skipping. Lower chunk size and republish.`); continue; }
      const results=await Promise.all(rs.map(u=>publishEvent(u,signed)));
      const ok=results.filter(Boolean).length;
      log(`  ${d}: accepted by ${ok}/${results.length} relay(s)`);
      if(ok<results.length) log(`  ${results.length-ok} relay(s) did not store ${d} — republish or remove them, then re-check the audit.`);
    }

    // overwrite chunks left over from a longer previous run with an empty list
    if($('clean').checked){
      const existing=new Map();
      await Promise.all(rs.map(u=>queryRelay(u,[{kinds:[30000],authors:[me]}],e=>{
        const d=tagValue(e,'d');
        if(!d||!chunkIndex(d,base)) return;
        const prev=existing.get(d);
        if(!prev||e.created_at>prev.created_at) existing.set(d,e);
      },10000)));
      const stale=[...existing.entries()]
        .filter(([d,e])=>chunkIndex(d,base)>groups.length&&pTags(e).length)
        .map(([d,e])=>({d,at:e.created_at}))
        .sort((a,b)=>chunkIndex(a.d,base)-chunkIndex(b.d,base));
      if(!stale.length) log('no stale chunks to retire.');
      else{
        log(`retiring ${stale.length} stale chunk(s): ${stale.map(s=>s.d).join(', ')}`);
        for(const {d,at} of stale){
          const ev={kind:30000,created_at:Math.max(Math.floor(Date.now()/1000),at+1),
            tags:[['d',d],['title',`${name} (retired)`]],content:'',pubkey:me};
          let signed; try{ signed=await signer.signEvent(ev); }
          catch(e){ log(`  could not sign retired ${d}: ${e}`); break; }
          const results=await Promise.all(rs.map(u=>publishEvent(u,signed)));
          log(`  ${d}: retired on ${results.filter(Boolean).length}/${results.length} relay(s)`);
        }
      }
    }
    log(`published ${groups.length} list(s): ${groups.map(g=>g.length).join(' + ')} members. Force-stop the app, reopen, use "All User Follows".`);
  } finally {
    busy=false; $('go').disabled=$('pub').disabled=$('dl').disabled=false;
  }
};

$('dl').onclick=()=>{
  if(!members.length) return;
  const blob=new Blob([members.join('\n')+'\n'],{type:'text/plain'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download='ext.txt'; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),2000);
};

$('audgo').onclick=async()=>{
  if(busy) return;
  if(!me) return alog('Run "Fetch & analyze" once first.');
  const x=$('aud').value.trim().toLowerCase();
  if(!hexish(x)) return alog('Not a 64-char hex key.');
  busy=true; $('audgo').disabled=true;
  $('audlog').textContent='';
  try{
    const rs=relays();

    const mk=new Map(), mm=new Map();
    await Promise.all(rs.map(u=>queryRelay(u,[{kinds:[3],authors:[me]}],e=>{
      const p=mk.get(e.pubkey); if(!p||e.created_at>p.created_at) mk.set(e.pubkey,e);},12000)));
    await Promise.all(rs.map(u=>queryRelay(u,[{kinds:[10000],authors:[me]}],e=>{
      const p=mm.get(e.pubkey); if(!p||e.created_at>p.created_at) mm.set(e.pubkey,e);},8000)));
    const follows=new Set(newest(mk)?pTags(newest(mk)).filter(p=>p!==me):[]);
    const mute=newest(mm)?pTags(newest(mm)):[];
    alog(`you follow them: ${follows.has(x)?'YES — excluded from candidates':'no'}`);
    alog(`muted: ${mute.includes(x)?'YES':'no'}`);

    // check every chunk (base, base-2, base-3, …), not just the first one
    const base=baseD();
    for(const u of rs){
      const byD=new Map();
      await queryRelay(u,[{kinds:[30000],authors:[me]}],e=>{
        const d=tagValue(e,'d');
        if(!d||!chunkIndex(d,base)) return;
        const prev=byD.get(d);
        if(!prev||e.created_at>prev.created_at) byD.set(d,e);
      },10000);
      if(!byD.size){ alog(`${u}: no copy`); continue; }
      let n=0, has=false, at=0;
      for(const e of byD.values()){
        n+=pTags(e).length;
        if(pTags(e).includes(x)) has=true;
        if(e.created_at>at) at=e.created_at;
      }
      alog(`${u}: ${n} members in ${byD.size} list(s), ${has?'CONTAINS':'MISSING'} them, ${new Date(at*1000).toISOString()}`);
    }

    const f=[...follows];
    const voters=new Set();
    await Promise.all(rs.map(u=>queryRelay(u,chunk(f,200).map(authors=>({kinds:[3],authors})),e=>{
      if(follows.has(e.pubkey)&&e.pubkey!==x&&pTags(e).includes(x)) voters.add(e.pubkey);},30000)));
    alog(`mutual follows: ${voters.size} of ${f.length} follow lists`);

    const pm=new Map(), rl=new Map(); let note=0;
    await Promise.all(rs.map(u=>queryRelay(u,
      [{kinds:[0],authors:[x]},{kinds:[10002],authors:[x]},{kinds:[1],authors:[x],limit:5}],
      e=>{ if(e.kind===0){const p=pm.get(x); if(!p||e.created_at>p.created_at) pm.set(x,e);}
           if(e.kind===10002){const p=rl.get(x); if(!p||e.created_at>p.created_at) rl.set(x,e);}
           if(e.kind===1&&e.created_at>note) note=e.created_at; },15000)));
    let name='(no profile)'; const pe=newest(pm);
    if(pe){ try{const j=JSON.parse(pe.content); name=j.display_name||j.name||name;}catch(e){} }
    alog(`profile: ${name}`);
    const re=newest(rl);
    const writeRelays=re?tagsOf(re).filter(t=>Array.isArray(t)&&t[0]==='r'&&(t[2]||'write')!=='read').map(t=>t[1]):[];
    alog(`their write relays: ${writeRelays.length?writeRelays.join(', '):'(none)'}`);
    alog(`newest note seen: ${note?new Date(note*1000).toISOString():'none'}`);
  } finally {
    busy=false; $('audgo').disabled=false;
  }
};
