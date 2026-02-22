import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import { getFirebaseAdmin } from "./firebaseAdmin.js";

export const onlyofficeRouter = express.Router();

/**
 * Frontend calls this to get ONLYOFFICE config.
 * We embed docId inside "key" so callback knows where to save.
 */
onlyofficeRouter.post("/config", async (req, res) => {
  const { docId, fileUrl, fileType, title, user } = req.body || {};
  if (!docId || !fileUrl || !fileType) {
    return res.status(400).json({ error: "docId, fileUrl, fileType required" });
  }

  const callbackUrl = `${process.env.PUBLIC_BASE_URL}/onlyoffice/callback`;

  // key MUST change when a new version is created (add timestamp)
  const key = `${docId}:${Date.now()}`;

  const config = {
    document: {
      fileType,          // "docx"
      key,               // we parse docId from this in callback
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

  // JWT token for config
  const secret = process.env.ONLYOFFICE_JWT_SECRET;
  if (secret) config.token = signJwt(config, secret);

  return res.json(config);
});

/**
 * ONLYOFFICE calls this when saving.
 * We verify JWT using Authorization header (your config).
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
      const key = body.key; // this equals our key: "docId:timestamp"
      if (!downloadUrl || !key) return res.json({ error: 0 });

      const docId = key.split(":")[0];

      // Download updated docx from ONLYOFFICE
      const r = await fetch(downloadUrl);
      if (!r.ok) throw new Error(`Failed download updated doc: ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());

      // Upload back to Firebase Storage
      const admin = getFirebaseAdmin();
      const bucket = admin.storage().bucket();

      const objectPath = `onlyoffice/${docId}/latest.docx`;
      const file = bucket.file(objectPath);

      await file.save(buf, {
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        resumable: false,
        public: false
      });

      // Create a signed URL for frontend to open again (optional)
      const [signedUrl] = await file.getSignedUrl({
        action: "read",
        expires: Date.now() + 1000 * 60 * 60 * 24 // 24h
      });

      // Update Firestore doc with latest docx URL (optional)
      await admin.firestore().collection("docs").doc(docId).set(
        {
          onlyoffice: {
            docxPath: objectPath,
            docxUrl: signedUrl,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }
        },
        { merge: true }
      );

      console.log("Saved updated docx to Firebase:", objectPath);
    }

    return res.json({ error: 0 });
  } catch (e) {
    console.error("ONLYOFFICE callback error:", e);
    return res.status(500).json({ error: 1 });
  }
});

/* ---------- JWT helpers (HS256) ---------- */

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
  // Your ONLYOFFICE says JWT header is Authorization
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
