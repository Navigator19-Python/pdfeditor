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

// Tables
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";

// Font family + styles
import TextStyle from "@tiptap/extension-text-style";
import FontFamily from "@tiptap/extension-font-family";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL;

// ---------- Custom: PageBreak node ----------
import { Node, mergeAttributes } from "@tiptap/core";
const PageBreak = Node.create({
  name: "pageBreak",
  group: "block",
  atom: true,
  selectable: true,
  parseHTML() {
    return [{ tag: "div[data-page-break]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-page-break": "true",
        style:
          "page-break-after: always; break-after: page; height: 0; border-top: 2px dashed #cbd5e1; margin: 18px 0;"
      }),
      ""
    ];
  }
});

// ---------- Custom: line height + font size via TextStyle ----------
function setStyle(editor, styleObj) {
  // Apply inline CSS styles using textStyle mark
  editor
    ?.chain()
    .focus()
    .setMark("textStyle", styleObj)
    .run();
}

const FONT_FAMILIES = [
  "Arial",
  "Times New Roman",
  "Calibri",
  "Georgia",
  "Verdana",
  "Courier New"
];

const FONT_SIZES = ["10pt", "11pt", "12pt", "14pt", "16pt", "18pt", "24pt", "32pt"];

const LINE_HEIGHTS = ["1.0", "1.15", "1.3", "1.5", "1.8", "2.0"];

export default function DocPage() {
  const { id } = useParams();
  const router = useRouter();

  const [user, setUser] = useState(undefined);
  const [title, setTitle] = useState("Untitled");
  const [importMeta, setImportMeta] = useState(null);
  const [loadedBodyHtml, setLoadedBodyHtml] = useState("");
  const [status, setStatus] = useState("Loading…");

  // “Ruler” margins in mm (simple)
  const [margins, setMargins] = useState({ left: 18, right: 18, top: 18, bottom: 18 });

  // Zoom
  const [zoom, setZoom] = useState(1);

  // Header/Footer content (simple text for MVP)
  const [headerText, setHeaderText] = useState("");
  const [footerText, setFooterText] = useState("");

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
      setHeaderText(data.headerText || "");
      setFooterText(data.footerText || "");
      setMargins(data.margins || { left: 18, right: 18, top: 18, bottom: 18 });

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
        Image.configure({ inline: false }),

        TextStyle,
        FontFamily,

        Table.configure({
          resizable: true
        }),
        TableRow,
        TableHeader,
        TableCell,

        PageBreak
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

        const fullHtml = wrapAsFullHtml(bodyHtml, { headerText, footerText, margins });

        await updateDoc(doc(db, "docs", id), {
          title,
          html: fullHtml,
          headerText,
          footerText,
          margins,
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
    const html = wrapAsExportHtml(editor.getHTML(), { headerText, footerText, margins });

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
    const html = wrapAsExportHtml(editor.getHTML(), { headerText, footerText, margins });

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

  function insertTable() {
    editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  }
  function addRowAfter() {
    editor?.chain().focus().addRowAfter().run();
  }
  function addColAfter() {
    editor?.chain().focus().addColumnAfter().run();
  }
  function delTable() {
    editor?.chain().focus().deleteTable().run();
  }

  function indent() {
    // simple indentation: apply left margin on paragraph via TextAlign is not indent,
    // so we use a CSS style on textStyle around selection as best-effort:
    setStyle(editor, { style: "margin-left: 24px;" });
  }
  function outdent() {
    setStyle(editor, { style: "margin-left: 0px;" });
  }

  function insertPageBreak() {
    editor?.chain().focus().insertContent({ type: "pageBreak" }).run();
  }

  if (user === undefined) return <div style={{ padding: 24 }}>Loading…</div>;

  return (
    <div style={styles.app}>
      {/* Top bar */}
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
          <select style={styles.select} value={zoom} onChange={(e) => setZoom(parseFloat(e.target.value))}>
            {[0.5, 0.75, 1, 1.25, 1.5].map((z) => (
              <option key={z} value={z}>{Math.round(z * 100)}%</option>
            ))}
          </select>
          <button style={styles.primaryBtn} onClick={exportPdf}>Export PDF</button>
          <button style={styles.secondaryBtn} onClick={exportDocx}>Export DOCX</button>
        </div>
      </header>

      {/* “Ribbon-like” toolbar */}
      <div style={styles.toolbar}>
        <GroupTitle title="Font" />
        <select
          style={styles.select}
          onChange={(e) => editor?.chain().focus().setFontFamily(e.target.value).run()}
          defaultValue=""
        >
          <option value="" disabled>Font</option>
          {FONT_FAMILIES.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>

        <select
          style={styles.select}
          onChange={(e) => setStyle(editor, { style: `font-size: ${e.target.value};` })}
          defaultValue=""
        >
          <option value="" disabled>Size</option>
          {FONT_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>

        <select
          style={styles.select}
          onChange={(e) => setStyle(editor, { style: `line-height: ${e.target.value};` })}
          defaultValue=""
        >
          <option value="" disabled>Line</option>
          {LINE_HEIGHTS.map((lh) => <option key={lh} value={lh}>{lh}</option>)}
        </select>

        <Divider />

        <GroupTitle title="Format" />
        <ToolBtn active={editor?.isActive("bold")} onClick={() => editor?.chain().focus().toggleBold().run()}>B</ToolBtn>
        <ToolBtn active={editor?.isActive("italic")} onClick={() => editor?.chain().focus().toggleItalic().run()}>I</ToolBtn>
        <ToolBtn active={editor?.isActive("underline")} onClick={() => editor?.chain().focus().toggleUnderline().run()}>U</ToolBtn>

        <select style={styles.select} value={headingValue(editor)} onChange={(e) => applyHeading(editor, e.target.value)}>
          <option value="p">Normal</option>
          <option value="h1">Heading 1</option>
          <option value="h2">Heading 2</option>
          <option value="h3">Heading 3</option>
        </select>

        <ToolBtn onClick={() => editor?.chain().focus().setTextAlign("left").run()}>Left</ToolBtn>
        <ToolBtn onClick={() => editor?.chain().focus().setTextAlign("center").run()}>Center</ToolBtn>
        <ToolBtn onClick={() => editor?.chain().focus().setTextAlign("right").run()}>Right</ToolBtn>

        <Divider />

        <GroupTitle title="Indent" />
        <ToolBtn onClick={indent}>Indent</ToolBtn>
        <ToolBtn onClick={outdent}>Outdent</ToolBtn>

        <Divider />

        <GroupTitle title="Tables" />
        <ToolBtn onClick={insertTable}>Insert</ToolBtn>
        <ToolBtn onClick={addRowAfter}>+Row</ToolBtn>
        <ToolBtn onClick={addColAfter}>+Col</ToolBtn>
        <ToolBtn onClick={delTable}>Delete</ToolBtn>

        <Divider />

        <GroupTitle title="Pages" />
        <ToolBtn onClick={insertPageBreak}>Page Break</ToolBtn>

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

      {/* Ruler (simple margins) */}
      <Ruler margins={margins} setMargins={setMargins} onChange={() => editor && scheduleSave(editor.getHTML())} />

      {/* Header/Footer quick edit */}
      <div style={styles.hfRow}>
        <input
          style={styles.hfInput}
          value={headerText}
          onChange={(e) => setHeaderText(e.target.value)}
          onBlur={() => editor && scheduleSave(editor.getHTML())}
          placeholder="Header (shown on export)"
        />
        <input
          style={styles.hfInput}
          value={footerText}
          onChange={(e) => setFooterText(e.target.value)}
          onBlur={() => editor && scheduleSave(editor.getHTML())}
          placeholder="Footer (shown on export)"
        />
      </div>

      {/* Canvas */}
      <main style={styles.canvas}>
        <div style={{ ...styles.paperWrap, transform: `scale(${zoom})` }}>
          <div
            style={{
              ...styles.paper,
              paddingLeft: `${margins.left}mm`,
              paddingRight: `${margins.right}mm`,
              paddingTop: `${margins.top}mm`,
              paddingBottom: `${margins.bottom}mm`
            }}
          >
            <EditorContent editor={editor} />
          </div>
        </div>
      </main>
    </div>
  );
}

function GroupTitle({ title }) {
  return <span style={{ fontSize: 12, color: "#6b7280", fontWeight: 700 }}>{title}</span>;
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

function Ruler({ margins, setMargins, onChange }) {
  // A simple “ruler” bar with draggable left/right margin markers
  // UI: 0..210mm (A4 width). We map to percentage.
  const widthMm = 210;
  const [drag, setDrag] = useState(null);

  function mmToPct(mm) {
    return Math.max(0, Math.min(100, (mm / widthMm) * 100));
  }
  function pctToMm(pct) {
    return Math.max(0, Math.min(widthMm, (pct / 100) * widthMm));
  }

  function onMouseDown(which) {
    setDrag(which);
  }
  function onMouseUp() {
    if (!drag) return;
    setDrag(null);
    onChange?.();
  }
  function onMouseMove(e) {
    if (!drag) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;

    if (drag === "left") {
      const newLeft = Math.min(pctToMm(pct), widthMm - margins.right - 10);
      setMargins((m) => ({ ...m, left: Math.round(newLeft) }));
    } else if (drag === "right") {
      const rightFromEndPct = 100 - pct;
      const newRight = Math.min(pctToMm(rightFromEndPct), widthMm - margins.left - 10);
      setMargins((m) => ({ ...m, right: Math.round(newRight) }));
    }
  }

  return (
    <div
      style={styles.ruler}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
    >
      <div style={styles.rulerTrack} />

      <div
        style={{ ...styles.rulerMarker, left: `calc(${mmToPct(margins.left)}% - 8px)` }}
        onMouseDown={() => onMouseDown("left")}
        title={`Left margin: ${margins.left}mm`}
      />

      <div
        style={{ ...styles.rulerMarker, left: `calc(${100 - mmToPct(margins.right)}% - 8px)` }}
        onMouseDown={() => onMouseDown("right")}
        title={`Right margin: ${margins.right}mm`}
      />

      <div style={styles.rulerLabel}>
        Margins: L {margins.left}mm • R {margins.right}mm • T {margins.top}mm • B {margins.bottom}mm
      </div>
    </div>
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

function wrapAsFullHtml(bodyHtml, { headerText, footerText, margins }) {
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
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  th, td { border: 1px solid #d1d5db; padding: 8px; vertical-align: top; }
  th { background: #f3f4f6; }
</style>
</head>
<body data-header="${escapeAttr(headerText)}" data-footer="${escapeAttr(footerText)}"
      data-margins="${escapeAttr(JSON.stringify(margins))}">
  ${bodyHtml}
</body>
</html>
`.trim();
}

function wrapAsExportHtml(bodyHtml, { headerText, footerText, margins }) {
  return `
<!doctype html>
<html>
<head><meta charset="utf-8"/>
<style>
  body { font-family: Arial, sans-serif; }
  .page {
    width: 210mm;
    min-height: 297mm;
    box-sizing: border-box;
    padding: ${margins.top}mm ${margins.right}mm ${margins.bottom}mm ${margins.left}mm;
  }
  header { position: running(pageHeader); font-size: 10pt; color: #555; margin-bottom: 6mm; }
  footer { position: running(pageFooter); font-size: 10pt; color: #555; margin-top: 6mm; }

  /* Playwright PDF supports some paged media features; keep it simple */
  p { line-height: 1.6; font-size: 12pt; margin: 0 0 10px; }
  h1 { font-size: 22pt; margin: 14px 0 10px; }
  h2 { font-size: 16pt; margin: 14px 0 10px; }
  h3 { font-size: 13pt; margin: 14px 0 10px; }
  img { max-width: 100%; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  th, td { border: 1px solid #111; padding: 8px; vertical-align: top; }
  th { background: #eee; }

  div[data-page-break] { page-break-after: always; break-after: page; border-top: 2px dashed #94a3b8; margin: 18px 0; }
</style>
</head>
<body>
  <div class="page">
    ${headerText ? `<header>${escapeHtml(headerText)}</header>` : ""}
    ${bodyHtml}
    ${footerText ? `<footer>${escapeHtml(footerText)}</footer>` : ""}
  </div>
</body>
</html>
`.trim();
}

function escapeAttr(s) {
  return (s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
function escapeHtml(s) {
  return (s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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
    fontWeight: 700,
    display: "inline-flex",
    alignItems: "center",
    gap: 8
  },

  ruler: {
    position: "sticky",
    top: 116,
    zIndex: 8,
    background: "white",
    borderBottom: "1px solid #e5e7eb",
    padding: "10px 14px"
  },
  rulerTrack: {
    height: 10,
    borderRadius: 999,
    background: "#eef2ff"
  },
  rulerMarker: {
    position: "relative",
    top: -16,
    width: 16,
    height: 16,
    borderRadius: 6,
    background: "#111",
    cursor: "ew-resize"
  },
  rulerLabel: { fontSize: 12, color: "#6b7280", marginTop: 6 },

  hfRow: {
    display: "flex",
    gap: 10,
    padding: "10px 14px",
    borderBottom: "1px solid #e5e7eb",
    background: "white"
  },
  hfInput: {
    flex: 1,
    padding: 10,
    borderRadius: 12,
    border: "1px solid #d1d5db"
  },

  canvas: {
    display: "grid",
    placeItems: "start center",
    padding: "22px 14px 60px"
  },

  paperWrap: { transformOrigin: "top center" },

  paper: {
    width: "min(900px, calc(100vw - 28px))",
    minHeight: 1050,
    background: "white",
    border: "1px solid #e5e7eb",
    borderRadius: 14,
    boxShadow: "0 14px 40px rgba(0,0,0,0.08)"
  }
};
