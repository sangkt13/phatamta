export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { topic, question, transcript, model } = req.body || {};
    if (!transcript?.trim()) return res.status(400).json({ error: "Missing transcript" });

    const prompt = `
Act as an IELTS Speaking Examiner.
Topic: ${topic || ""}
Question: ${question || ""}
Student transcript: ${transcript}

Return in Vietnamese with Markdown:
- Estimated Band (0-9) and short reason
- Pronunciation notes (general)
- Grammar mistakes (bullet list with corrections)
- Vocabulary improvements (bullet list)
- Better answer (sample)
`.trim();

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: model || "gpt-4o-mini",
        input: prompt,
      }),
    });

    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data?.error?.message || "OpenAI error" });

    const text =
      (data.output || [])
        .flatMap(o => o.content || [])
        .filter(c => c.type === "output_text")
        .map(c => c.text)
        .join("\n") || "No output";

    return res.status(200).json({ text });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}

