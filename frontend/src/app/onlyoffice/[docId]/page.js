"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { db } from "../../../lib/firebase";
import { doc, getDoc } from "firebase/firestore";
import { watchAuth } from "../../../lib/auth";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL;
const ONLYOFFICE_URL = process.env.NEXT_PUBLIC_ONLYOFFICE_URL;

export default function OnlyOfficePage() {
  const { docId } = useParams();
  const router = useRouter();
  const [user, setUser] = useState(undefined);
  const [status, setStatus] = useState("Loading…");
  const [err, setErr] = useState("");

  useEffect(() => {
    const unsub = watchAuth((u) => {
      setUser(u);
      if (!u) router.push("/login");
    });
    return () => unsub();
  }, [router]);

  useEffect(() => {
    if (!user) return;

    (async () => {
      setErr("");

      if (!BACKEND) {
        setErr("Missing NEXT_PUBLIC_BACKEND_URL in Vercel env vars.");
        return;
      }
      if (!ONLYOFFICE_URL) {
        setErr("Missing NEXT_PUBLIC_ONLYOFFICE_URL in Vercel env vars.");
        return;
      }

      setStatus("Reading document info…");
      const snap = await getDoc(doc(db, "docs", docId));
      if (!snap.exists()) {
        setErr("Document not found.");
        return;
      }

      const data = snap.data();
      if (data.ownerUid !== user.uid) {
        setErr("Not allowed.");
        return;
      }

      const fileUrl = data?.onlyoffice?.docxUrl;
      if (!fileUrl) {
        setErr("No DOCX URL found yet. Go back and upload/convert first.");
        return;
      }

      setStatus("Requesting ONLYOFFICE config…");
      const r = await fetch(`${BACKEND}/onlyoffice/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          docId,
          fileUrl,
          fileType: "docx",
          title: data.title || "Document",
          user: { id: user.uid, name: user.email || "User" }
        })
      });

      const config = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(config?.error || `Backend config failed (HTTP ${r.status}).`);
        return;
      }

      setStatus("Loading ONLYOFFICE API…");
      const base = String(ONLYOFFICE_URL || "").trim().replace(/\/+$/, "");
      const apiSrc = `${base}/web-apps/apps/api/documents/api.js`;
      await loadScript(apiSrc);

      if (!window.DocsAPI) {
        setErr("ONLYOFFICE DocsAPI not found after loading api.js. Tunnel URL may be down.");
        return;
      }

      setStatus("Starting editor…");
      const holder = document.getElementById("onlyoffice-editor");
      if (holder) holder.innerHTML = "";

      // eslint-disable-next-line no-new
      new window.DocsAPI.DocEditor("onlyoffice-editor", config);

      setStatus("Editor running.");
    })().catch((e) => {
      console.error(e);
      setErr(e?.message || "Failed to open ONLYOFFICE editor.");
    });
  }, [docId, user]);

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: 10, background: "white", borderBottom: "1px solid #e5e7eb", display: "flex", gap: 10, alignItems: "center" }}>
        <button onClick={() => router.push("/dashboard")} style={btn}>← Back</button>
        <div style={{ color: "#444", fontSize: 13 }}>{status}</div>
      </div>

      {err ? <div style={{ padding: 12, color: "crimson" }}>{err}</div> : null}

      <div id="onlyoffice-editor" style={{ flex: 1, width: "100%" }} />
    </div>
  );
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) return resolve();

    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.body.appendChild(s);
  });
}

const btn = {
  padding: "8px 10px",
  borderRadius: 10,
  border: "1px solid #ddd",
  background: "white",
  cursor: "pointer"
};
