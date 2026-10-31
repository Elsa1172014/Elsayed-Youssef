/** Single-file control center (Arabic/English, RTL aware). Token is read from the URL fragment, never sent to third parties. */
export const UI_HTML = `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI NEXUS</title>
<style>
:root{--bg:#0b1220;--card:#131c31;--line:#25314d;--tx:#e8edf7;--mut:#8b97b3;--ok:#34d399;--bad:#f87171;--warn:#fbbf24;--acc:#60a5fa}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.6 system-ui,"Segoe UI",Tahoma,sans-serif}
header{padding:14px 20px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center;justify-content:space-between}
h1{font-size:18px;margin:0}main{display:grid;gap:16px;padding:16px;grid-template-columns:1fr;max-width:1100px;margin:auto}
@media(min-width:900px){main{grid-template-columns:2fr 1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
.card h2{font-size:14px;margin:0 0 10px;color:var(--mut);font-weight:600}
textarea{width:100%;min-height:80px;background:#0e1626;color:var(--tx);border:1px solid var(--line);border-radius:8px;padding:10px;font:inherit}
button{background:var(--acc);color:#04101f;border:0;border-radius:8px;padding:8px 14px;font:inherit;font-weight:600;cursor:pointer}
button.sec{background:#22304e;color:var(--tx)}button.bad{background:var(--bad)}button.ok{background:var(--ok)}
.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
.item{border-top:1px solid var(--line);padding:8px 0;font-size:13px}.item:first-child{border:0}
.tag{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;background:#22304e}
.completed,.ok{color:var(--ok)}.failed,.denied{color:var(--bad)}.running{color:var(--warn)}
pre{white-space:pre-wrap;word-break:break-word;margin:4px 0 0;color:var(--mut);font-size:12px;direction:ltr;text-align:left}
.appr{border:1px solid var(--warn);border-radius:8px;padding:8px;margin-bottom:8px}
</style></head><body>
<header><h1>AI NEXUS · مركز التحكم</h1><div class="row" style="margin:0"><span id="plat" class="tag"></span><button class="bad" onclick="stopAll()">إيقاف طارئ</button></div></header>
<main><section>
 <div class="card"><h2>مهمة جديدة</h2><textarea id="goal" placeholder="اكتب المهمة بالعربية أو الإنجليزية…"></textarea>
 <div class="row"><button onclick="submitTask()">تنفيذ</button></div></div>
 <div class="card" style="margin-top:16px"><h2>سجل التنفيذ المباشر</h2><div id="log"></div></div>
</section><aside>
 <div class="card"><h2>طلبات الموافقة</h2><div id="appr"><span style="color:var(--mut)">لا توجد طلبات</span></div></div>
 <div class="card" style="margin-top:16px"><h2>المهام الأخيرة</h2><div id="tasks"></div></div>
 <div class="card" style="margin-top:16px"><h2>خوادم MCP</h2><div id="mcp"></div></div>
</aside></main>
<script>
const token=new URLSearchParams(location.hash.slice(1)).get('token')||'';
const H={'authorization':'Bearer '+token,'content-type':'application/json'};
const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function api(p,m='GET',b){const r=await fetch('/api/'+p,{method:m,headers:H,body:b?JSON.stringify(b):undefined});return r.json()}
function log(h){const d=document.createElement('div');d.className='item';d.innerHTML=h;$('log').prepend(d)}
async function submitTask(){const goal=$('goal').value.trim();if(!goal)return;const r=await api('tasks','POST',{goal});log('▶ <b>'+esc(r.taskId||r.error)+'</b> '+esc(goal));$('goal').value='';setTimeout(refresh,500)}
async function stopAll(){await api('emergency-stop','POST');log('<span class="failed">⛔ إيقاف طارئ</span>')}
async function decide(id,ok){await api('approvals/'+id,'POST',{approve:ok});$('ap-'+id)?.remove()}
function addAppr(a){if($('ap-'+a.id))return;if($('appr').firstElementChild?.tagName==='SPAN')$('appr').innerHTML='';
 const d=document.createElement('div');d.className='appr';d.id='ap-'+a.id;
 d.innerHTML='<b>'+esc(a.tool)+'</b> <span class="tag">'+esc(a.risk)+'</span><pre>'+esc(a.summary)+'</pre><div class="row"><button class="ok" onclick="decide(\\''+a.id+'\\',true)">موافقة</button><button class="bad" onclick="decide(\\''+a.id+'\\',false)">رفض</button></div>';$('appr').prepend(d)}
async function refresh(){
 const s=await api('status');$('plat').textContent=s.platform+' · '+s.mode+' · '+s.tools.length+' tools';
 $('mcp').innerHTML=(s.mcp.map(m=>'<div class="item"><b>'+esc(m.name)+'</b> <span class="'+(m.connected?'ok':'failed')+'">'+(m.connected?'متصل':'غير متصل')+'</span> '+m.tools.length+'<pre>'+esc(m.error||'')+'</pre></div>').join(''))||'<span style="color:var(--mut)">لا توجد خوادم</span>';
 const t=await api('tasks');$('tasks').innerHTML=t.map(x=>'<div class="item"><span class="'+x.status+'">'+x.status+'</span> '+esc(x.goal.slice(0,60))+'<pre>خطوات ناجحة '+x.completed+' · موثّقة '+x.verified+' · فاشلة '+x.failed+' · مرفوضة '+x.denied+'</pre>'+(x.status==='interrupted'?'<button class="sec" onclick="api(\\'tasks/'+x.taskId+'/resume\\',\\'POST\\')">استئناف</button>':'')+'</div>').join('')}
const es=new EventSource('/api/events?token='+encodeURIComponent(token));
es.addEventListener('approval',e=>addAppr(JSON.parse(e.data)));
es.addEventListener('step',e=>{const s=JSON.parse(e.data).step;log('<span class="'+(s.denied?'denied':s.ok?'ok':'failed')+'">'+(s.denied?'⛔':s.ok?(s.verified?'✔✔':'✔'):'✖')+'</span> '+esc(s.summary)+'<pre>'+esc(s.output)+'</pre>')});
es.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.text)log('💬 '+esc(m.text))});
es.addEventListener('status',e=>{const m=JSON.parse(e.data);log('● '+m.taskId+' → <b>'+m.status+'</b>');refresh()});
refresh();setInterval(refresh,15000);
</script></body></html>`;
