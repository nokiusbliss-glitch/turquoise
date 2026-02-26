import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const PUBLIC_DIR = path.join(__dirname, "../public");

if (!PUBLIC_DIR) {
  throw new Error("Invariant violated: PUBLIC_DIR missing");
}

app.use(express.static(PUBLIC_DIR));

app.get("*", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`Turquoise running on ${PORT}`);
});