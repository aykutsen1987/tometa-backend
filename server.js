import express from "express";
import multer from "multer";
import axios from "axios";
import FormData from "form-data";

const app = express();
// Bellek dolmasın: dosya boyutu sınırı (Render ücretsiz katmanı 512 MB RAM)
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });
const PORT = process.env.PORT || 3000;

const CLOUD_KEY = process.env.CLOUDCONVERT_API_KEY;
// Ayarlanırsa istemcideki ApiService.Security.APP_SECRET ile eşleşmeyen istekler reddedilir.
// Ayarlanmazsa eski davranış (kontrolsüz) korunur → kademeli geçiş mümkün.
const APP_SECRET = process.env.APP_SECRET;
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || '24', 10);

function requireSecret(req, res, next) {
  if (!APP_SECRET) return next();
  if (req.headers['x-app-secret'] !== APP_SECRET) {
    return res.status(401).json({ status: 'error', message: 'Yetkisiz erişim.' });
  }
  next();
}

if (!CLOUD_KEY) {
  console.error("❌ CLOUDCONVERT_API_KEY missing!");
  process.exit(1);
}

// Ücretsiz CloudConvert kotası TÜM kullanıcılar için ortaktır. Sayaç UTC gün değişiminde
// sıfırlanır (sunucu yeniden başlasa da 24 saatlik zamanlayıcı gibi kaymaz).
let dailyCount = 0;
let counterDay = new Date().toISOString().slice(0, 10);
function rollCounter() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== counterDay) {
    counterDay = today;
    dailyCount = 0;
    console.log('✅ Daily counter reset');
  }
}

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "tometa-cloudconvert", dailyCount });
});

app.post("/convert", requireSecret, upload.single("file"), async (req, res) => {
  try {
    rollCounter();
    if (dailyCount >= DAILY_LIMIT) {
      return res.status(429).json({
        status: "limit_reached",
        message: "Günlük CloudConvert ücretsiz kotası doldu"
      });
    }

    if (!req.file || !req.body.target) {
      return res.status(400).json({
        status: "error",
        message: "file or target missing"
      });
    }

    const target = req.body.target.toLowerCase();
    console.log(`🔄 Converting ${req.file.originalname} → ${target}`);

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
            output_format: target,
            // PDF kalitesi için ek parametreler
            ...(target === "pdf" && {
              engine: "office",
              pdf_a: false
            })
          },
          "export-file": {
            operation: "export/url",
            input: "convert-file"
          }
        }
      },
      {
        headers: { Authorization: `Bearer ${CLOUD_KEY}` }
      }
    );

    const jobId = jobRes.data.data.id;
    console.log(`📋 Job created: ${jobId}`);

    // 2️⃣ Dosyayı yükle
    const importTask = Object.values(jobRes.data.data.tasks)
      .find(t => t.operation === "import/upload");

    const form = new FormData();
    Object.entries(importTask.result.form.parameters)
      .forEach(([k, v]) => form.append(k, v));
    form.append("file", req.file.buffer, req.file.originalname);

    await axios.post(importTask.result.form.url, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    console.log("📤 File uploaded to CloudConvert");

    // 3️⃣ Job tamamlanmasını bekle (max 3 dakika)
    let job;
    let attempts = 0;
    const maxAttempts = 90; // 90 × 2sn = 3 dakika

    while (attempts < maxAttempts) {
      await new Promise(r => setTimeout(r, 2000));
      attempts++;

      const statusRes = await axios.get(
        `https://api.cloudconvert.com/v2/jobs/${jobId}`,
        { headers: { Authorization: `Bearer ${CLOUD_KEY}` } }
      );

      job = statusRes.data.data;
      console.log(`⏳ Job status: ${job.status} (attempt ${attempts})`);

      if (job.status === "finished") break;
      if (job.status === "error") {
        const errTask = Object.values(job.tasks).find(t => t.status === "error");
        throw new Error(`CloudConvert error: ${errTask?.message || "unknown"}`);
      }
    }

    if (!job || job.status !== "finished") {
      throw new Error("Job timed out after 3 minutes");
    }

    // 4️⃣ Dosyayı CloudConvert'ten indir ve Android'e direkt stream et
    const exportTask = Object.values(job.tasks)
      .find(t => t.operation === "export/url");

    const downloadUrl = exportTask.result.files[0].url;
    const fileName = exportTask.result.files[0].filename || `output.${target}`;

    console.log(`📥 Downloading from CloudConvert: ${fileName}`);

    const fileResponse = await axios.get(downloadUrl, {
      responseType: "stream",
      timeout: 60000
    });

    dailyCount++;
    console.log(`✅ Conversion done. Daily count: ${dailyCount}`);

    // MIME type belirle
    const mimeTypes = {
      pdf:  "application/pdf",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      txt:  "text/plain",
      png:  "image/png",
      jpg:  "image/jpeg",
      webp: "image/webp"
    };
    const mime = mimeTypes[target] || "application/octet-stream";

    // Direkt Android'e stream et (download URL döndürmek yerine)
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    fileResponse.data.pipe(res);

  } catch (err) {
    console.error("❌ Conversion error:", err.response?.data || err.message);
    if (!res.headersSent) {
      res.status(500).json({
        status: "error",
        message: err.message || "Conversion failed"
      });
    }
  }
});

// multer / genel hata yakalayıcı
app.use((err, req, res, _next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ status: "error", message: "Dosya çok büyük (en fazla 25 MB)" });
  }
  console.error("Sunucu hatası:", err);
  res.status(500).json({ status: "error", message: "Sunucu hatası" });
});

app.listen(PORT, () => {
  console.log(`✅ ToMeta CloudConvert server running on port ${PORT}`);
});
