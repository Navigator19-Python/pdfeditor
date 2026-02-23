import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import { getFirebaseAdmin } from "./firebaseAdmin.js";
import { Document, Packer, Paragraph, TextRun } from "docx";

export const onlyofficeRouter = express.Router();

/**
 * POST /onlyoffice/config
 * Returns ONLYOFFICE DocEditor config + JWT token (if enabled).
 */
onlyofficeRouter.post("/config", async (req, res) => {
  try {
    const { docId, fileUrl, fileType, title, user } = req.body || {};
    if (!docId || !fileUrl || !fileType) {
      return res.status(400).json({ error: "docId, fileUrl, fileType required" });
    }

    const callbackUrl = `${process.env.PUBLIC_BASE_URL}/onlyoffice/callback`;
    const key = `${docId}:${Date.now()}`; // must be unique per open/version

    const config = {
      document: {
        fileType, // "docx"
        key,
        title: title || "Document",
        url: fileUrl
      },
      documentType: "text",
      editorConfig: {
        callbackUrl,
        user: {
          id: user?.id || "1",
          name: user?.name || "User"
        }
      }
    };

    const secret = process.env.ONLYOFFICE_JWT_SECRET;
    if (secret) config.token = signJwt(config, secret);

    return res.json(config);
  } catch (e) {
    console.error("config error:", e);
    return res.status(500).json({ error: "Failed to build ONLYOFFICE config" });
  }
});

/**
 * POST /onlyoffice/create-blank
 * Generates a blank DOCX and uploads it to Firebase Storage:
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
      expires: Date.now() + 1000 * 60 * 60 * 24 // 24h
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
    return res.status(500).json({ ok: false, error: e?.message || "Failed to create blank DOCX" });
  }
});

/**
 * POST /onlyoffice/convert/pdf-to-docx
 * Converts a PDF (URL) -> DOCX using ONLYOFFICE Conversion API:
 * POST {ONLYOFFICE_URL}/converter
 *
 * Note: error code -7 means input error (bad request payload).
 */
onlyofficeRouter.post("/convert/pdf-to-docx", async (req, res) => {
  try {
    const { docId, pdfUrl, title } = req.body || {};
    if (!docId || !pdfUrl) {
      return res.status(400).json({ ok: false, error: "docId and pdfUrl required" });
    }

    const onlyofficeUrl = process.env.ONLYOFFICE_URL; // e.g. http://EC2_IP:8080
    if (!onlyofficeUrl) {
      return res.status(500).json({ ok: false, error: "Missing ONLYOFFICE_URL env var" });
    }

    // key must be unique; keep it stable during polling
    const key = `${docId}-pdf2docx-${Date.now()}`;

    // Minimal payload per ONLYOFFICE Conversion API
    const payload = {
      async: true,
      url: pdfUrl,
      filetype: "pdf",
      outputtype: "docx",
      key,
      title: title || "source.pdf"
    };

    // JWT: your DocumentServer says header is Authorization
    const secret = process.env.ONLYOFFICE_JWT_SECRET;
    let authHeader = {};
    if (secret) {
      const token = signJwt(payload, secret);
      authHeader = { Authorization: `Bearer ${token}` };
    }

    const converterUrl = `${onlyofficeUrl}/converter`;

    // Poll until endConvert=true (up to ~60s)
    let result = null;
    for (let i = 0; i < 40; i++) {
      const r = await fetch(converterUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          ...authHeader
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
        console.error("converter conversion error:", data);
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

    // Upload converted DOCX to Firebase Storage stable path
    const admin = getFirebaseAdmin();
    const bucket = admin.storage().bucket();

    const objectPath = `onlyoffice/${docId}/latest.docx`;
    const file = bucket.file(objectPath);

    await file.save(buf, {
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      resumable: false
    });

    // Signed URL for ONLYOFFICE to read
    const [signedUrl] = await file.getSignedUrl({
      action: "read",
      expires: Date.now() + 1000 * 60 * 60 * 24
    });

    // Update Firestore
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
    return res.status(500).json({ ok: false, error: e?.message || "pdf-to-docx failed" });
  }
});

/**
 * POST /onlyoffice/callback
 * ONLYOFFICE calls this to save updated file.
 * We verify JWT from Authorization header.
 */
onlyofficeRouter.post("/callback", async (req, res) => {
  try {
    const secret = process.env.ONLYOFFICE_JWT_SECRET;
    if (secret && !verifyOnlyOfficeJwt(req, secret)) {
      return res.status(403).json({ error: 1 });
    }

    const body = req.body || {};
    const status = body.status;

    // 2 = MustSave, 6 = MustForceSave
    if (status === 2 || status === 6) {
      const downloadUrl = body.url;
      const key = body.key; // "docId:timestamp"
      if (!downloadUrl || !key) return res.json({ error: 0 });

      const docId = String(key).split(":")[0];

      // Download updated DOCX
      const r = await fetch(downloadUrl);
      if (!r.ok) throw new Error(`Failed to download updated file: ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());

      // Upload to Firebase Storage stable path
      const admin = getFirebaseAdmin();
      const bucket = admin.storage().bucket();

      const objectPath = `onlyoffice/${docId}/latest.docx`;
      const file = bucket.file(objectPath);

      await file.save(buf, {
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        resumable: false
      });

      // Signed URL for reading
      const [signedUrl] = await file.getSignedUrl({
        action: "read",
        expires: Date.now() + 1000 * 60 * 60 * 24
      });

      // Update Firestore with latest URL
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

/* ---------------- helpers ---------------- */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * HS256 JWT signing (no extra libs).
 */
function signJwt(payloadObj, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const b64 = (obj) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

  const head = b64(header);
  const body = b64(payloadObj);
  const data = `${head}.${body}`;

  const sig = crypto
    .createHmac("sha256", secret)
    .update(data)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${data}.${sig}`;
}

/**
 * Verify JWT from Authorization: Bearer <token>.
 */
function verifyOnlyOfficeJwt(req, secret) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return false;

  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return false;

  const data = `${h}.${p}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(data)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return expected === s;
}
