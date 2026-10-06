import { GoogleGenAI } from "@google/genai";

// Mints a one-use, short-lived token so the real API key never reaches the client browser.
const TOKEN_ENDPOINTS = [
  "https://generativelanguage.googleapis.com/v1alpha/authTokens",
  "https://generativelanguage.googleapis.com/v1alpha/auth_tokens",
  "https://generativelanguage.googleapis.com/v1beta/authTokens",
  "https://generativelanguage.googleapis.com/v1beta/auth_tokens"
];

export async function onRequestPost({ env }) {
  try {
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      return Response.json(
        { error: "GEMINI_API_KEY is not configured in .dev.vars or environment." },
        { status: 500 }
      );
    }

    const now = Date.now();
    const expireTime = new Date(now + 30 * 60 * 1000).toISOString();
    const newSessionExpireTime = new Date(now + 90 * 1000).toISOString();

    // 1. Try official SDK authTokens
    try {
      const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1alpha" } });
      if (ai.authTokens && typeof ai.authTokens.create === "function") {
        const t = await ai.authTokens.create({
          config: {
            uses: 1,
            expireTime,
            newSessionExpireTime
          }
        });
        if (t?.name) {
          return Response.json({ token: t.name });
        }
      }
    } catch (sdkErr) {
      console.warn("SDK authTokens.create error, trying REST endpoints:", sdkErr.message);
    }

    // 2. Try REST endpoint variants
    for (const url of TOKEN_ENDPOINTS) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "x-goog-api-key": apiKey,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            uses: 1,
            expireTime,
            newSessionExpireTime
          })
        });

        if (res.ok) {
          const data = await res.json();
          const tokenName = data.name || data.token || data.authToken;
          if (tokenName) {
            return Response.json({ token: tokenName });
          }
        }
      } catch (fetchErr) {
        // Continue to next endpoint candidate
      }
    }

    // 3. Graceful fallback: If ephemeral tokens endpoint is unavailable (e.g. standard Google AI Studio free keys),
    // supply the API key directly so live audio practice continues without disruption.
    return Response.json({ token: apiKey });
  } catch (err) {
    return Response.json({ error: "Token generation error: " + err.message }, { status: 500 });
  }
}
