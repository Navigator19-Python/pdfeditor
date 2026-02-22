"use client";

import { useState } from "react";
import { signInWithEmailAndPassword, createUserWithEmailAndPassword } from "firebase/auth";
import { auth } from "../../lib/firebase";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");

  async function login() {
    setErr("");
    try {
      await signInWithEmailAndPassword(auth, email, pw);
      router.push("/dashboard");
    } catch (e) {
      setErr(e?.message || "Login failed");
    }
  }

  async function signup() {
    setErr("");
    try {
      await createUserWithEmailAndPassword(auth, email, pw);
      router.push("/dashboard");
    } catch (e) {
      setErr(e?.message || "Signup failed");
    }
  }

  return (
    <div style={styles.wrap}>
      <div style={styles.card}>
        <h2 style={{ marginTop: 0 }}>PDF Docs</h2>
        <p style={{ color: "#555" }}>Login or create an account</p>

        <input style={styles.input} placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input style={styles.input} placeholder="Password" type="password" value={pw} onChange={(e) => setPw(e.target.value)} />

        {err ? <div style={styles.err}>{err}</div> : null}

        <div style={{ display: "flex", gap: 10 }}>
          <button style={styles.btn} onClick={login}>Login</button>
          <button style={styles.btn2} onClick={signup}>Sign up</button>
        </div>
      </div>
    </div>
  );
}

const styles = {
  wrap: { minHeight: "100vh", display: "grid", placeItems: "center" },
  card: { width: 360, background: "white", padding: 20, borderRadius: 14, boxShadow: "0 10px 30px rgba(0,0,0,0.08)" },
  input: { width: "100%", padding: 10, margin: "8px 0", borderRadius: 10, border: "1px solid #ddd" },
  btn: { flex: 1, padding: 10, borderRadius: 10, border: "none", background: "black", color: "white", cursor: "pointer" },
  btn2: { flex: 1, padding: 10, borderRadius: 10, border: "1px solid #111", background: "white", cursor: "pointer" },
  err: { background: "#ffe5e5", padding: 10, borderRadius: 10, color: "#a40000", marginTop: 8 }
};
