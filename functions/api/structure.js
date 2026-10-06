// Turns raw resume text into structured JSON with dynamic model discovery and robust fallback.
const PROMPT = `You are an expert technical recruiter and resume analyzer.
Analyze the following resume and convert it into a valid, strict JSON object.
JSON schema must strictly have these keys:
{
  "label": "Short descriptive label (e.g. 'Senior Frontend – 2025' or 'Product Manager - Tech')",
  "role": "Target role or primary profession suited by this resume",
  "summary": "2-3 sentence executive summary of the candidate profile",
  "skills": ["Array of technical and domain skills"],
  "experience": [
    {
      "company": "Company name",
      "title": "Job title",
      "period": "Date range / duration",
      "highlights": ["Key achievements and responsibilities"]
    }
  ],
  "projects": [
    {
      "name": "Project name",
      "details": "Description of tech stack and impact"
    }
  ],
  "education": [
    "Degree, institution, and graduation year"
  ],
  "hotspots": [
    "Specific probing points for interviewers: gaps, vague metrics, rapid transitions, or impressive claims to verify"
  ]
}
Use ONLY facts present in the text. Return strictly the JSON object.

Resume content:
`;

function extractJson(raw) {
  let cleaned = raw.trim();
  // Remove markdown code fences if present
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    // Attempt regex extraction for { ... }
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    throw new Error("Failed to parse JSON from AI response");
  }
}

// Fallback endpoints if dynamic model discovery fails
const FALLBACK_ENDPOINTS = [
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent",
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent",
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent",
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent",
  "https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent",
  "https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent"
];

async function getCandidateEndpoints(apiKey) {
  const endpoints = [];
  try {
    // Dynamically list available models for this specific API key
    const listRes = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
      headers: { "x-goog-api-key": apiKey }
    });
    if (listRes.ok) {
      const data = await listRes.json();
      if (Array.isArray(data.models)) {
        // Filter models that support generateContent and are text/chat models (exclude image/audio/embedding models)
        const validModels = data.models.filter(m => {
          if (!Array.isArray(m.supportedGenerationMethods) || !m.supportedGenerationMethods.includes("generateContent")) {
            return false;
          }
          const name = m.name.toLowerCase();
          if (name.includes("image") || name.includes("embed") || name.includes("vision") || 
              name.includes("tts") || name.includes("realtime") || name.includes("whisper") ||
              name.includes("aqa")) {
            return false;
          }
          return true;
        });

        // Score models to prioritize stable text flash models
        validModels.sort((a, b) => {
          const score = (m) => {
            const n = m.name.toLowerCase();
            let s = 0;
            if (n.includes("2.0-flash")) s += 100;
            else if (n.includes("1.5-flash")) s += 80;
            else if (n.includes("flash")) s += 60;
            else if (n.includes("1.5-pro") || n.includes("2.0-pro")) s += 40;
            if (n.includes("exp") || n.includes("preview")) s -= 20;
            return s;
          };
          return score(b) - score(a);
        });

        for (const m of validModels) {
          endpoints.push(`https://generativelanguage.googleapis.com/v1beta/${m.name}:generateContent`);
        }
      }
    }
  } catch (e) {
    console.warn("Model discovery error:", e);
  }

  // Append fallbacks to ensure coverage
  for (const fb of FALLBACK_ENDPOINTS) {
    if (!endpoints.includes(fb)) {
      endpoints.push(fb);
    }
  }
  return endpoints;
}

export async function onRequestGet() {
  return Response.json({
    status: "ok",
    endpoint: "/api/structure",
    message: "Interviewest Structure Parsing Service is operational."
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}

export async function onRequestPost({ request, env }) {
  try {
    const apiKey = (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GEMINI_KEY || "").trim();
    if (!apiKey) {
      return Response.json(
        {
          error: "GEMINI_API_KEY is not configured in Cloudflare Pages environment variables or .dev.vars.",
          help: "In the Cloudflare Dashboard, go to your Pages project > Settings > Environment variables and add GEMINI_API_KEY."
        },
        { status: 500 }
      );
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON request body." }, { status: 400 });
    }

    const { text } = body || {};
    if (!text || typeof text !== "string" || text.trim().length < 30) {
      return Response.json(
        { error: "Resume text looks too short or empty. Please upload a valid document." },
        { status: 400 }
      );
    }

    const trimmedText = text.trim().slice(0, 30000);
    const endpoints = await getCandidateEndpoints(apiKey);
    let lastError = null;

    for (const url of endpoints) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "x-goog-api-key": apiKey,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: PROMPT + "\n\n" + trimmedText }] }],
            generationConfig: {
              responseMimeType: "application/json",
              temperature: 0.2
            }
          })
        });

        if (!res.ok) {
          const errText = await res.text();
          lastError = `Endpoint [${url.split("/").slice(-2).join("/")}] returned ${res.status}: ${errText}`;
          // If the model had quota issue (429), not found (404), unsupported (400), or temporarily unavailable (503/500), try next candidate!
          continue;
        }

        const jsonRes = await res.json();
        const candidateText = jsonRes?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!candidateText) {
          throw new Error("No candidate content received from Gemini.");
        }

        const parsed = extractJson(candidateText);
        
        // Ensure defaults for all expected fields
        const structured = {
          label: parsed.label || "Resume Profile",
          role: parsed.role || "Professional",
          summary: parsed.summary || "",
          skills: Array.isArray(parsed.skills) ? parsed.skills : [],
          experience: Array.isArray(parsed.experience) ? parsed.experience : [],
          projects: Array.isArray(parsed.projects) ? parsed.projects : [],
          education: Array.isArray(parsed.education) ? parsed.education : [],
          hotspots: Array.isArray(parsed.hotspots) ? parsed.hotspots : []
        };

        return Response.json(structured);
      } catch (err) {
        lastError = err.message;
      }
    }

    return Response.json(
      { error: "Could not structure resume across available models. " + (lastError || "Check API quota.") },
      { status: 502 }
    );
  } catch (globalErr) {
    return Response.json({ error: "Server error: " + globalErr.message }, { status: 500 });
  }
}

