const CACHE='staves-web-v1';
const ASSETS=['./','index.html','style.css','app.js','worker.js','manifest.webmanifest','assets/icon.svg','assets/engine.js','assets/abcjs-basic-min.js','assets/First-light.mid','assets/ABCJS-LICENSE.md'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('staves-web-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);
 if(event.request.method!=='GET'||url.origin!==self.location.origin)return;
 const base=new URL('./',self.location.href);const allowed=new Set(ASSETS.map(path=>new URL(path,base).href));
 if(!allowed.has(url.href))return;
 event.respondWith(caches.open(CACHE).then(async cache=>{const cached=await cache.match(event.request);if(cached)return cached;return fetch(event.request);}));
});
