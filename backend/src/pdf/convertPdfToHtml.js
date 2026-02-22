import fetch from "node-fetch";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

export async function convertPdfToHtml({ pdfUrl, title }) {
  const pdfBuffer = await download(pdfUrl);

  const loadingTask = pdfjsLib.getDocument({ data: pdfBuffer });
  const pdf = await loadingTask.promise;

  let totalText = "";
  let pagesHtml = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const strings = textContent.items.map((it) => it.str).filter(Boolean);

    // Build a simple paragraph-ish structure:
    const pageText = strings.join(" ").replace(/\s+/g, " ").trim();

    totalText += pageText + "\n";

    // Wrap each page in a section so user can see page boundaries (Docs-like).
    pagesHtml.push(`
      <section class="page">
        <p>${escapeHtml(pageText || "")}</p>
      </section>
    `);
  }

  // Detect “scanned/image-based PDF” roughly:
  // If very little text extracted compared to pages, warn.
  const avgCharsPerPage = totalText.length / Math.max(pdf.numPages, 1);
  const isProbablyScanned = avgCharsPerPage < 30;

  const html = wrapAsDocumentHtml({
    title,
    body: pagesHtml.join("\n"),
    warning: isProbablyScanned
      ? "This PDF looks like a scanned/image-only file. Text may not be editable without OCR."
      : null
  });

  return {
    title,
    html,
    meta: {
      pages: pdf.numPages,
      avgCharsPerPage,
      isProbablyScanned
    }
  };
}

async function download(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to fetch PDF: ${r.status}`);
  const arr = await r.arrayBuffer();
  return new Uint8Array(arr);
}

function wrapAsDocumentHtml({ title, body, warning }) {
  return `
<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: Arial, sans-serif; margin: 0; padding: 0; }
  .container { max-width: 850px; margin: 24px auto; padding: 0 16px; }
  .warn { background: #fff3cd; border: 1px solid #ffeeba; padding: 12px; border-radius: 8px; margin-bottom: 16px; }
  .page {
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    padding: 32px;
    margin: 18px 0;
    min-height: 980px; /* A4-ish feel */
    box-shadow: 0 6px 20px rgba(0,0,0,0.06);
  }
  p { line-height: 1.6; font-size: 14px; }
</style>
</head>
<body>
  <div class="container">
    ${warning ? `<div class="warn">${escapeHtml(warning)}</div>` : ""}
    ${body}
  </div>
</body>
</html>
  `.trim();
}

function escapeHtml(s) {
  return (s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
