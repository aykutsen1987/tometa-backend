import express from "express";
import multer from "multer";
import axios from "axios";
import FormData from "form-data";

const app = express();
const upload = multer();
const PORT = process.env.PORT || 3000;

// CloudConvert API Key (Render ENV'den gelir)
const CLOUD_KEY = process.env.CLOUDCONVERT_API_KEY;

// Günlük ücretsiz limit (CloudConvert free: 10)
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
      error: "file or target missing"
    });
  }

  try {
    // 1️⃣ Job oluştur
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
            output_format: req.body.target
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

    // Import task bilgileri
    const importTask = Object.values(jobRes.data.data.tasks)
      .find(t => t.operation === "import/upload");

    // 2️⃣ Dosyayı CloudConvert upload URL'ye gönder
    const form = new FormData();
    Object.entries(importTask.result.form.parameters).forEach(([k, v]) => {
      form.append(k, v);
    });
    form.append("file", req.file.buffer, req.file.originalname);

    await axios.post(importTask.result.form.url, form, {
      headers: form.getHeaders()
    });

    // 3️⃣ Job tamamlanmasını bekle
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
        throw new Error("Conversion failed");
      }

      await new Promise(r => setTimeout(r, 2000));
    }

    // 4️⃣ Download URL al
    const exportTask = Object.values(job.tasks)
      .find(t => t.operation === "export/url");

    dailyCount++;

    res.json({
      status: "ok",
      download_url: exportTask.result.files[0].url
    });

  } catch (err) {
    res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log("ToMeta CloudConvert server running on port", PORT);
});
