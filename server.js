import express from "express";
import multer from "multer";
import axios from "axios";
import FormData from "form-data";

const app = express();
const upload = multer();
const PORT = process.env.PORT || 3000;

const CLOUD_KEY = process.env.CLOUDCONVERT_API_KEY;

if (!CLOUD_KEY) {
  console.error("❌ CLOUDCONVERT_API_KEY missing!");
  process.exit(1);
}

// Free plan limiti
let dailyCount = 0;
setInterval(() => {
  dailyCount = 0;
}, 24 * 60 * 60 * 1000);

app.post("/convert", upload.single("file"), async (req, res) => {
  try {
    if (dailyCount >= 10) {
      return res.status(429).json({
        status: "limit_reached",
        message: "Daily CloudConvert free limit reached"
      });
    }

    if (!req.file || !req.body.target) {
      return res.status(400).json({
        status: "error",
        message: "file or target missing"
      });
    }

    const target = req.body.target.toLowerCase();

    // 1️⃣ Job oluştur (OCR YOK)
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
            output_format: target
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

    const jobId = jobRes.data.data.id;

    // 2️⃣ Upload
    const importTask = Object.values(jobRes.data.data.tasks)
      .find(t => t.operation === "import/upload");

    const form = new FormData();
    Object.entries(importTask.result.form.parameters)
      .forEach(([k, v]) => form.append(k, v));

    form.append("file", req.file.buffer, req.file.originalname);

    await axios.post(importTask.result.form.url, form, {
      headers: form.getHeaders()
    });

    // 3️⃣ Job bekle
    let job;
    while (true) {
      const statusRes = await axios.get(
        `https://api.cloudconvert.com/v2/jobs/${jobId}`,
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
      download_url: exportTask.result.files[0].url
    });

  } catch (err) {
    console.error("❌ Conversion error:", err.response?.data || err.message);

    res.status(500).json({
      status: "error",
      message: "Conversion failed"
    });
  }
});

app.listen(PORT, () => {
  console.log("✅ ToMeta CloudConvert server running on port", PORT);
});
