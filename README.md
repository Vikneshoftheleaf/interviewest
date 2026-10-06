# Interview Buddy 🎙️⚡

Real-time AI voice interview practice powered by the **Gemini Multimodal Live API** and **Cloudflare Pages**.

Features:
- **Real-time Bidirectional Voice Practice**: Talk naturally with Gemini via low-latency audio streaming.
- **Hardware-Agnostic Resampling**: Downsamples mic input to 16kHz mono PCM smoothly across all devices and headsets.
- **Resume Parsing & Hotspots**: Automatically structures PDF, DOCX, TXT, and Markdown resumes and spots interview probing points.
- **Multiple Interviewer Personas**: Friendly Coach, Senior Hiring Manager, Tough Tech Lead, or Behavioral Recruiter.
- **Voice Selection**: Choose between Puck, Aoede, Charon, Fenrir, and Kore.
- **Live Transcript & History**: Real-time transcript feed, one-click copy, and local session history stored securely in IndexedDB.
- **Zero Key Leaks**: Ephemeral session tokens keep your `GEMINI_API_KEY` private on the server.

---

## Getting Started

### 1. Configure Environment
Copy `.dev.vars.example` to `.dev.vars` and add your Google Gemini API key:
```bash
cp .dev.vars.example .dev.vars
```
Inside `.dev.vars`:
```ini
GEMINI_API_KEY=your_gemini_api_key_here
```

### 2. Run Locally
```bash
npm install
npm run dev
```
Open **`http://localhost:8788`** in your browser. (Microphone access requires `localhost` or `https`).

---

## Deploy to Cloudflare Pages
```bash
npm run deploy
npx wrangler pages secret put GEMINI_API_KEY --project-name interview-buddy
```

