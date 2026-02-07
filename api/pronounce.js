export const config = {
  api: { bodyParser: false },
};

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      try {
        const contentType = req.headers["content-type"] || "";
        const boundaryMatch = contentType.match(/boundary=(.+)$/);
        if (!boundaryMatch) return reject(new Error("Missing multipart boundary"));
        const boundary = boundaryMatch[1];

        const buf = Buffer.concat(chunks);
        const parts = buf.toString("binary").split(`--${boundary}`);

        const out = { fields: {}, files: {} };

        for (const p of parts) {
          if (!p || p === "--\r\n" || p === "--") continue;
          const [rawHeaders, rawBody] = p.split("\r\n\r\n");
          if (!rawHeaders || !rawBody) continue;

          const headers = rawHeaders.split("\r\n").filter(Boolean);
          const disp = headers.find(h => h.toLowerCase().startsWith("content-disposition"));
          if (!disp) continue;

          const nameMatch = disp.match(/name="([^"]+)"/);
          if (!nameMatch) continue;
          const name = nameMatch[1];

          const filenameMatch = disp.match(/filename="([^"]*)"/);
          const bodyBinary = rawBody.slice(0, rawBody.lastIndexOf("\r\n"));

          if (filenameMatch && filenameMatch[1]) {
            const ct = headers.find(h => h.toLowerCase().startsWith("content-type")) || "";
            const mime = ct.split(":")[1]?.trim() || "application/octet-stream";
            out.files[name] = {
              filename: filenameMatch[1],
              mime,
              buffer: Buffer.from(bodyBinary, "binary"),
            };
          } else {
            out.fields[name] = Buffer.from(bodyBinary, "binary").toString("utf8");
          }
        }

        resolve(out);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const region = process.env.AZURE_SPEECH_REGION;
    const key = process.env.AZURE_SPEECH_KEY;
    if (!region || !key) return res.status(500).json({ error: "Missing AZURE_SPEECH_REGION or AZURE_SPEECH_KEY" });

    const { fields, files } = await parseMultipart(req);

    const referenceText = (fields.referenceText || "").trim();
    if (!referenceText) return res.status(400).json({ error: "Missing referenceText" });

    const audioFile = files.audio;
    if (!audioFile?.buffer?.length) return res.status(400).json({ error: "Missing audio file" });

    // Pronunciation Assessment config (Azure expects base64 JSON in header)
    const paConfig = {
      ReferenceText: referenceText,
      GradingSystem: "HundredMark",
      Granularity: "Word",
      EnableMiscue: true,
    };
    const paHeader = Buffer.from(JSON.stringify(paConfig)).toString("base64");

    // REST endpoint (conversation) – can work for read-aloud too
    const url = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=detailed`;

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Pronunciation-Assessment": paHeader,
        "Content-Type": audioFile.mime || "audio/webm;codecs=opus",
        "Accept": "application/json",
      },
      body: audioFile.buffer,
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({ error: data?.error || data?.message || "Azure Speech error", raw: data });
    }

    // Parse word-level results
    // Typical shape: NBest[0].Words = [{ Word, PronunciationAssessment:{AccuracyScore, ErrorType}, ... }]
    const nbest = data?.NBest?.[0];
    const words = (nbest?.Words || []).map(w => ({
      word: w?.Word || "",
      accuracy: w?.PronunciationAssessment?.AccuracyScore ?? null,
      errorType: w?.PronunciationAssessment?.ErrorType || "None",
      offset: w?.Offset ?? null,
      duration: w?.Duration ?? null,
    }));

    const overall = {
      accuracyScore: nbest?.PronunciationAssessment?.AccuracyScore ?? null,
      fluencyScore: nbest?.PronunciationAssessment?.FluencyScore ?? null,
      completenessScore: nbest?.PronunciationAssessment?.CompletenessScore ?? null,
      pronScore: nbest?.PronunciationAssessment?.PronScore ?? null,
    };

    return res.status(200).json({ overall, words, raw: data });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}

