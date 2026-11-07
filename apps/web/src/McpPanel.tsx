import { useEffect, useState } from "react";
import { api } from "./api";

type Info = Awaited<ReturnType<typeof api.mcpInfo>>;
const when = (iso?: string) => (iso ? new Intl.DateTimeFormat("ar", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "لم يُستخدم بعد");
const TOOLS: [string, string][] = [
  ["search_channels", "البحث في قنواتك وفي دليل iptv-org"],
  ["discover_streams", "روابط البث المصرّح بها مع نوعها (HLS/DASH) والمشغّل المناسب"],
  ["import_playlists", "استيراد قائمة M3U تملكها أو جزء من الدليل المفتوح"],
  ["sync_channels", "مزامنة مصادرك وتحديث الدليل"],
  ["validate_streams", "فحص صلاحية التشغيل دون حذف أي قناة"],
  ["get_epg", "دليل البرامج: الآن والتالي أو جدول الساعات القادمة"],
  ["list_countries", "الدول بأعلامها وعدد قنواتها والمناطق"],
  ["manage_favourites", "المفضلة على الخادم مع آخر فحص لكل قناة"],
];

/** Global IPTV MCP: per-user tokens and setup instructions for MCP clients (Claude Desktop, Claude Code, …). */
export function McpPanel() {
  const [info, setInfo] = useState<Info | null>(null);
  const [fresh, setFresh] = useState<string>("");
  const [label, setLabel] = useState("Claude");
  const [msg, setMsg] = useState("");
  const [copied, setCopied] = useState("");
  const load = () => api.mcpInfo().then(setInfo).catch((e: Error) => setMsg(e.message));
  useEffect(() => { void load(); }, []);
  const copy = (k: string, text: string) => { void navigator.clipboard?.writeText(text).then(() => { setCopied(k); setTimeout(() => setCopied(""), 1500); }); };
  const endpoint = info?.endpoint || `${location.origin}/mcp`;
  const tokenText = fresh || "gim_…";
  const desktop = JSON.stringify({ mcpServers: { "global-iptv": { command: "npx", args: ["-y", "mcp-remote", endpoint, "--header", `Authorization: Bearer ${tokenText}`] } } }, null, 2);
  const code = `claude mcp add --transport http global-iptv ${endpoint} --header "Authorization: Bearer ${tokenText}"`;

  return (
    <section className="hub-mcp">
      <div className="hub-block">
        <h4>🔌 Global IPTV MCP</h4>
        <p>خادم MCP يتيح لمساعدات الذكاء الاصطناعي (مثل Claude) البحث في قنواتك واستيرادها ومزامنتها وفحصها وإدارة مفضلتك، بالصلاحيات نفسها التي لديك في المنصة. يعمل بمصادر قانونية فقط، ولا يتجاوز أي حماية DRM أو حقوق بث.</p>
        <p className="hint">عنوان الخادم: <code dir="ltr">{endpoint}</code> <button onClick={() => copy("ep", endpoint)}>{copied === "ep" ? "✓" : "نسخ"}</button></p>
      </div>

      <div className="hub-block">
        <h4>رموز الدخول</h4>
        {msg && <p className="error">{msg}</p>}
        {fresh && (
          <div className="mcp-fresh" role="alert">
            <b>انسخ الرمز الآن — لن يظهر مرة أخرى:</b>
            <code dir="ltr">{fresh}</code>
            <button className="primary" onClick={() => copy("tok", fresh)}>{copied === "tok" ? "✓ نُسخ" : "نسخ الرمز"}</button>
          </div>
        )}
        <div className="filters">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="اسم الجهاز أو التطبيق" maxLength={60} />
          <button className="primary" onClick={() => void api.mcpCreateToken(label.trim() || "MCP").then((r) => { setFresh(r.token); return load(); }).catch((e: Error) => setMsg(e.message))}>إنشاء رمز جديد</button>
        </div>
        <ul className="hub-list">
          {(info?.tokens ?? []).map((t) => (
            <li key={t.id}>
              <span>🔑 {t.label}</span>
              <small>أُنشئ {when(t.createdAt)} · آخر استخدام: {when(t.lastUsedAt)}</small>
              <label className="hub-attest"><input type="checkbox" checked={t.autoSync} onChange={(e) => void api.mcpAutoSync(t.id, e.target.checked).then(load)} /> مزامنة يومية تلقائية</label>
              <button onClick={() => window.confirm("إلغاء هذا الرمز؟ سيتوقف أي تطبيق يستخدمه.") && void api.mcpRevokeToken(t.id).then(load)}>إلغاء</button>
            </li>
          ))}
          {info && info.tokens.length === 0 && <li><small>لا توجد رموز بعد.</small></li>}
        </ul>
        <p className="hint">يُحفظ الرمز مشفّرًا بتجزئة SHA-256 فقط، ويمكن إلغاؤه في أي وقت. المزامنة اليومية تحدّث مصادرك وتفحص قنواتك المفضلة كل صباح.</p>
      </div>

      <div className="hub-block">
        <h4>طريقة الربط</h4>
        <p><b>Claude Code:</b></p>
        <pre dir="ltr" className="mcp-code">{code}</pre>
        <button onClick={() => copy("code", code)}>{copied === "code" ? "✓" : "نسخ الأمر"}</button>
        <p><b>Claude Desktop</b> (ملف claude_desktop_config.json):</p>
        <pre dir="ltr" className="mcp-code">{desktop}</pre>
        <button onClick={() => copy("desk", desktop)}>{copied === "desk" ? "✓" : "نسخ الإعداد"}</button>
        <p className="hint">ضع رمزك مكان gim_… إن لم يظهر تلقائيًا.</p>
      </div>

      <div className="hub-block">
        <h4>الأدوات المتاحة</h4>
        <ul className="hub-list">{TOOLS.map(([n, d]) => <li key={n}><code dir="ltr">{n}</code><small>{d}</small></li>)}</ul>
      </div>
    </section>
  );
}
