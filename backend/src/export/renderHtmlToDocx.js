import htmlToDocx from "html-to-docx";

export async function renderHtmlToDocx({ html }) {
  // html-to-docx expects a body snippet; but it also works with full HTML.
  const docxBuffer = await htmlToDocx(html, null, {
    table: { row: { cantSplit: true } },
    footer: false,
    pageNumber: false
  });

  return Buffer.from(docxBuffer);
}
