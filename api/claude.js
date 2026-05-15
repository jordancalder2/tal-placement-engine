// Vercel serverless function — proxies to Anthropic API.
// The API key is supplied in the request body by the client (stored in user's localStorage).
// No server-side environment variables required.

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action, apiKey, ...rest } = req.body || {};

  if (!apiKey || !apiKey.startsWith('sk-')) {
    return res.status(400).json({ error: 'A valid Anthropic API key is required.' });
  }
  if (!action) {
    return res.status(400).json({ error: 'Missing action field.' });
  }

  async function callAnthropic(body) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) {
      throw new Error(data.error?.message || `Anthropic API error ${r.status}`);
    }
    return data;
  }

  function stripFences(text) {
    return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }

  try {
    // ── action: extract_pdf ─────────────────────
    if (action === 'extract_pdf') {
      const { pdf_base64, filename, instruction } = rest;
      if (!pdf_base64) return res.status(400).json({ error: 'pdf_base64 is required.' });

      const data = await callAnthropic({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: pdf_base64 },
            },
            {
              type: 'text',
              text: instruction ||
                'Extract and summarise all key information from this document. Be thorough and specific.',
            },
          ],
        }],
      });

      return res.json({ text: data.content[0].text });
    }

    // ── action: match ───────────────────────────
    if (action === 'match') {
      const { students, ngos } = rest;
      if (!Array.isArray(students) || !Array.isArray(ngos)) {
        return res.status(400).json({ error: 'students and ngos must be arrays.' });
      }

      const fmtStudent = s => {
        // Exclude internal fields (_name, _email, id, resumeText) from questionnaire block
        const { id, _name, _email, resumeText, ...qFields } = s;
        const questionnaire = Object.entries(qFields)
          .filter(([, v]) => v && String(v).trim())
          .map(([k, v]) => `  ${k}: ${v}`)
          .join('\n');
        return [
          `ID: ${id}`,
          `Name: ${_name || 'Unknown'}`,
          questionnaire ? `Questionnaire responses:\n${questionnaire}` : '',
          resumeText ? `Resume:\n${resumeText}` : '(No resume uploaded)',
        ].filter(Boolean).join('\n');
      };

      const fmtNgo = n => [
        `ID: ${n.id}`,
        `Name: ${n.name}`,
        n.description  ? `Description: ${n.description}` : '',
        n.studentRoles ? `Student Roles: ${n.studentRoles}` : '',
        n.hrConnection ? `Human Rights Connection: ${n.hrConnection}` : '',
        n.workPlan     ? `Work Plan:\n${n.workPlan}` : '',
        `Maturity Sensitive: ${n.maturitySensitive
          ? 'YES — only suitable for students who explicitly express comfort with trauma, GBV, or sensitive content'
          : 'No'}`,
      ].filter(Boolean).join('\n');

      const prompt = `You are the coordinator for Take Action Lab (TAL), a programme run by Tilting Futures \
that places US university students at NGOs in Cape Town, South Africa, working on Human Rights issues.

Your task: for each student, rank ALL ${ngos.length} NGOs from most to least suitable, with a fit score and reasons.

━━━ STUDENTS (${students.length}) ━━━
${students.map(fmtStudent).join('\n\n---\n\n')}

━━━ NGOs (${ngos.length}) ━━━
${ngos.map(fmtNgo).join('\n\n---\n\n')}

━━━ SCORING GUIDANCE ━━━
• Score 0–100: overall suitability for that student-NGO pairing
• Consider: stated interests, academic background, skills, goals, lived experience, language, comfort with topics
• CRITICAL: if an NGO is Maturity Sensitive, only assign a high score if the student's profile clearly \
  indicates comfort or experience with trauma/sensitive content — when in doubt, score lower
• Provide 2–4 specific, evidence-based reasons per pairing, referencing actual data from the student profile
• Reasons should be concrete (e.g. "Studied public health — aligns with NGO's health rights focus") \
  not vague ("good fit")

Return ONLY valid JSON — no markdown fences, no commentary — in this exact structure:
{
  "matches": [
    {
      "studentId": "exact id string",
      "ngoRankings": [
        {
          "ngoId": "exact id string",
          "score": 82,
          "reasons": ["reason 1", "reason 2", "reason 3"]
        }
      ]
    }
  ]
}

ngoRankings MUST contain all ${ngos.length} NGOs for every student, sorted by score descending.`;

      const data = await callAnthropic({
        model: 'claude-sonnet-4-6',
        max_tokens: 8192,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = stripFences(data.content[0].text);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return res.status(500).json({
          error: 'Claude returned non-JSON output. Try again.',
          raw: text.slice(0, 500),
        });
      }

      return res.json(parsed);
    }

    return res.status(400).json({ error: `Unknown action: "${action}"` });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
