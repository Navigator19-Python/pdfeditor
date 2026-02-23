import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import { getFirebaseAdmin } from "./firebaseAdmin.js";
import { Document, Packer, Paragraph, TextRun } from "docx";

export const onlyofficeRouter = express.Router();

/**
 * POST /onlyoffice/config
 * Frontend requests config; we return ONLYOFFICE DocEditor config + JWT token.
 */
onlyofficeRouter.post("/config", async (req, res) => {
  try {
    const { docId, fileUrl, fileType, title, user } = req.body || {};
    if (!docId || !fileUrl || !fileType) {
      return res.status(400).json({ error: "docId, fileUrl, fileType required" });
    }

    const callbackUrl = `${process.env.PUBLIC_BASE_URL}/onlyoffice/callback`;
    const key = `${docId}:${Date.now()}`; // must change per open/version

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
 * Creates a new blank DOCX and uploads it to Firebase Storage:
 * onlyoffice/{docId}/latest.docx
 */
onlyofficeRouter.post("/create-blank", async (req, res) => {
  try {
    const { docId, title } = req.body || {};
    if (!docId) return res.status(400).json({ error: "docId required" });

    // Build a minimal DOCX
    const doc = new Document({
      sections: [
        {
          properties: {},
          children: [
            new Paragraph({
              children: [
                new TextRun({ text: title || "Untitled", bold: true, size: 32 })
              ]
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
    return res.status(500).json({ error: "Failed to create blank DOCX" });
  }
});

/**
 * POST /onlyoffice/convert/pdf-to-docx
 * Converts a PDF (by URL) to DOCX using ONLYOFFICE Conversion API:
 * POST {ONLYOFFICE_URL}/converter
 */
onlyofficeRouter.post("/convert/pdf-to-docx", async (req, res) => {
  try {
    const { docId, pdfUrl, title } = req.body || {};
    if (!docId || !pdfUrl) {
      return res.status(400).json({ error: "docId and pdfUrl required" });
    }

    const onlyofficeUrl = process.env.ONLYOFFICE_URL; // e.g. http://EC2_IP:8080
    if (!onlyofficeUrl) return res.status(500).json({ error: "Missing ONLYOFFICE_URL env var" });

    const key = `${docId}:pdf2docx:${Date.now()}`;

    // Conversion request format (OnlyOffice Conversion API)
    const payload = {
      async: true,
      filetype: "pdf",
      outputtype: "docx",
      key,
      title: title || "source.pdf",
      url: pdfUrl
    };

    const secret = process.env.ONLYOFFICE_JWT_SECRET;
    let token = null;
    if (secret) {
      token = signJwt(payload, secret);
      payload.token = token;
    }

    const converterUrl = `${onlyofficeUrl}/converter?shardkey=${encodeURIComponent(key)}`;

    // Poll until endConvert=true (up to ~60s)
    let result = null;
    for (let i = 0; i < 40; i++) {
      const r = await fetch(converterUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify(payload)
      });

      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`Conversion API failed: ${r.status} ${text}`);
      }

      const data = await r.json();
      if (data?.error) throw new Error(`Conversion error code: ${data.error}`);

      if (data?.endConvert) {
        result = data;
        break;
      }
      await sleep(1500);
    }

    if (!result?.fileUrl) {
      return res.status(504).json({ error: "Conversion timeout (try again)" });
    }

    // Download converted docx
    const docxResp = await fetch(result.fileUrl);
    if (!docxResp.ok) throw new Error(`Failed to download converted DOCX: ${docxResp.status}`);
    const buf = Buffer.from(await docxResp.arrayBuffer());

    // Upload into stable path (callback overwrites this later too)
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
      expires: Date.now() + 1000 * 60 * 60 * 24
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
    return res.status(500).json({ error: e?.message || "pdf-to-docx failed" });
  }
});

/**
 * POST /onlyoffice/callback
 * ONLYOFFICE calls this to save the updated file.
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
        expires: Date.now() + 1000 * 60 * 60 * 24
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

/* ---------------- helpers ---------------- */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// HS256 JWT signing (no extra libs)
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

function verifyOnlyOfficeJwt(req, secret) {
  // Your server says: JWT header = Authorization
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
