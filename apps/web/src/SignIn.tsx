import { useState } from "react";
import { api, persistToken, setToken } from "./api";

export function SignIn({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { token } = await (mode === "login" ? api.login : api.register)(username, password);
      setToken(token);
      persistToken(token);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <h1>Smart Receiver</h1>
      <form onSubmit={submit}>
        <input placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        <input
          type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={mode === "register" ? 10 : 1} required
        />
        {error && <p className="error" role="alert">{error}</p>}
        <button disabled={busy}>{mode === "login" ? "Sign in / تسجيل الدخول" : "Create account / إنشاء حساب"}</button>
      </form>
      <button type="button" className="link" onClick={() => setMode(mode === "login" ? "register" : "login")}>
        {mode === "login" ? "New here? Create an account / حساب جديد" : "Have an account? Sign in / لدي حساب"}
      </button>
      {mode === "register" && <small>Password: at least 10 characters.</small>}
    </main>
  );
}
