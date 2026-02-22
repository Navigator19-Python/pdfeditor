"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { watchAuth } from "../../../lib/auth";
import { db, storage } from "../../../lib/firebase";
import { doc, getDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import TextAlign from "@tiptap/extension-text-align";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL;

export default function DocPage() {
  const { id } = useParams();
  const router = useRouter();
  const [user, setUser] = useState(undefined);
  const [title, setTitle] = useState("Untitled");
  const [importMeta, setImportMeta] = useState(null);
  const [loadedHtml, setLoadedHtml] = useState("");
  const [status, setStatus] = useState("Loading...");
  const saveTimer = useRef(null);
  const lastSaved = useRef("");

  useEffect(() => {
    const unsub = watchAuth((u) => {
      setUser(u);
      if (!u) router.push("/login");
    });
    return () => unsub();
  }, [router]);

  useEffect(() => {
    if (!user || !id) return;

    (async () => {
      const snap = await getDoc(doc(db, "docs", id));
      if (!snap.exists()) {
        router.push("/dashboard");
        return;
      }
      const data = snap.data();
      if (data.ownerUid !== user.uid) {
        router.push("/dashboard");
        return;
      }

      setTitle(data.title || "Untitled");
      setImportMeta(data.importMeta || null);
      setLoadedHtml(extractBodyHtml(data.html || ""));
      setStatus("Ready");
    })().catch((e) => {
      console.error(e);
      setStatus("Failed to load");
    });
  }, [user, id, router]);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      Link.configure({ openOnClick: false }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Image.configure({ inline: false })
    ],
    content: loadedHtml || "<p>Loading...</p>",
    onUpdate: ({ editor }) => {
      setStatus("Editing...");
      scheduleSave(editor.getHTML());
    }
  }, [loadedHtml]);

  function scheduleSave(htmlBody) {
    if (!user) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);

    saveTimer.current = setTimeout(async () => {
      try {
        // avoid saving identical content repeatedly
        if (lastSaved.current === htmlBody) {
          setStatus("Saved");
          return;
        }
        lastSaved.current = htmlBody;

        const fullHtml = wrapAsFullHtml(htmlBody);
        await updateDoc(doc(db, "docs", id), {
          title,
          html: fullHtml,
          updatedAt: serverTimestamp()
        });
        setStatus("Saved");
      } catch (e) {
        console.error(e);
        setStatus("Save failed");
      }
    }, 600);
  }

  async function uploadImageAndInsert(file) {
    if (!user || !editor) return;
    setStatus("Uploading image...");
    const path = `images/${user.uid}/${Date.now()}_${file.name}`;
    const fileRef = ref(storage, path);
    await uploadBytes(fileRef, file);
    const url = await getDownloadURL(fileRef);
    editor.chain().focus().setImage({ src: url }).run();
    setStatus("Image added");
  }

  async function exportPdf() {
    if (!editor) return;
    setStatus("Exporting PDF...");
    const html = wrapAsExportHtml(editor.getHTML());

    const r = await fetch(`${BACKEND}/export/pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, html })
    });

    if (!r.ok) { setStatus("PDF export failed"); return; }
    const blob = await r.blob();
    downloadBlob(blob, `${safeFileName(title)}.pdf`);
    setStatus("PDF downloaded");
  }

  async function exportDocx() {
    if (!editor) return;
    setStatus("Exporting DOCX...");
    const html = wrapAsExportHtml(editor.getHTML());

    const r = await fetch(`${BACKEND}/export/docx`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, html })
    });

    if (!r.ok) { setStatus("DOCX export failed"); return; }
    const blob = await r.blob();
    downloadBlob(blob, `${safeFileName(title)}.docx`);
    setStatus("DOCX downloaded");
  }

  if (user === undefined) return <div style={{ padding: 24 }}>Loading...</div>;

  return (
    <div style={{ padding: 18, maxWidth: 1100, margin: "0 auto" }}>
      <div style={topBar}>
        <button style={btnGhost} onClick={() => router.push("/dashboard")}>← Back</button>

        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => editor && scheduleSave(editor.getHTML())}
          style={titleInput}
        />

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          <span style={{ color: "#666", fontSize: 13 }}>{status}</span>

          <label style={btnSecondary}>
            + Image
            <input
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadImageAndInsert(f).catch(console.error);
                e.target.value = "";
              }}
            />
          </label>

          <button style={btnPrimary} onClick={exportPdf}>Export PDF</button>
          <button style={btnSecondary} onClick={exportDocx}>Export DOCX</button>
        </div>
      </div>

      {importMeta?.isProbablyScanned ? (
        <div style={notice}>
          ⚠️ This looks like a scanned PDF. Text may not be fully editable without OCR.
        </div>
      ) : null}

      <Toolbar editor={editor} />

      <div style={editorWrap}>
        <div style={paper}>
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  );
}

function Toolbar({ editor }) {
  if (!editor) return null;

  const B = ({ onClick, active, children }) => (
    <button
      onClick={onClick}
      style={{
        padding: "8px 10px",
        borderRadius: 10,
        border: "1px solid #ddd",
        background: active ? "black" : "white",
        color: active ? "white" : "black",
        cursor: "pointer"
      }}
    >
      {children}
    </button>
  );

  return (
    <div style={toolbar}>
      <B onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive("bold")}>B</B>
      <B onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive("italic")}>I</B>
      <B onClick={() => editor.chain().focus().toggleUnderline().run()} active={editor.isActive("underline")}>U</B>
      <B onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive("bulletList")}>• List</B>
      <B onClick={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive("orderedList")}>1. List</B>

      <B onClick={() => editor.chain().focus().setParagraph().run()} active={editor.isActive("paragraph")}>P</B>
      <B onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} active={editor.isActive("heading", { level: 1 })}>H1</B>
      <B onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} active={editor.isActive("heading", { level: 2 })}>H2</B>

      <B onClick={() => editor.chain().focus().setTextAlign("left").run()} active={editor.isActive({ textAlign: "left" })}>Left</B>
      <B onClick={() => editor.chain().focus().setTextAlign("center").run()} active={editor.isActive({ textAlign: "center" })}>Center</B>
      <B onClick={() => editor.chain().focus().setTextAlign("right").run()} active={editor.isActive({ textAlign: "right" })}>Right</B>
    </div>
  );
}

function extractBodyHtml(fullHtml) {
  const match = fullHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return match ? match[1] : fullHtml;
}

function wrapAsFullHtml(bodyHtml) {
  return `
<!doctype html>
<html>
<head><meta charset="utf-8"/>
<style>
  body { font-family: Arial, sans-serif; }
  .page { background: white; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px; margin: 18px 0; min-height: 980px; }
  p { line-height: 1.6; font-size: 14px; }
  img { max-width: 100%; border-radius: 10px; }
</style>
</head>
<body>
  ${bodyHtml}
</body>
</html>
`.trim();
}

function wrapAsExportHtml(bodyHtml) {
  // export should keep stable paper layout
  return wrapAsFullHtml(`
    <div class="page">
      ${bodyHtml}
    </div>
  `);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function safeFileName(name) {
  return (name || "document").replace(/[^\w\-]+/g, "_").slice(0, 80) || "document";
}

const topBar = { display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" };
const titleInput = { flex: 1, minWidth: 180, padding: 10, borderRadius: 12, border: "1px solid #ddd", fontWeight: 700 };
const btnPrimary = { padding: "10px 14px", borderRadius: 12, border: "none", background: "black", color: "white", cursor: "pointer" };
const btnSecondary = { padding: "10px 14px", borderRadius: 12, border: "1px solid #111", background: "white", cursor: "pointer" };
const btnGhost = { padding: "10px 12px", borderRadius: 12, border: "1px solid #ddd", background: "white", cursor: "pointer" };

const toolbar = { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 };

const notice = { marginTop: 12, background: "#fff3cd", border: "1px solid #ffeeba", padding: 12, borderRadius: 12, color: "#6b4e00" };

const editorWrap = { marginTop: 14 };
const paper = {
  background: "white",
  borderRadius: 14,
  padding: 22,
  border: "1px solid #e5e7eb",
  boxShadow: "0 10px 30px rgba(0,0,0,0.06)"
};
