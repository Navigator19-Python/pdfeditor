"use client";
import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { db } from "../../../lib/firebase";
import { doc, getDoc } from "firebase/firestore";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL;
const ONLYOFFICE_URL = process.env.NEXT_PUBLIC_ONLYOFFICE_URL; // set this in Vercel env

export default function OnlyOfficePage() {
  const { docId } = useParams();
  const holderRef = useRef(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      setErr("");

      // 1) Get the latest docxUrl from Firestore (written by callback)
      const snap = await getDoc(doc(db, "docs", docId));
      if (!snap.exists()) return setErr("Doc not found in Firestore.");

      const data = snap.data();
      const fileUrl = data?.onlyoffice?.docxUrl;
      if (!fileUrl) return setErr("No DOCX URL yet. Upload/convert a PDF first.");

      // 2) Ask backend for ONLYOFFICE config
      const r = await fetch(`${BACKEND}/onlyoffice/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          docId,
          fileUrl,
          fileType: "docx",
          title: data.title || "Document",
          user: { id: "1", name: "User" }
        })
      });
      const config = await r.json();
      if (!r.ok) return setErr(config?.error || "Failed to create config.");

      // 3) Load ONLYOFFICE api.js
      await loadScript(`${ONLYOFFICE_URL}/web-apps/apps/api/documents/api.js`);

      // 4) Mount editor
      // eslint-disable-next-line no-undef
      new window.DocsAPI.DocEditor("onlyoffice-editor", config);
    })().catch((e) => {
      console.error(e);
      setErr("Failed to open ONLYOFFICE editor.");
    });
  }, [docId]);

  return (
    <div style={{ height: "100vh" }}>
      {err ? <div style={{ padding: 16, color: "crimson" }}>{err}</div> : null}
      <div id="onlyoffice-editor" ref={holderRef} style={{ height: "100%", width: "100%" }} />
    </div>
  );
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.body.appendChild(s);
  });
}
