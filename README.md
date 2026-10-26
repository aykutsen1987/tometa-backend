# tometa-backend (CloudConvert köprüsü)

Uygulamadan gelen belgeyi CloudConvert'e gönderir, sonucu geri akıtır.
Kullanım: **PDF → XLSX**, **XLSX → PDF**, büyük görseller ve DOCX → PDF yedeği.

## Endpoint'ler
| Yöntem | Yol | Açıklama |
|---|---|---|
| GET | `/health` | Sağlık + günlük sayaç |
| POST | `/convert` | `file` + `target` (pdf, xlsx, docx, png…) → dönüştürülmüş dosya |

Hatalar JSON döner: `401` yetkisiz, `413` dosya >25 MB, `429` günlük kota doldu.

## Ortam değişkenleri
| Anahtar | Zorunlu | Açıklama |
|---|---|---|
| `CLOUDCONVERT_API_KEY` | evet | Yoksa sunucu başlamaz |
| `APP_SECRET` | önerilir | Tanımlıysa `x-app-secret` başlığı doğrulanır |
| `DAILY_LIMIT` | hayır | Varsayılan 24 |

Not: Ücretsiz CloudConvert kotası tüm kullanıcılar için ortaktır. Sayaç sunucu belleğindedir (yeniden başlayınca sıfırlanır).

## Yerelde çalıştırma
```bash
npm install
CLOUDCONVERT_API_KEY=xxx npm start
```
