// backend/src/onlyoffice/routes.js
// CLEAN VERSION: JWT DISABLED MODE (no signing, no verification)

import express from "express";
import fetch from "node-fetch";
import { getFirebaseAdmin } from "./firebaseAdmin.js";
import { Document, Packer, Paragraph, TextRun } from "docx";

export const onlyofficeRouter = express.Router();

/**
 * POST /onlyoffice/config
 * Returns ONLYOFFICE DocEditor config (NO JWT).
 */
onlyofficeRouter.post("/config", async (req, res) => {
  try {
    const { docId, fileUrl, fileType, title, user } = req.body || {};
    if (!docId || !fileUrl || !fileType) {
      return res.status(400).json({ error: "docId, fileUrl, fileType required" });
    }

    const callbackUrl = `${process.env.PUBLIC_BASE_URL}/onlyoffice/callback`;
    const key = `${docId}:${Date.now()}`;

    const config = {
      document: {
        fileType, // "docx"
        key,
        title: title || "Document",
        url: fileUrl,
        permissions: {
          edit: true,
          download: true,
          print: true,
          review: true,
          comment: true,
          fillForms: true,
          copy: true
        }
      },
      documentType: "text",
      editorConfig: {
        mode: "edit",
        callbackUrl,
        user: {
          id: String(user?.id || "1"),
          name: String(user?.name || "User")
        }
      }
    };

    return res.json(config);
  } catch (e) {
    console.error("config error:", e);
    return res.status(500).json({
      error: "Failed to build ONLYOFFICE config",
      details: String(e?.message || e)
    });
  }
});

/**
 * POST /onlyoffice/create-blank
 * Creates a new blank DOCX in Firebase Storage:
 * onlyoffice/{docId}/latest.docx
 */
onlyofficeRouter.post("/create-blank", async (req, res) => {
  try {
    const { docId, title } = req.body || {};
    if (!docId) return res.status(400).json({ ok: false, error: "docId required" });

    const doc = new Document({
      sections: [
        {
          properties: {},
          children: [
            new Paragraph({
              children: [new TextRun({ text: title || "Untitled", bold: true, size: 32 })]
            }),
            new Paragraph({ text: "" })
          ]
        }
      ]
    });

    const buf = await Packer.toBuffer(doc);

    const admin = getFirebaseAdmin();
    const bucket = admin.storage().bucket();

    const objectPath = `onlyoffice/${docId}/latest.docx`;
    const file = bucket.file(objectPath);

    await file.save(buf, {
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      resumable: false
    });

    const [signedUrl] = await file.getSignedUrl({
      action: "read",
      expires: Date.now() + 1000 * 60 * 60 * 24 * 7 // 7 days
    });

    await admin.firestore().collection("docs").doc(docId).set(
      {
        onlyoffice: {
          docxPath: objectPath,
          docxUrl: signedUrl,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    return res.json({ ok: true, docxPath: objectPath, docxUrl: signedUrl });
  } catch (e) {
    console.error("create-blank error:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * POST /onlyoffice/convert/pdf-to-docx
 * Converts PDF -> DOCX using ONLYOFFICE Conversion API:
 * POST {ONLYOFFICE_URL}/converter
 *
 * NOTE: Since JWT is disabled on DocumentServer, we do NOT send tokens.
 * ONLYOFFICE_URL should be reachable by your backend (Render). If EC2 is only reachable
 * via Cloudflare tunnel, set ONLYOFFICE_URL to the tunnel URL.
 */
onlyofficeRouter.post("/convert/pdf-to-docx", async (req, res) => {
  try {
    const { docId, pdfUrl, title } = req.body || {};
    if (!docId || !pdfUrl) {
      return res.status(400).json({ ok: false, error: "docId and pdfUrl required" });
    }

    const onlyofficeUrl = process.env.ONLYOFFICE_URL;
    if (!onlyofficeUrl) {
      return res.status(500).json({ ok: false, error: "Missing ONLYOFFICE_URL env var" });
    }

    const key = `${docId}-pdf2docx-${Date.now()}`;

    const payload = {
      async: true,
      url: pdfUrl,
      filetype: "pdf",
      outputtype: "docx",
      key,
      title: title || "source.pdf"
    };

    const converterUrl = `${String(onlyofficeUrl).trim().replace(/\/+$/, "")}/converter`;

    let result = null;
    for (let i = 0; i < 40; i++) {
      const r = await fetch(converterUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify(payload)
      });

      const data = await r.json().catch(() => ({}));

      if (!r.ok) {
        console.error("converter http error:", r.status, data);
        return res.status(500).json({
          ok: false,
          error: `Converter HTTP ${r.status}`,
          details: data
        });
      }

      if (data?.error) {
        return res.status(500).json({
          ok: false,
          error: `Conversion error code: ${data.error}`,
          details: data
        });
      }

      if (data?.endConvert) {
        result = data;
        break;
      }

      await sleep(1500);
    }

    if (!result?.fileUrl) {
      return res.status(504).json({ ok: false, error: "Conversion timeout (try again)" });
    }

    // Download converted DOCX
    const docxResp = await fetch(result.fileUrl);
    if (!docxResp.ok) {
      return res.status(500).json({
        ok: false,
        error: `Failed to download converted DOCX (HTTP ${docxResp.status})`
      });
    }
    const buf = Buffer.from(await docxResp.arrayBuffer());

    // Upload DOCX to Firebase Storage stable path
    const admin = getFirebaseAdmin();
    const bucket = admin.storage().bucket();

    const objectPath = `onlyoffice/${docId}/latest.docx`;
    const file = bucket.file(objectPath);

    await file.save(buf, {
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      resumable: false
    });

    const [signedUrl] = await file.getSignedUrl({
      action: "read",
      expires: Date.now() + 1000 * 60 * 60 * 24 * 7
    });

    await admin.firestore().collection("docs").doc(docId).set(
      {
        onlyoffice: {
          docxPath: objectPath,
          docxUrl: signedUrl,
          sourcePdfUrl: pdfUrl,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    return res.json({ ok: true, docxPath: objectPath, docxUrl: signedUrl });
  } catch (e) {
    console.error("pdf-to-docx error:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * POST /onlyoffice/callback
 * ONLYOFFICE calls this to save updates. (NO JWT verification.)
 */
onlyofficeRouter.post("/callback", async (req, res) => {
  try {
    const body = req.body || {};
    const status = body.status;

    // 2 = MustSave, 6 = MustForceSave
    if (status === 2 || status === 6) {
      const downloadUrl = body.url;
      const key = body.key;
      if (!downloadUrl || !key) return res.json({ error: 0 });

      const docId = String(key).split(":")[0];

      const r = await fetch(downloadUrl);
      if (!r.ok) throw new Error(`Failed to download updated file: ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());

      const admin = getFirebaseAdmin();
      const bucket = admin.storage().bucket();

      const objectPath = `onlyoffice/${docId}/latest.docx`;
      const file = bucket.file(objectPath);

      await file.save(buf, {
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        resumable: false
      });

      const [signedUrl] = await file.getSignedUrl({
        action: "read",
        expires: Date.now() + 1000 * 60 * 60 * 24 * 7
      });

      await admin.firestore().collection("docs").doc(docId).set(
        {
          onlyoffice: {
            docxPath: objectPath,
            docxUrl: signedUrl,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          },
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    }

    return res.json({ error: 0 });
  } catch (e) {
    console.error("callback error:", e);
    return res.status(500).json({ error: 1 });
  }
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
