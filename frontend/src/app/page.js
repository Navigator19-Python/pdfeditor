"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { watchAuth } from "../lib/auth";

export default function HomePage() {
  // undefined = still checking auth
  // null = not logged in
  // object = logged in
  const [user, setUser] = useState(undefined);
  const router = useRouter();

  useEffect(() => {
    const unsub = watchAuth(setUser);
    return () => unsub();
  }, []);

  useEffect(() => {
    if (user === undefined) return; // still loading auth state
    router.replace(user ? "/dashboard" : "/login");
  }, [user, router]);

  return (
    <main style={styles.main}>
      <div style={styles.card}>
        <div style={styles.title}>PDF Docs</div>
        <div style={styles.text}>Loading…</div>
      </div>
    </main>
  );
}

const styles = {
  main: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    background: "#f6f7fb",
    padding: 24
  },
  card: {
    width: "min(420px, 100%)",
    background: "white",
    border: "1px solid #e5e7eb",
    borderRadius: 16,
    padding: 20,
    boxShadow: "0 10px 30px rgba(0,0,0,0.06)"
  },
  title: { fontSize: 18, fontWeight: 800, marginBottom: 8 },
  text: { color: "#555" }
};
