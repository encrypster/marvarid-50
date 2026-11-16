// Onlayn bo'lsa har doim serverdagi eng yangi fayl olinadi; internet yo'q yoki sekin bo'lsa — keshdagi nusxa.
const CACHE='ik509-v12';
const FILES=['./','index.html','manifest.webmanifest','questions.txt','questions.ai.json','icon.svg','icon-192.png','icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES.map(f=>new Request(f,{cache:'reload'})))).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const r=e.request,u=new URL(r.url);
  if(r.method!=='GET'||u.origin!==location.origin||u.pathname.includes('/api/')||u.pathname.endsWith('/version.json'))return;
  e.respondWith((async()=>{
    const c=await caches.open(CACHE);
    const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),4000);
    try{
      const res=await fetch(r,{cache:'no-cache',signal:ctl.signal});
      clearTimeout(timer);
      if(res.ok)c.put(r,res.clone());
      return res;
    }catch(err){
      clearTimeout(timer);
      const hit=await c.match(r,{ignoreSearch:true})||(r.mode==='navigate'?await c.match('index.html'):null);
      if(hit)return hit;
      throw err;
    }
  })());
});
