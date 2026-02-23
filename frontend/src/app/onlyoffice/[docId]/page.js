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

      // 1) Load doc info
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
        setErr("This document has no DOCX yet. Go back and upload a DOCX or create blank.");
        return;
      }

      // 2) Ask backend for config (it will include token)
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

      const config = await r.json();
      if (!r.ok) {
        setErr("Failed to get ONLYOFFICE config from backend.");
        return;
      }

      // 3) Load ONLYOFFICE api.js
      await loadScript(`${ONLYOFFICE_URL}/web-apps/apps/api/documents/api.js`);

      // 4) Mount editor
      if (!window.DocsAPI) {
        setErr("ONLYOFFICE DocsAPI not available (check ONLYOFFICE URL).");
        return;
      }

      // Clear previous editor if any
      const holder = document.getElementById("onlyoffice-editor");
      if (holder) holder.innerHTML = "";

      // eslint-disable-next-line no-new
      new window.DocsAPI.DocEditor("onlyoffice-editor", config);
    })().catch((e) => {
      console.error(e);
      setErr("Failed to open ONLYOFFICE editor.");
    });
  }, [docId, user]);

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: 10, background: "white", borderBottom: "1px solid #e5e7eb", display: "flex", gap: 10 }}>
        <button onClick={() => router.push("/dashboard")} style={btn}>← Back</button>
        <div style={{ color: "#666", fontSize: 13 }}>Editing in ONLYOFFICE</div>
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
    s.onerror = reject;
    document.body.appendChild(s);
  });
}

const btn = { padding: "8px 10px", borderRadius: 10, border: "1px solid #ddd", background: "white", cursor: "pointer" };
