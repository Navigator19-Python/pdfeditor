import admin from "firebase-admin";

export function getFirebaseAdmin() {
  if (admin.apps.length) return admin;

  // Put your Firebase service account JSON into env as a single line string
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON env var");

  const serviceAccount = JSON.parse(raw);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET
  });

  return admin;
}
