import express from "express";
import cors from "cors";
import { onlyofficeRouter } from "./onlyoffice/routes.js";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "50mb" }));

app.get("/health", (req, res) => res.json({ ok: true }));
app.use("/onlyoffice", onlyofficeRouter);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Backend running on :${PORT}`));
