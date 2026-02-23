import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import { getFirebaseAdmin } from "./firebaseAdmin.js";
// import { blankDocxBuffer } from "./blankDocx.js"; // optional

export const onlyofficeRouter = express.Router();

/**
 * Create config for DocsAPI.DocEditor
 */
onlyofficeRouter.post("/config", async (req, res) => {
  const { docId, fileUrl, fileType, title, user } = req.body || {};
  if (!docId || !fileUrl || !fileType) {
    return res.status(400).json({ error: "docId, fileUrl, fileType required" });
  }

  const callbackUrl = `${process.env.PUBLIC_BASE_URL}/onlyoffice/callback`;

  // key must change each open/version
  const key = `${docId}:${Date.now()}`;

  const config = {
    document: {
      fileType,
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
});

/**
 * OPTIONAL: create a blank docx in Firebase Storage.
 * If you don’t want this, delete this endpoint and the frontend "New Blank" button.
 */
onlyofficeRouter.post("/create-blank", async (req, res) => {
  try {
    const { docId } = req.body || {};
    if (!docId) return res.status(400).json({ error: "docId required" });

    // If you implement blankDocxBuffer or docx-lib generator:
    // const buf = blankDocxBuffer("Untitled");
    // For now, respond with error so you don't break builds if blankDocx is not set.
    return res.status(501).json({ error: "Blank DOCX generator not enabled. Upload a DOCX instead." });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to create blank." });
  }
});

/**
 * ONLYOFFICE callback: save updated doc
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

      const docId = key.split(":")[0];

      // Download updated DOCX from ONLYOFFICE
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

      // Signed URL for ONLYOFFICE to load next time
      const [signedUrl] = await file.getSignedUrl({
        action: "read",
        expires: Date.now() + 1000 * 60 * 60 * 24
      });

      // Update Firestore doc with latest URL
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
    console.error("Callback error:", e);
    return res.status(500).json({ error: 1 });
  }
});

/* ---- JWT helpers (HS256) ---- */
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
  // Your ONLYOFFICE says header is Authorization
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
