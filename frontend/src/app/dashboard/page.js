"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { watchAuth } from "../../lib/auth";
import { auth, db, storage } from "../../lib/firebase";
import { signOut } from "firebase/auth";
import { addDoc, collection, serverTimestamp, getDocs, query, where, orderBy } from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";

export default function Dashboard() {
  const router = useRouter();
  const [user, setUser] = useState(undefined);
  const [docs, setDocs] = useState([]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

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
      const q = query(
        collection(db, "docs"),
        where("ownerUid", "==", user.uid),
        orderBy("updatedAt", "desc")
      );
      const snap = await getDocs(q);
      setDocs(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    })().catch(console.error);
  }, [user]);

  async function createBlankDocx() {
    // ONLYOFFICE works best with DOCX. We create a blank doc placeholder.
    setBusy(true);
    setMsg("");
    try {
      const docRef = await addDoc(collection(db, "docs"), {
        ownerUid: user.uid,
        title: "Untitled",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        onlyoffice: { docxUrl: null, docxPath: null }
      });

      // We will upload a tiny blank docx file from backend later (better),
      // but for now, require upload before opening.
      router.push(`/onlyoffice/${docRef.id}`);
    } catch (e) {
      console.error(e);
      setMsg("Failed to create document.");
    } finally {
      setBusy(false);
    }
  }

  async function uploadDocxAndOpen(file) {
    setBusy(true);
    setMsg("");
    try {
      if (!file.name.toLowerCase().endsWith(".docx")) {
        setMsg("Please upload a .docx file (ONLYOFFICE edits DOCX best).");
        setBusy(false);
        return;
      }

      // 1) Create doc record
      const docRef = await addDoc(collection(db, "docs"), {
        ownerUid: user.uid,
        title: file.name.replace(/\.docx$/i, ""),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });

      const docId = docRef.id;

      // 2) Upload to Storage at fixed path (so callback can overwrite same file)
      const objectPath = `onlyoffice/${docId}/latest.docx`;
      const fileRef = ref(storage, objectPath);

      await uploadBytes(fileRef, file, {
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      });

      const url = await getDownloadURL(fileRef);

      // 3) Save URL in Firestore
      // (Importantly: we store a URL for ONLYOFFICE to fetch)
      await (await import("firebase/firestore")).updateDoc(
        (await import("firebase/firestore")).doc(db, "docs", docId),
        {
          onlyoffice: { docxUrl: url, docxPath: objectPath },
          updatedAt: serverTimestamp()
        }
      );

      // 4) Open ONLYOFFICE editor
      router.push(`/onlyoffice/${docId}`);
    } catch (e) {
      console.error(e);
      setMsg("Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  if (user === undefined) return <div style={{ padding: 24 }}>Loading...</div>;

  return (
    <div style={{ padding: 24, maxWidth: 980, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>ONLYOFFICE Documents</h2>
        <button onClick={() => signOut(auth)} style={btnGhost}>Logout</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
        <button disabled={busy} onClick={createBlankDocx} style={btnSecondary}>
          + New (upload DOCX after)
        </button>

        <label style={btnPrimary}>
          {busy ? "Working..." : "Upload DOCX → Open"}
          <input
            type="file"
            accept=".docx"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadDocxAndOpen(f);
              e.target.value = "";
            }}
          />
        </label>
      </div>

      {msg ? <div style={notice}>{msg}</div> : null}

      <div style={{ marginTop: 18, display: "grid", gap: 12 }}>
        {docs.map((d) => (
          <div key={d.id} style={card} onClick={() => router.push(`/onlyoffice/${d.id}`)}>
            <div style={{ fontWeight: 700 }}>{d.title || "Untitled"}</div>
            <div style={{ color: "#666", fontSize: 13 }}>
              {d.onlyoffice?.docxUrl ? "DOCX ready" : "Needs DOCX upload"}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const btnPrimary = { padding: "10px 14px", borderRadius: 12, border: "none", background: "black", color: "white", cursor: "pointer" };
const btnSecondary = { padding: "10px 14px", borderRadius: 12, border: "1px solid #111", background: "white", cursor: "pointer" };
const btnGhost = { padding: "8px 10px", borderRadius: 10, border: "1px solid #ddd", background: "white", cursor: "pointer" };
const notice = { marginTop: 14, background: "#fff3cd", border: "1px solid #ffeeba", padding: 12, borderRadius: 12, color: "#6b4e00" };
const card = { background: "white", padding: 14, borderRadius: 14, border: "1px solid #e5e7eb", cursor: "pointer" };
