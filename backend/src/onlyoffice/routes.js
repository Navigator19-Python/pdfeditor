import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";

// NOTE: We'll keep this simple: docs are stored in Firebase Storage by URL.
// Your frontend will pass a fileUrl (from Firebase Storage) and docId.

export const onlyofficeRouter = express.Router();

/**
 * Create ONLYOFFICE editor config.
 * Frontend calls this, then uses it to open DocsAPI.DocEditor.
 */
onlyofficeRouter.post("/config", async (req, res) => {
  const { fileUrl, fileType, title, docKey, user } = req.body || {};

  if (!fileUrl || !fileType || !docKey) {
    return res.status(400).json({ error: "fileUrl, fileType, docKey required" });
  }

  const callbackUrl = `${publicBaseUrl(req)}/onlyoffice/callback`;

  const config = {
    document: {
      fileType,
      key: docKey, // MUST be unique per version
      title: title || "Document",
      url: fileUrl
    },
    documentType: "text", // for docx; use "spreadsheet" for xlsx, "presentation" for pptx
    editorConfig: {
      callbackUrl,
      user: {
        id: user?.id || "1",
        name: user?.name || "User"
      }
    }
  };

  // Attach JWT token if enabled
  const secret = process.env.ONLYOFFICE_JWT_SECRET;
  if (secret) {
    config.token = signJwt(config, secret);
  }

  return res.json(config);
});

/**
 * ONLYOFFICE callback:
 * - status 2 or 6 => document is ready for saving
 * - callback contains url to download the updated file
 *
 * We download the updated file and return "error":0
 *
 * NOTE: We'll implement "save to Firebase" in the next step (below),
 * because it needs Firebase Admin credentials.
 */
onlyofficeRouter.post("/callback", async (req, res) => {
  try {
    // If JWT enabled, verify the request
    const secret = process.env.ONLYOFFICE_JWT_SECRET;
    if (secret) {
      const ok = verifyOnlyOfficeJwt(req, secret);
      if (!ok) return res.status(403).json({ error: 1 });
    }

    const body = req.body || {};
    const status = body.status;

    // 2 = MustSave, 6 = MustForceSave
    if (status === 2 || status === 6) {
      const downloadUrl = body.url;
      if (!downloadUrl) return res.json({ error: 0 });

      // Download updated file
      const r = await fetch(downloadUrl);
      if (!r.ok) throw new Error(`Failed to download updated doc: ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());

      // TODO: upload buf back to Firebase Storage (next step)
      // For now, just log size:
      console.log("ONLYOFFICE updated file bytes:", buf.length);
    }

    return res.json({ error: 0 });
  } catch (e) {
    console.error("ONLYOFFICE callback error:", e);
    return res.status(500).json({ error: 1 });
  }
});

function publicBaseUrl(req) {
  // On Render, set PUBLIC_BASE_URL in env to your backend URL to avoid proxy issues.
  return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
}

/**
 * Minimal JWT (HS256) signing without extra libs
 */
function signJwt(payloadObj, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const base64url = (obj) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

  const head = base64url(header);
  const body = base64url(payloadObj);
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
  // OnlyOffice often sends token either in body.token or Authorization header
  const token = req.body?.token || (req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null);
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
