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
    // Expects a single student object + ngos array.
    // Client loops over students and calls once per student.
    if (action === 'match') {
      const { student, ngos } = rest;
      if (!student || typeof student !== 'object') {
        return res.status(400).json({ error: 'student object is required.' });
      }
      if (!Array.isArray(ngos)) {
        return res.status(400).json({ error: 'ngos must be an array.' });
      }

      const fmtStudent = s => {
        const { id, _name, _email, resumeText, ...qFields } = s;
        const questionnaire = Object.entries(qFields)
          .filter(([, v]) => v && String(v).trim())
          .map(([k, v]) => `  ${k}: ${v}`)
          .join('\n');
        return [
          `ID: ${id}`,
          `Name: ${_name || 'Unknown'}`,
          questionnaire ? `Questionnaire responses:\n${questionnaire}` : '',
          resumeText ? `Resume insights:\n${resumeText}` : '(No resume uploaded)',
        ].filter(Boolean).join('\n');
      };

      const condenseWorkPlan = text => {
        if (!text || text.length <= 400) return text;
        const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

        // Extract week headings and their inline themes (e.g. "Week 2 – Community outreach")
        const weekLines = lines.filter(l =>
          /^(week\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten))/i.test(l)
        );
        const weekThemes = weekLines
          .map(l => l.replace(/^week\s+\S+\s*[:–—\-]?\s*/i, '').trim())
          .filter(t => t.length > 3)
          .slice(0, 6);

        // Extract bullet-point activities
        const bullets = lines
          .filter(l => /^[•\-\*–►▸]/.test(l))
          .map(l => l.replace(/^[•\-\*–►▸]\s*/, '').trim())
          .filter(l => l.length > 8)
          .slice(0, 5);

        const parts = [];

        if (weekThemes.length >= 2) {
          parts.push(`Weekly themes: ${weekThemes.join(', ')}.`);
        } else if (weekLines.length >= 2) {
          parts.push(`Structured across ${weekLines.length} weeks.`);
        }

        if (bullets.length >= 2) {
          parts.push(`Key activities: ${bullets.slice(0, 4).join('; ')}.`);
        }

        if (!parts.length) {
          // Fall back to first two meaningful sentences
          const sentences = (text.match(/[^.!?\n]{15,}[.!?]/g) || []).slice(0, 2);
          parts.push(sentences.length ? sentences.join(' ') : text.slice(0, 400) + '…');
        }

        return parts.join(' ');
      };

      const fmtNgo = n => [
        `ID: ${n.id}`,
        `Name: ${n.name}`,
        n.description  ? `Description: ${n.description}` : '',
        n.studentRoles ? `Student Roles: ${n.studentRoles}` : '',
        n.hrConnection ? `Human Rights Connection: ${n.hrConnection}` : '',
        n.workPlan     ? `Work Plan: ${condenseWorkPlan(n.workPlan)}` : '',
        `Maturity Sensitive: ${n.maturitySensitive
          ? 'YES — only suitable for students who explicitly express comfort with trauma, GBV, or sensitive content'
          : 'No'}`,
      ].filter(Boolean).join('\n');

      const prompt = `You are the coordinator for Take Action Lab (TAL), a programme run by Tilting Futures \
that places US university students at NGOs in Cape Town, South Africa, working on Human Rights issues.

Your task: rank ALL ${ngos.length} NGOs from most to least suitable for the student below, with a fit score and reasons.

━━━ STUDENT ━━━
${fmtStudent(student)}

━━━ NGOs (${ngos.length}) ━━━
${ngos.map(fmtNgo).join('\n\n---\n\n')}

━━━ QUESTIONNAIRE GUIDE ━━━

SECTION 1 — ABOUT YOU
Q1 = Current study status: "On a gap year after high school" / "Currently at university" / "Taking a break from studies" / "Have finished my degree"
Q2 = Field of study: Social Sciences/Humanities / Education / Political Science/International Relations/Pre-Law / Health Sciences/Medicine/Nursing / Business/Economics / STEM / Arts/Design/Media/Communications / Environmental Studies / Other
Q3 = Long-term career goals and why they chose this programme (open text)

SECTION 2 — HUMAN RIGHTS THEMES
Q4 = Human rights themes of genuine interest (multi-select, minimum 2):
Education & Literacy / Food Security & Community Nutrition / Women's Rights & Gender Justice / Youth Empowerment & Mentorship / Human Migration & Displacement / Land Rights & Economic Justice / Sexual Health & Rights / Elder Care & Intergenerational Support / Entrepreneurship & Skills Development / Digital Access & Technology Equity / Homelessness and Substance Dependence

SECTION 3 — SKILLS & EXPERIENCE
Q5 = Skills and experiences (multi-select): Teaching/tutoring/facilitation / Working with young children under 10 / Mentoring or coaching youth 10-25 / Supporting elderly people / Advocacy/campaigning/legal work / STEM/coding/digital skills / Arts/crafts/creative production / Media/communications/social media / Outdoor/physical/sports/agricultural work / Admin/coordination/project management / Research/writing/reporting / Counselling or psychosocial support

Q8 = Research and writing confidence (single select):
"Strong - I regularly produce written work to a professional or academic standard independently" /
"Moderate - I can do this but would benefit from guidance and feedback" /
"Developing - this is relatively new to me but I am willing to try" /
"This is not a strength of mine - I prefer roles that are more practical or interpersonal"

Q9 = Facilitation and public speaking comfort (single select):
"Very comfortable: I regularly present, teach, or lead groups and enjoy it" /
"Comfortable: I have done it before and can hold my own" /
"Developing: I have had limited experience but I am willing to push myself" /
"Uncomfortable: I find it genuinely challenging and would strongly prefer a behind-the-scenes role"

SECTION 4 — WORK STYLE & ENVIRONMENT
Q10 = Independent vs team preference (single select):
"Strongly prefer working independently" / "Prefer mostly independent with some collaboration" / "Comfortable with either" / "Prefer mostly collaborative with some solo work" / "Strongly prefer working as part of a team"

Q11 = Ideal working environment (multi-select up to 3):
Fast-paced and varied / Structured and organised / Creative and expressive / Quiet and focused / Energetic and people-facing / Outdoors/hands-on/physical / Small close-knit team / Admin and operations-focused / Flexible and self-directed / Dynamic and unpredictable

Q12 = Population comfort matrix — HARD FILTER (rate each: Very comfortable / Comfortable / Somewhat uncomfortable / Not comfortable):
Q12_babies = Babies, toddlers and pre-schoolers
Q12_children = Young children age 6-12
Q12_teens = Teenagers and young adults
Q12_disabled = People with physical or cognitive disabilities (deafness, autism, learning differences)
Q12_vuln_women = Adult women in vulnerable situations
Q12_elderly = Elderly community members
Q12_unhoused = People experiencing homelessness or food insecurity
Q12_survivors = Survivors of abuse or gender-based violence
Q12_stigmatised = Individuals engaged in activities that are criminalised or stigmatised by society
Q12_refugees = Refugees or undocumented migrants
Q12_incarcerated = People who are or were incarcerated or in the criminal justice system

HARD FILTER RULE: If a student rates "Somewhat uncomfortable" or "Not comfortable" with a population group that is CENTRAL to an NGO's work, that NGO MUST score below 50 regardless of other factors.

Q13 = Project ownership vs support preference (single select):
"I thrive when I am given a defined project to own from start to finish - I like building something tangible" /
"I prefer to plug into an existing team and support their ongoing work - I find meaning in contributing to something bigger than me" /
"I am energised by variety - I am equally happy owning a project or supporting day-to-day operations" /
"I am not sure yet - I am open to discovering what suits me"

Q14 = Physical and outdoor work comfort (single select):
"I genuinely enjoy physical outdoor work and would welcome it as a core part of my day" /
"I am open to it and happy to participate even though it is not what I am used to" /
"I can do it occasionally but would find it difficult as a daily routine" /
"This would be a significant challenge for me - I strongly prefer desk or indoor-based work"

Q15 = Supervision style preference (single select):
"I work best with regular check-ins and clear direction from a supervisor" /
"I like an initial briefing and occasional guidance but prefer to manage my own time and tasks" /
"I thrive with maximum independence - I am self-motivated and do not need much oversight" /
"I adapt easily to whatever supervision style the organisation uses"

SECTION 5 — VALUES & SOCIAL JUSTICE
Q16 = Approach to addressing social injustice (single select):
"Direct service - working face-to-face with people in need" /
"Advocacy and policy - changing laws and systems" /
"Education and outreach - building knowledge and awareness" /
"Economic empowerment - skills training and income generation" /
"I am genuinely flexible - the cause matters more than the method"

Q17 = Discomfort story (open text 2-4 sentences) — CRITICAL FOR SENSITIVE PLACEMENTS
Students were asked: "Some organisations work on issues society often stigmatises or considers controversial. Describe a time you encountered a perspective or situation that fundamentally challenged something you believed. What did you do with that discomfort?"
This question reveals: emotional maturity, capacity for self-reflection, readiness for challenging placements. A thoughtful honest answer here is the strongest signal for SWEAT, Sisters Incorporated, and Philisa Abafazi Bethu.

SECTION 6 — FIT & SELF-AWARENESS
Q18 = Ideal apprenticeship description (open text) — reveals expectations and values
Q19 = Biggest personal challenge anticipated (open text) — reveals self-awareness and honesty. Students were told: "not logistically, but in terms of who you are and how you show up"

━━━ MATCHING PRIORITY ━━━
1. Q12 comfort ratings — HARD FILTERS (score < 50 if student is uncomfortable with an org's central population)
2. Q4 themes + Q5 skills + Q10 work style + Q13 project preference + Q14 outdoor comfort + Q9 facilitation comfort
3. Q17 / Q18 / Q19 open text — reveals values, maturity, and fit beyond checkbox answers
4. Age and maturity signals for maturity-sensitive organisations (trauma, GBV, sensitive content)
5. Resume insights add texture but do not override questionnaire signals

━━━ SCORING GUIDANCE ━━━
• Score 0–100: overall suitability for this student-NGO pairing
• CRITICAL: if an NGO is Maturity Sensitive, only score high if the student clearly shows comfort with \
  trauma/sensitive content — when in doubt, score lower
• Provide 2–4 specific, evidence-based reasons per NGO, referencing actual data from the student profile
• Reasons must be concrete (e.g. "Q4 lists gender justice — matches NGO's GBV focus") not vague ("good fit")

Return ONLY valid JSON — no markdown fences, no commentary — in this exact structure:
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

ngoRankings MUST contain all ${ngos.length} NGOs, sorted by score descending.`;

      const data = await callAnthropic({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = stripFences(data.content[0].text);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (parseErr) {
        return res.status(500).json({
          error: 'JSON parse failed: ' + parseErr.message,
          raw: text.slice(0, 1000),
        });
      }
      
      // Check response has expected structure
      if (!parsed.studentId || !parsed.ngoRankings) {
        return res.status(500).json({
          error: 'Unexpected response structure',
          keys: Object.keys(parsed),
          raw: text.slice(0, 500),
        });
      }

      return res.status(200).json(parsed);
    }

    // ── action: group_placement ─────────────────
    // students: [{_name, nationality}]
    // ngos:     [{name, maturitySensitive}]
    // matches:  [{studentName, top5: [{ngoName, score}]}]
    if (action === 'group_placement') {
      const { students, ngos, matches } = rest;
      if (!Array.isArray(students) || !Array.isArray(ngos) || !Array.isArray(matches)) {
        return res.status(400).json({ error: 'students, ngos, and matches arrays are required.' });
      }

      const fmtStudent = s => {
        const match = matches.find(m => m.studentName === s._name);
        const nat   = s.nationality ? ` [${s.nationality}]` : '';
        const top5  = (match?.top5 || [])
          .slice(0, 3).map((r, i) => `  ${i + 1}. ${r.ngoName} (${r.score})`)
          .join('\n');
        return `${s._name}${nat}\n${top5 || '  (no matches)'}`;
      };

      const prompt = `You are the TAL coordinator placing ${students.length} US university students at NGOs in Cape Town.

HARD CONSTRAINTS — these cannot be broken under any circumstances:
- MAXIMUM 2 STUDENTS PER NGO. No NGO may have more than 2 students. This is absolute.
- Eoan Group and Centre of Excellence: ONLY assign if it is that student's rank #1. Never as fallback.
- Each student appears exactly once in the output.

PLACEMENT RULES:
1. Place each student at their highest-scoring available org
2. If an org already has 2 students, it is FULL — move to next best option
3. Think holistically — swap students between orgs if it improves overall fit
4. Every student must be placed if any of their top 3 orgs has a free slot
5. Only mark "manual_review" if all top 3 orgs are full

BEFORE RETURNING: verify that no NGO appears more than twice in your assignments. If any does, fix it.

STUDENTS:
${students.map(fmtStudent).join('\n\n')}

NGOs:
${ngos.map(n => `${n.name}${n.maturitySensitive ? ' [maturity-sensitive]' : ''}`).join('\n')}

Return ONLY a JSON array — no markdown fences, no commentary:
[
  {
    "student_name": "exact student name as given above",
    "assigned_org": "exact org name or null",
    "rank": 1,
    "score": 87,
    "status": "top3"
  }
]

status values: "top3" = placed at rank 1-3, "fallback" = placed at rank 4-5, "manual_review" = could not place in top 5.
Include all ${students.length} students exactly once.`;

      const data = await callAnthropic({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: 'You are a placement coordinator. You respond ONLY with valid JSON arrays. Never explain, never use markdown, never add commentary. Your entire response must be parseable by JSON.parse().',
        messages: [{ role: 'user', content: prompt }, { role: 'assistant', content: '[' }],
      });

      const text = '[' + stripFences(data.content[0].text);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (parseErr) {
        return res.status(500).json({ 
          error: 'JSON parse failed: ' + parseErr.message, 
          raw: text.slice(0, 2000) 
        });
      }

      const placements = Array.isArray(parsed) ? parsed : (parsed.placements || []);
      return res.json({ placements });
    }

    return res.status(400).json({ error: `Unknown action: "${action}"` });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
