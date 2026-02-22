"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { watchAuth } from "../../lib/auth";
import { auth, db, storage } from "../../lib/firebase";
import { signOut } from "firebase/auth";
import { addDoc, collection, getDocs, orderBy, query, serverTimestamp, where } from "firebase/firestore";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL;

export default function Dashboard() {
  const router = useRouter();
  const [user, setUser] = useState(undefined);
  const [docs, setDocs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    const unsub = watchAuth((u) => {
      setUser(u);
      if (!u) router.push("/login");
    });
    return () => unsub();
  }, [router]);

  async function loadDocs(u) {
    const q = query(
      collection(db, "docs"),
      where("ownerUid", "==", u.uid),
      orderBy("updatedAt", "desc")
    );
    const snap = await getDocs(q);
    setDocs(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  }

  useEffect(() => {
    if (!user) return;
    loadDocs(user).catch(console.error);
  }, [user]);

  async function newBlankDoc() {
    setBusy(true);
    setMsg("");
    try {
      const docRef = await addDoc(collection(db, "docs"), {
        ownerUid: user.uid,
        title: "Untitled",
        html: defaultHtml("Untitled"),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      router.push(`/doc/${docRef.id}`);
    } catch (e) {
      setMsg("Failed to create document.");
    } finally {
      setBusy(false);
    }
  }

  async function uploadPdfAndConvert(file) {
    setBusy(true);
    setMsg("");
    try {
      // 1) Upload PDF to Firebase Storage
      const path = `pdfs/${user.uid}/${Date.now()}_${file.name}`;
      const fileRef = ref(storage, path);
      await uploadBytes(fileRef, file, { contentType: "application/pdf" });
      const pdfUrl = await getDownloadURL(fileRef);

      // 2) Call backend to convert to HTML doc
      const r = await fetch(`${BACKEND}/convert/pdf-to-doc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pdfUrl, title: file.name.replace(/\.pdf$/i, "") })
      });

      if (!r.ok) throw new Error("convert failed");
      const data = await r.json();

      // 3) Save as new Firestore doc
      const docRef = await addDoc(collection(db, "docs"), {
        ownerUid: user.uid,
        title: data.title || "Imported PDF",
        html: data.html,
        importMeta: data.meta || null,
        sourcePdfUrl: pdfUrl,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });

      router.push(`/doc/${docRef.id}`);
    } catch (e) {
      console.error(e);
      setMsg("PDF conversion failed. Try another PDF (text-based PDFs work best).");
    } finally {
      setBusy(false);
    }
  }

  if (user === undefined) return <div style={{ padding: 24 }}>Loading...</div>;

  return (
    <div style={{ padding: 24, maxWidth: 980, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>Your Documents</h2>
        <button onClick={() => signOut(auth)} style={btnGhost}>Logout</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
        <button disabled={busy} onClick={newBlankDoc} style={btnPrimary}>+ New Document</button>

        <label style={btnSecondary}>
          {busy ? "Working..." : "Upload PDF → Convert"}
          <input
            type="file"
            accept="application/pdf"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadPdfAndConvert(f);
              e.target.value = "";
            }}
          />
        </label>
      </div>

      {msg ? <div style={notice}>{msg}</div> : null}

      <div style={{ marginTop: 18, display: "grid", gap: 12 }}>
        {docs.map((d) => (
          <div key={d.id} style={card} onClick={() => router.push(`/doc/${d.id}`)}>
            <div style={{ fontWeight: 700 }}>{d.title || "Untitled"}</div>
            <div style={{ color: "#666", fontSize: 13 }}>
              {d.importMeta?.isProbablyScanned ? "⚠️ Imported (scanned?)" : (d.sourcePdfUrl ? "Imported PDF" : "Document")}
            </div>
          </div>
        ))}
        {!docs.length ? <div style={{ color: "#666" }}>No documents yet.</div> : null}
      </div>
    </div>
  );
}

function defaultHtml(title) {
  return `
<!doctype html>
<html><head><meta charset="utf-8"/>
<style>
  body { font-family: Arial, sans-serif; }
  .page { padding: 32px; border: 1px solid #e5e7eb; border-radius: 12px; margin: 18px 0; min-height: 980px; }
</style>
</head>
<body>
  <div class="page">
    <h1>${escapeHtml(title)}</h1>
    <p>Start typing...</p>
  </div>
</body></html>
`;
}

function escapeHtml(s) {
  return (s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const btnPrimary = { padding: "10px 14px", borderRadius: 12, border: "none", background: "black", color: "white", cursor: "pointer" };
const btnSecondary = { padding: "10px 14px", borderRadius: 12, border: "1px solid #111", background: "white", cursor: "pointer" };
const btnGhost = { padding: "8px 10px", borderRadius: 10, border: "1px solid #ddd", background: "white", cursor: "pointer" };

const notice = { marginTop: 14, background: "#fff3cd", border: "1px solid #ffeeba", padding: 12, borderRadius: 12, color: "#6b4e00" };

const card = {
  background: "white",
  padding: 14,
  borderRadius: 14,
  border: "1px solid #e5e7eb",
  cursor: "pointer",
  boxShadow: "0 10px 30px rgba(0,0,0,0.04)"
};