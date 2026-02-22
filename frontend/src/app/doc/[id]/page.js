"use client";

import { useEffect, useRef, useState } from "react";
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
  const [loadedBodyHtml, setLoadedBodyHtml] = useState("");
  const [status, setStatus] = useState("Loading…");
  const [zoom, setZoom] = useState(1);

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
      if (!snap.exists()) return router.push("/dashboard");

      const data = snap.data();
      if (data.ownerUid !== user.uid) return router.push("/dashboard");

      setTitle(data.title || "Untitled");
      setImportMeta(data.importMeta || null);
      setLoadedBodyHtml(extractBodyHtml(data.html || ""));
      setStatus("Ready");
    })().catch((e) => {
      console.error(e);
      setStatus("Failed to load");
    });
  }, [user, id, router]);

  const editor = useEditor(
    {
      extensions: [
        StarterKit,
        Underline,
        Link.configure({ openOnClick: false }),
        TextAlign.configure({ types: ["heading", "paragraph"] }),
        Image.configure({ inline: false })
      ],
      content: loadedBodyHtml || "<p>Loading…</p>",
      onUpdate: ({ editor }) => {
        setStatus("Saving…");
        scheduleSave(editor.getHTML());
      }
    },
    [loadedBodyHtml]
  );

  function scheduleSave(bodyHtml) {
    if (!user) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);

    saveTimer.current = setTimeout(async () => {
      try {
        if (lastSaved.current === bodyHtml) {
          setStatus("Saved");
          return;
        }
        lastSaved.current = bodyHtml;

        const fullHtml = wrapAsFullHtml(bodyHtml);

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
    }, 700);
  }

  async function uploadImageAndInsert(file) {
    if (!user || !editor) return;
    setStatus("Uploading image…");
    const path = `images/${user.uid}/${Date.now()}_${file.name}`;
    const fileRef = ref(storage, path);
    await uploadBytes(fileRef, file);
    const url = await getDownloadURL(fileRef);
    editor.chain().focus().setImage({ src: url }).run();
    setStatus("Saved");
  }

  async function exportPdf() {
    if (!editor) return;
    setStatus("Exporting PDF…");
    const html = wrapAsExportHtml(editor.getHTML());

    const r = await fetch(`${BACKEND}/export/pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, html })
    });

    if (!r.ok) {
      setStatus("PDF export failed");
      return;
    }
    const blob = await r.blob();
    downloadBlob(blob, `${safeFileName(title)}.pdf`);
    setStatus("Saved");
  }

  async function exportDocx() {
    if (!editor) return;
    setStatus("Exporting DOCX…");
    const html = wrapAsExportHtml(editor.getHTML());

    const r = await fetch(`${BACKEND}/export/docx`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, html })
    });

    if (!r.ok) {
      setStatus("DOCX export failed");
      return;
    }
    const blob = await r.blob();
    downloadBlob(blob, `${safeFileName(title)}.docx`);
    setStatus("Saved");
  }

  if (user === undefined) return <div style={{ padding: 24 }}>Loading…</div>;

  return (
    <div style={styles.app}>
      {/* Top app bar (Docs-like) */}
      <header style={styles.topBar}>
        <div style={styles.leftTop}>
          <button style={styles.iconBtn} onClick={() => router.push("/dashboard")} title="Back">
            ←
          </button>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => editor && scheduleSave(editor.getHTML())}
              style={styles.titleInput}
            />
            <div style={styles.subText}>
              {importMeta?.isProbablyScanned ? "⚠️ Imported (scanned?)" : "Document"} • {status}
            </div>
          </div>
        </div>

        <div style={styles.rightTop}>
          <ZoomControl zoom={zoom} setZoom={setZoom} />
          <button style={styles.primaryBtn} onClick={exportPdf}>Export PDF</button>
          <button style={styles.secondaryBtn} onClick={exportDocx}>Export DOCX</button>
        </div>
      </header>

      {/* Toolbar (Docs-like) */}
      <div style={styles.toolbar}>
        <ToolBtn active={editor?.isActive("bold")} onClick={() => editor?.chain().focus().toggleBold().run()}>B</ToolBtn>
        <ToolBtn active={editor?.isActive("italic")} onClick={() => editor?.chain().focus().toggleItalic().run()}>I</ToolBtn>
        <ToolBtn active={editor?.isActive("underline")} onClick={() => editor?.chain().focus().toggleUnderline().run()}>U</ToolBtn>

        <Divider />

        <select
          style={styles.select}
          value={headingValue(editor)}
          onChange={(e) => applyHeading(editor, e.target.value)}
        >
          <option value="p">Normal</option>
          <option value="h1">Heading 1</option>
          <option value="h2">Heading 2</option>
          <option value="h3">Heading 3</option>
        </select>

        <Divider />

        <ToolBtn onClick={() => editor?.chain().focus().setTextAlign("left").run()}>Left</ToolBtn>
        <ToolBtn onClick={() => editor?.chain().focus().setTextAlign("center").run()}>Center</ToolBtn>
        <ToolBtn onClick={() => editor?.chain().focus().setTextAlign("right").run()}>Right</ToolBtn>

        <Divider />

        <ToolBtn active={editor?.isActive("bulletList")} onClick={() => editor?.chain().focus().toggleBulletList().run()}>
          • List
        </ToolBtn>
        <ToolBtn active={editor?.isActive("orderedList")} onClick={() => editor?.chain().focus().toggleOrderedList().run()}>
          1. List
        </ToolBtn>

        <Divider />

        <label style={styles.secondaryBtn}>
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
      </div>

      {/* Canvas (page view) */}
      <main style={styles.canvas}>
        <div style={{ ...styles.paperWrap, transform: `scale(${zoom})` }}>
          <div style={styles.paper}>
            <EditorContent editor={editor} />
          </div>
        </div>
      </main>
    </div>
  );
}

function ToolBtn({ children, onClick, active }) {
  return (
    <button
      onClick={onClick}
      style={{
        ...styles.toolBtn,
        background: active ? "#111" : "white",
        color: active ? "white" : "#111",
        borderColor: active ? "#111" : "#d1d5db"
      }}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <div style={{ width: 1, height: 22, background: "#e5e7eb" }} />;
}

function ZoomControl({ zoom, setZoom }) {
  const options = [0.5, 0.75, 1, 1.25, 1.5];
  return (
    <select
      style={styles.select}
      value={zoom}
      onChange={(e) => setZoom(parseFloat(e.target.value))}
      title="Zoom"
    >
      {options.map((z) => (
        <option key={z} value={z}>
          {Math.round(z * 100)}%
        </option>
      ))}
    </select>
  );
}

function headingValue(editor) {
  if (!editor) return "p";
  if (editor.isActive("heading", { level: 1 })) return "h1";
  if (editor.isActive("heading", { level: 2 })) return "h2";
  if (editor.isActive("heading", { level: 3 })) return "h3";
  return "p";
}

function applyHeading(editor, v) {
  if (!editor) return;
  editor.chain().focus();
  if (v === "p") editor.setParagraph().run();
  if (v === "h1") editor.toggleHeading({ level: 1 }).run();
  if (v === "h2") editor.toggleHeading({ level: 2 }).run();
  if (v === "h3") editor.toggleHeading({ level: 3 }).run();
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
  .ProseMirror { outline: none; }
  p { line-height: 1.65; font-size: 14px; margin: 0 0 10px; }
  h1,h2,h3 { margin: 14px 0 10px; }
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
  return `
<!doctype html>
<html>
<head><meta charset="utf-8"/>
<style>
  body { font-family: Arial, sans-serif; }
  .page { width: 210mm; min-height: 297mm; padding: 18mm; box-sizing: border-box; }
  .ProseMirror { outline: none; }
  p { line-height: 1.65; font-size: 12pt; margin: 0 0 10px; }
  h1 { font-size: 22pt; }
  h2 { font-size: 16pt; }
  h3 { font-size: 13pt; }
  img { max-width: 100%; }
</style>
</head>
<body>
  <div class="page">${bodyHtml}</div>
</body>
</html>
`.trim();
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

const styles = {
  app: { minHeight: "100vh", background: "#f6f7fb" },

  topBar: {
    position: "sticky",
    top: 0,
    zIndex: 10,
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    padding: "10px 14px",
    background: "white",
    borderBottom: "1px solid #e5e7eb"
  },
  leftTop: { display: "flex", alignItems: "center", gap: 12, minWidth: 240, flex: 1 },
  rightTop: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },

  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    border: "1px solid #d1d5db",
    background: "white",
    cursor: "pointer"
  },
  titleInput: {
    fontWeight: 800,
    fontSize: 16,
    border: "1px solid transparent",
    outline: "none",
    padding: "6px 8px",
    borderRadius: 10,
    width: "min(520px, 60vw)",
    background: "#f6f7fb"
  },
  subText: { fontSize: 12, color: "#6b7280", paddingLeft: 8 },

  toolbar: {
    position: "sticky",
    top: 58,
    zIndex: 9,
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
    padding: "10px 14px",
    background: "white",
    borderBottom: "1px solid #e5e7eb"
  },

  toolBtn: {
    padding: "8px 10px",
    borderRadius: 10,
    border: "1px solid #d1d5db",
    background: "white",
    cursor: "pointer",
    fontWeight: 700,
    fontSize: 13
  },

  select: {
    padding: "8px 10px",
    borderRadius: 10,
    border: "1px solid #d1d5db",
    background: "white"
  },

  primaryBtn: {
    padding: "10px 14px",
    borderRadius: 12,
    border: "none",
    background: "black",
    color: "white",
    cursor: "pointer",
    fontWeight: 700
  },
  secondaryBtn: {
    padding: "10px 14px",
    borderRadius: 12,
    border: "1px solid #111",
    background: "white",
    cursor: "pointer",
    fontWeight: 700
  },

  canvas: {
    display: "grid",
    placeItems: "start center",
    padding: "22px 14px 60px"
  },

  paperWrap: {
    transformOrigin: "top center"
  },
  paper: {
    width: "min(900px, calc(100vw - 28px))",
    minHeight: 1050,
    background: "white",
    border: "1px solid #e5e7eb",
    borderRadius: 14,
    padding: 28,
    boxShadow: "0 14px 40px rgba(0,0,0,0.08)"
  }
};
