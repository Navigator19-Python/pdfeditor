"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { watchAuth } from "../../lib/auth";
import { auth, db, storage } from "../../lib/firebase";
import { signOut } from "firebase/auth";
import {
  addDoc,
  collection,
  doc as docRef,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where
} from "firebase/firestore";
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

  async function refresh(u) {
    const q = query(
      collection(db, "docs"),
      where("ownerUid", "==", u.uid),
      orderBy("updatedAt", "desc")
    );
    const snap = await getDocs(q);
    setDocs(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }

  useEffect(() => {
    if (!user) return;
    refresh(user).catch(console.error);
  }, [user]);

  async function createBlank() {
    setBusy(true);
    setMsg("");
    try {
      const d = await addDoc(collection(db, "docs"), {
        ownerUid: user.uid,
        title: "Untitled",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });

      const r = await fetch(`${BACKEND}/onlyoffice/create-blank`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docId: d.id, title: "Untitled" })
      });

      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data?.error || "create-blank failed");

      await updateDoc(docRef(db, "docs", d.id), {
        onlyoffice: { docxPath: data.docxPath, docxUrl: data.docxUrl },
        updatedAt: serverTimestamp()
      });

      router.push(`/onlyoffice/${d.id}`);
    } catch (e) {
      console.error(e);
      setMsg("Failed to create blank document (check backend env & logs).");
    } finally {
      setBusy(false);
    }
  }

  async function uploadFileAndOpen(file) {
    setBusy(true);
    setMsg("");
    try {
      const name = file.name.toLowerCase();
      const isPdf = name.endsWith(".pdf");
      const isDocx = name.endsWith(".docx");

      if (!isPdf && !isDocx) {
        setMsg("Upload a PDF or DOCX.");
        return;
      }

      // 1) Create Firestore doc
      const docSnap = await addDoc(collection(db, "docs"), {
        ownerUid: user.uid,
        title: file.name.replace(/\.(pdf|docx)$/i, ""),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });

      const docId = docSnap.id;

      // 2) Upload file
      const objectPath = isPdf
        ? `uploads/${docId}/source.pdf`
        : `onlyoffice/${docId}/latest.docx`;

      const fileRef = ref(storage, objectPath);

      await uploadBytes(fileRef, file, {
        contentType: isPdf
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      });

      const url = await getDownloadURL(fileRef);

      // If DOCX: save and open
      if (isDocx) {
        await updateDoc(docRef(db, "docs", docId), {
          onlyoffice: { docxPath: objectPath, docxUrl: url },
          updatedAt: serverTimestamp()
        });
        router.push(`/onlyoffice/${docId}`);
        return;
      }

      // If PDF: convert to DOCX using backend + ONLYOFFICE conversion API
      setMsg("Converting PDF to DOCX… (text PDFs work best)");
      const r = await fetch(`${BACKEND}/onlyoffice/convert/pdf-to-docx`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docId, pdfUrl: url, title: file.name })
      });

      const data = await r.json();
      if (!r.ok || !data.ok) {
        setMsg(data?.error || "PDF conversion failed.");
        return;
      }

      router.push(`/onlyoffice/${docId}`);
    } catch (e) {
      console.error(e);
      setMsg("Upload/convert failed.");
    } finally {
      setBusy(false);
      if (user) refresh(user).catch(() => {});
    }
  }

  if (user === undefined) return <div style={{ padding: 24 }}>Loading…</div>;

  return (
    <div style={{ padding: 24, maxWidth: 980, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>ONLYOFFICE Documents</h2>
        <button onClick={() => signOut(auth)} style={btnGhost}>Logout</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
        <button disabled={busy} onClick={createBlank} style={btnSecondary}>
          {busy ? "Working…" : "+ New Blank DOCX"}
        </button>

        <label style={btnPrimary}>
          {busy ? "Working…" : "Upload PDF/DOCX → Open"}
          <input
            type="file"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadFileAndOpen(f);
              e.target.value = "";
            }}
          />
        </label>
      </div>

      {msg ? <div style={notice}>{msg}</div> : null}

      <div style={{ marginTop: 18, display: "grid", gap: 12 }}>
        {docs.map((d) => (
          <div
            key={d.id}
            style={card}
            onClick={() => router.push(`/onlyoffice/${d.id}`)}
          >
            <div style={{ fontWeight: 800 }}>{d.title || "Untitled"}</div>
            <div style={{ color: "#666", fontSize: 13 }}>
              {d.onlyoffice?.docxUrl ? "Ready to edit" : "Waiting for DOCX"}
            </div>
          </div>
        ))}
        {!docs.length ? <div style={{ color: "#666" }}>No documents yet.</div> : null}
      </div>
    </div>
  );
}

const btnPrimary = { padding: "10px 14px", borderRadius: 12, border: "none", background: "black", color: "white", cursor: "pointer" };
const btnSecondary = { padding: "10px 14px", borderRadius: 12, border: "1px solid #111", background: "white", cursor: "pointer" };
const btnGhost = { padding: "8px 10px", borderRadius: 10, border: "1px solid #ddd", background: "white", cursor: "pointer" };
const notice = { marginTop: 14, background: "#fff3cd", border: "1px solid #ffeeba", padding: 12, borderRadius: 12, color: "#6b4e00" };
const card = { background: "white", padding: 14, borderRadius: 14, border: "1px solid #e5e7eb", cursor: "pointer" };
