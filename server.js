import express from "express";
import multer from "multer";
import axios from "axios";
import FormData from "form-data";

const app = express();
const upload = multer();
const PORT = process.env.PORT || 3000;

// CloudConvert API Key (Render ENV)
const CLOUD_KEY = process.env.CLOUDCONVERT_API_KEY;

if (!CLOUD_KEY) {
  console.error("❌ CLOUDCONVERT_API_KEY missing!");
}

// Günlük ücretsiz limit (Free = 10)
let dailyCount = 0;
setInterval(() => (dailyCount = 0), 24 * 60 * 60 * 1000);

/**
 * POST /convert
 * form-data:
 *  - file   : dosya
 *  - target : docx, txt, png, mp3 vs
 */
app.post("/convert", upload.single("file"), async (req, res) => {
  if (dailyCount >= 10) {
    return res.status(429).json({
      status: "limit_reached",
      message: "Daily CloudConvert limit reached"
    });
  }

  if (!req.file || !req.body.target) {
    return res.status(400).json({
      status: "error",
      message: "file or target missing"
    });
  }

  const target = req.body.target.toLowerCase();
  const isPdf =
    req.file.originalname.toLowerCase().endsWith(".pdf");
  const isPdfToDocx = isPdf && target === "docx";

  try {
    // 1️⃣ JOB OLUŞTUR (OCR'siz – EN STABİL)
    let jobRes = await createJob(target, false);

    // 2️⃣ UPLOAD
    await uploadFile(jobRes, req.file);

    // 3️⃣ BEKLE
    let job = await waitForJob(jobRes.data.data.id);

    // 4️⃣ OCR GEREKİYORSA & DOCX BOZUKSA → TEKRAR DENE
    if (isPdfToDocx && job.status === "error") {
      console.log("🔁 OCR fallback deneniyor...");

      jobRes = await createJob(target, true);
      await uploadFile(jobRes, req.file);
      job = await waitForJob(jobRes.data.data.id);
    }

    if (job.status !== "finished") {
      throw new Error("Conversion failed");
    }

    const exportTask = Object.values(job.tasks)
      .find(t => t.operation === "export/url");

    dailyCount++;

    res.json({
      status: "ok",
      ocr_used: isPdfToDocx,
      download_url: exportTask.result.files[0].url
    });

  } catch (err) {
    console.error("❌ Conversion error:", err.message);
    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

/* ---------------- HELPERS ---------------- */

async function createJob(target, useOcr) {
  return axios.post(
    "https://api.cloudconvert.com/v2/jobs",
    {
      tasks: {
        "import-file": {
          operation: "import/upload"
        },
        "convert-file": {
          operation: "convert",
          input: "import-file",
          output_format: target,
          ...(useOcr && {
            engine: "office",
            ocr: true,
            ocr_language: "tur+eng",
            optimize: true
          })
        },
        "export-file": {
          operation: "export/url",
          input: "convert-file"
        }
      }
    },
    {
      headers: {
        Authorization: `Bearer ${CLOUD_KEY}`
      }
    }
  );
}

async function uploadFile(jobRes, file) {
  const importTask = Object.values(jobRes.data.data.tasks)
    .find(t => t.operation === "import/upload");

  const form = new FormData();
  Object.entries(importTask.result.form.parameters)
    .forEach(([k, v]) => form.append(k, v));

  form.append("file", file.buffer, file.originalname);

  await axios.post(importTask.result.form.url, form, {
    headers: form.getHeaders()
  });
}

async function waitForJob(jobId) {
  while (true) {
    const statusRes = await axios.get(
      `https://api.cloudconvert.com/v2/jobs/${jobId}`,
      {
        headers: {
          Authorization: `Bearer ${CLOUD_KEY}`
        }
      }
    );

    const job = statusRes.data.data;

    if (job.status === "finished" || job.status === "error") {
      return job;
    }

    await new Promise(r => setTimeout(r, 2000));
  }
}

/* ----------------------------------------- */

app.listen(PORT, () => {
  console.log("✅ ToMeta CloudConvert server running on port", PORT);
});
