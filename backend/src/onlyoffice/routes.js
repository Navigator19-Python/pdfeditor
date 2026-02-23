// backend/src/onlyoffice/routes.js
// JWT OFF + VERSIONED KEY (fixes "no rights") + fast callback response

import express from "express";
import fetch from "node-fetch";
import { getFirebaseAdmin } from "./firebaseAdmin.js";
import { Document, Packer, Paragraph, TextRun } from "docx";

export const onlyofficeRouter = express.Router();

/**
 * Helper: get doc record (and version) from Firestore
 */
async function getDocRecord(admin, docId) {
  const ref = admin.firestore().collection("docs").doc(docId);
  const snap = await ref.get();
  if (!snap.exists) return { ref, data: null };
  return { ref, data: snap.data() };
}

/**
 * POST /onlyoffice/config
 * Body: { docId, fileUrl?, fileType?, title?, user? }
 *
 * We DO NOT trust the frontend for version.
 * We read version from Firestore and build a stable key:
 *   key = `${docId}:v${version}`
 */
onlyofficeRouter.post("/config", async (req, res) => {
  try {
    const { docId, user } = req.body || {};
    if (!docId) return res.status(400).json({ error: "docId required" });

    const admin = getFirebaseAdmin();
    const { data } = await getDocRecord(admin, docId);
    if (!data) return res.status(404).json({ error: "Document not found" });

    const fileUrl = data?.onlyoffice?.docxUrl;
    if (!fileUrl) return res.status(400).json({ error: "No docxUrl for this docId yet" });

    const fileType = "docx";
    const title = data?.title || "Document";

    // ✅ This is the core fix:
    // version must change when the file changes
    const version = Number(data?.onlyoffice?.version || 1);
    const key = `${docId}:v${version}`;

    const callbackUrl = `${process.env.PUBLIC_BASE_URL}/onlyoffice/callback`;

    const config = {
      documentType: "text",
      document: {
        fileType,
        key,
        title,
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
 * Creates onlyoffice/{docId}/latest.docx and sets version=1
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
      expires: Date.now() + 1000 * 60 * 60 * 24 * 7
    });

    await admin.firestore().collection("docs").doc(docId).set(
      {
        title: title || "Untitled",
        onlyoffice: {
          docxPath: objectPath,
          docxUrl: signedUrl,
          version: 1,
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
 * Converts PDF -> DOCX. Sets version=1 (new file).
 *
 * IMPORTANT: Render should call EC2 directly:
 *   ONLYOFFICE_URL=http://EC2_PUBLIC_IP:8080
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

    const payload = {
      async: true,
      url: pdfUrl,
      filetype: "pdf",
      outputtype: "docx",
      key: `${docId}-pdf2docx-${Date.now()}`,
      title: title || "source.pdf"
    };

    const converterUrl = `${String(onlyofficeUrl).trim().replace(/\/+$/, "")}/converter`;

    let result = null;
    for (let i = 0; i < 40; i++) {
      const r = await fetch(converterUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload)
      });

      const data = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(500).json({ ok: false, error: `Converter HTTP ${r.status}`, details: data });
      if (data?.error) return res.status(500).json({ ok: false, error: `Conversion error code: ${data.error}`, details: data });

      if (data?.endConvert) {
        result = data;
        break;
      }
      await sleep(1500);
    }

    if (!result?.fileUrl) return res.status(504).json({ ok: false, error: "Conversion timeout" });

    const docxResp = await fetch(result.fileUrl);
    if (!docxResp.ok) {
      return res.status(500).json({ ok: false, error: `Failed to download DOCX (HTTP ${docxResp.status})` });
    }
    const buf = Buffer.from(await docxResp.arrayBuffer());

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
        title: title || "Document",
        onlyoffice: {
          docxPath: objectPath,
          docxUrl: signedUrl,
          sourcePdfUrl: pdfUrl,
          version: 1,
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
 * ✅ Respond immediately (avoid timeouts)
 * ✅ Save DOCX
 * ✅ Increment version (so next open uses a NEW key)
 */
onlyofficeRouter.post("/callback", async (req, res) => {
  // Always respond fast so ONLYOFFICE doesn't block the editor
  res.json({ error: 0 });

  try {
    const body = req.body || {};
    const status = body.status;

    // Save only for these statuses
    if (status !== 2 && status !== 6) return;

    const downloadUrl = body.url;
    const key = body.key; // `${docId}:v${version}`
    if (!downloadUrl || !key) return;

    const docId = String(key).split(":v")[0];

    const r = await fetch(downloadUrl);
    if (!r.ok) {
      console.error("Callback download failed:", r.status);
      return;
    }
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

    // ✅ increment version so key changes next time
    await admin.firestore().collection("docs").doc(docId).set(
      {
        onlyoffice: {
          docxPath: objectPath,
          docxUrl: signedUrl,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          version: admin.firestore.FieldValue.increment(1)
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  } catch (e) {
    console.error("callback save error:", e);
  }
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
