import express from "express";
import multer from "multer";
import axios from "axios";
import FormData from "form-data";

const app = express();
const upload = multer();
const PORT = process.env.PORT || 3000;

// CloudConvert API Key (Render ENV)
const CLOUD_KEY = process.env.CLOUDCONVERT_API_KEY;

// Günlük ücretsiz limit (CloudConvert Free = 10)
let dailyCount = 0;

// 24 saatte bir sıfırla
setInterval(() => {
  dailyCount = 0;
}, 24 * 60 * 60 * 1000);

/**
 * POST /convert
 * form-data:
 *  - file   : dosya
 *  - target : hedef uzantı (pdf, docx, txt, png vs)
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

  // 🔥 OCR SADECE PDF → DOCX için aktif
  const isPdfToDocx =
    target === "docx" &&
    req.file.originalname.toLowerCase().endsWith(".pdf");

  try {
    // 1️⃣ CloudConvert Job oluştur
    const jobRes = await axios.post(
      "https://api.cloudconvert.com/v2/jobs",
      {
        tasks: {
          "import-file": {
            operation: "import/upload"
          },

          "convert-file": {
            operation: "convert",
            input: "import-file",
            input_format: "pdf",
            output_format: target,

            // 🔥 PDF → DOCX ise OCR + Office engine
            ...(isPdfToDocx && {
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

    // Import task
    const importTask = Object.values(jobRes.data.data.tasks)
      .find(t => t.operation === "import/upload");

    // 2️⃣ Dosyayı upload et
    const form = new FormData();
    Object.entries(importTask.result.form.parameters)
      .forEach(([k, v]) => form.append(k, v));

    form.append("file", req.file.buffer, req.file.originalname);

    await axios.post(importTask.result.form.url, form, {
      headers: form.getHeaders()
    });

    // 3️⃣ Job tamamlanana kadar bekle
    let job;
    while (true) {
      const statusRes = await axios.get(
        `https://api.cloudconvert.com/v2/jobs/${jobRes.data.data.id}`,
        {
          headers: {
            Authorization: `Bearer ${CLOUD_KEY}`
          }
        }
      );

      job = statusRes.data.data;

      if (job.status === "finished") break;
      if (job.status === "error") {
        throw new Error("CloudConvert conversion failed");
      }

      await new Promise(r => setTimeout(r, 2000));
    }

    // 4️⃣ Download URL
    const exportTask = Object.values(job.tasks)
      .find(t => t.operation === "export/url");

    dailyCount++;

    res.json({
      status: "ok",
      ocr_used: isPdfToDocx,
      download_url: exportTask.result.files[0].url
    });

  } catch (err) {
    console.error("Conversion error:", err.message);

    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log("✅ ToMeta CloudConvert server running on port", PORT);
});
