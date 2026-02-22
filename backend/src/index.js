import express from "express";
import cors from "cors";
import { z } from "zod";
import { convertPdfToHtml } from "./pdf/convertPdfToHtml.js";
import { renderHtmlToPdf } from "./export/renderHtmlToPdf.js";
import { renderHtmlToDocx } from "./export/renderHtmlToDocx.js";
import { onlyofficeRouter } from "./onlyoffice/routes.js";

const app = express();

app.use(cors({ origin: true }));
app.use(express.json({ limit: "10mb" }));

app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * Convert PDF (URL) -> HTML (best-effort).
 * Works best for text-based PDFs.
 */
app.post("/convert/pdf-to-doc", async (req, res) => {
  const Schema = z.object({
    pdfUrl: z.string().url(),
    title: z.string().optional()
  });

  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const { pdfUrl, title } = parsed.data;
    const result = await convertPdfToHtml({ pdfUrl, title: title ?? "Imported PDF" });

    return res.json({
      title: result.title,
      html: result.html,
      meta: result.meta
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Conversion failed" });
  }
});

/**
 * Export to PDF (high quality).
 */
app.post("/export/pdf", async (req, res) => {
  const Schema = z.object({
    title: z.string().optional(),
    html: z.string().min(1)
  });

  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const { html, title } = parsed.data;
    const pdfBuffer = await renderHtmlToPdf({ html, title: title ?? "document" });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFileName(title ?? "document")}.pdf"`);
    return res.send(pdfBuffer);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "PDF export failed" });
  }
});

/**
 * Export to DOCX.
 */
app.post("/export/docx", async (req, res) => {
  const Schema = z.object({
    title: z.string().optional(),
    html: z.string().min(1)
  });

  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const { html, title } = parsed.data;
    const docxBuffer = await renderHtmlToDocx({ html });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFileName(title ?? "document")}.docx"`);
    return res.send(docxBuffer);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "DOCX export failed" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Backend listening on :${PORT}`));

function safeFileName(name) {
  return name.replace(/[^\w\-]+/g, "_").slice(0, 80) || "document";
}
