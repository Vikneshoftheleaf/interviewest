import { GoogleGenAI, Modality } from "https://esm.sh/@google/genai@1.30.0";

const LIVE_MODELS = [
  "gemini-3.8-live",
  "gemini-3.8-flash-live",
  "gemini-3.8-live-preview",
  "gemini-2.5-flash-native-audio-preview-12-2025",
  "gemini-2.0-flash-exp",
  "gemini-2.0-flash-realtime-exp"
];

const $ = id => document.getElementById(id);

// Configure PDF.js worker
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

/* ==========================================================================
   IndexedDB Storage: Resumes & Practice Sessions
   ========================================================================== */
const db = new Promise((ok, no) => {
  const r = indexedDB.open("interview_buddy_db", 2);
  r.onupgradeneeded = (e) => {
    const d = e.target.result;
    if (!d.objectStoreNames.contains("resumes")) d.createObjectStore("resumes", { keyPath: "id" });
    if (!d.objectStoreNames.contains("sessions")) d.createObjectStore("sessions", { keyPath: "id" });
  };
  r.onsuccess = () => ok(r.result);
  r.onerror = no;
});

const tx = async (storeName, mode, callback) => {
  const d = await db;
  return new Promise((ok, no) => {
    const t = d.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const q = callback(store);
    if (q) {
      q.onsuccess = () => ok(q.result);
      q.onerror = no;
    } else {
      t.oncomplete = () => ok();
      t.onerror = no;
    }
  });
};

const put = (store, val) => tx(store, "readwrite", s => s.put(val));
const all = (store) => tx(store, "readonly", s => s.getAll());
const rm = (store, key) => tx(store, "readwrite", s => s.delete(key));
const clearStore = (store) => tx(store, "readwrite", s => s.clear());

/* ==========================================================================
   Application State
   ========================================================================== */
let resumes = [];
let session = null;
let currentMode = "chat";
let isMuted = false;
let activeResumeId = "";
let inspectedResumeId = "";

let micStream = null;
let inCtx = null;
let outCtx = null;
let inAn = null;
let outAn = null;
let nextAudioTime = 0;
let activeSources = [];
let liveTranscript = [];
let lastSpeaker = "";
let sessionStartTime = 0;

const esc = s => String(s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ==========================================================================
   Navigation Tabs & Modes
   ========================================================================== */
window.switchTab = function(tabName) {
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));

  if (tabName === "live") {
    $("tabLiveBtn").classList.add("active");
    $("tabLive").classList.add("active");
  } else if (tabName === "resumes") {
    $("tabResumeBtn").classList.add("active");
    $("tabResumes").classList.add("active");
    renderResumeGallery();
  } else if (tabName === "history") {
    $("tabHistoryBtn").classList.add("active");
    $("tabHistory").classList.add("active");
    renderHistory();
  }
};

window.setInterviewMode = function(mode) {
  currentMode = mode;
  document.querySelectorAll(".mode-pill").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });

  updateStatus(session ? "live" : "ready", `Mode: ${mode.toUpperCase()}`);

  if (session) {
    const prompts = {
      chat: "Please switch to CASUAL CHAT mode: warm up, casual conversation.",
      interview: "Please switch to MOCK INTERVIEW mode: ask realistic interview questions one at a time.",
      coach: "Please switch to INSTANT COACHING mode: critique my last response and provide an improved answer.",
      grill: "Please switch to HARD PROBING (HOTSPOTS) mode: aggressively probe my resume weak spots."
    };
    try {
      session.sendClientContent({
        turns: [{ role: "user", parts: [{ text: `[User directive: ${prompts[mode] || mode}]` }] }],
        turnComplete: true
      });
    } catch (e) {
      console.warn("Could not send mode switch directive:", e);
    }
  }
};

function updateStatus(state, customText) {
  const badge = $("statusBadge");
  const textEl = $("statusText");

  badge.className = "status-badge";

  if (state === "live") {
    badge.classList.add("live");
    textEl.textContent = customText || "Live Call";
  } else if (state === "speaking") {
    badge.classList.add("speaking");
    textEl.textContent = customText || "Buddy Speaking";
  } else if (state === "thinking") {
    badge.classList.add("thinking");
    textEl.textContent = customText || "Thinking…";
  } else if (state === "muted") {
    badge.classList.add("muted");
    textEl.textContent = "Muted";
  } else {
    textEl.textContent = customText || "Ready";
  }
}

/* ==========================================================================
   Multi-Resume Management & Gallery
   ========================================================================== */
async function refreshResumes(preferredSelectId) {
  resumes = await all("resumes");
  const sel = $("selResume");
  $("resumeCount").textContent = resumes.length;

  if (resumes.length === 0) {
    sel.innerHTML = `<option value="">(No resumes uploaded)</option>`;
    $("start").disabled = true;
    activeResumeId = "";
    inspectedResumeId = "";
    $("resumeInspector").hidden = true;
    renderResumeGallery();
    return;
  }

  sel.innerHTML = resumes.map(r => 
    `<option value="${r.id}">${esc(r.data.label || "Untitled")} · ${esc(r.data.role || "Role")}</option>`
  ).join("");

  if (preferredSelectId && resumes.some(r => r.id === preferredSelectId)) {
    sel.value = preferredSelectId;
  } else if (activeResumeId && resumes.some(r => r.id === activeResumeId)) {
    sel.value = activeResumeId;
  } else {
    sel.value = resumes[0].id;
  }

  activeResumeId = sel.value;
  if (!inspectedResumeId || !resumes.some(r => r.id === inspectedResumeId)) {
    inspectedResumeId = activeResumeId;
  }

  $("start").disabled = !!session;
  renderResumeGallery();
}

function renderResumeGallery() {
  const grid = $("resumesGrid");
  $("resumeCount").textContent = resumes.length;

  if (!resumes.length) {
    grid.innerHTML = `<p style="color: var(--text-mute); font-weight: 700; grid-column: 1/-1;">No resumes uploaded yet. Drop a file above to add one!</p>`;
    $("resumeInspector").hidden = true;
    return;
  }

  grid.innerHTML = resumes.map(r => {
    const isSelected = r.id === inspectedResumeId;
    const isActive = r.id === activeResumeId;
    const skillsCount = Array.isArray(r.data?.skills) ? r.data.skills.length : 0;
    const hotspotsCount = Array.isArray(r.data?.hotspots) ? r.data.hotspots.length : 0;

    return `
      <div class="resume-box ${isSelected ? 'selected' : ''}" onclick="selectAndInspectResume('${r.id}')">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span class="resume-box-badge">${isActive ? '⭐ ACTIVE' : 'RESUME'}</span>
          <span style="font-size: 0.75rem; font-weight: 800; color: var(--text-mute);">${new Date(r.added || Date.now()).toLocaleDateString()}</span>
        </div>
        <div class="resume-box-title">${esc(r.data.label || "Resume Profile")}</div>
        <div class="resume-box-role">🎯 ${esc(r.data.role || "General")}</div>
        <div style="font-size: 0.8rem; font-weight: 700; color: var(--text-secondary); margin-top: 4px;">
          🏷️ ${skillsCount} Skills · 🔥 ${hotspotsCount} Hotspots
        </div>
      </div>
    `;
  }).join("");

  updateInspectorView();
}

window.selectAndInspectResume = function(id) {
  inspectedResumeId = id;
  renderResumeGallery();
};

function updateInspectorView() {
  const target = resumes.find(r => r.id === inspectedResumeId);
  const inspector = $("resumeInspector");

  if (!target) {
    inspector.hidden = true;
    return;
  }

  inspector.hidden = false;
  $("inspectLabel").textContent = target.data.label || "Resume Profile";
  $("inspectRole").textContent = `Target Role: ${target.data.role || "General Professional"}`;
  $("inspectSummary").textContent = target.data.summary || "No summary available.";

  // Skills
  const skills = Array.isArray(target.data.skills) ? target.data.skills : [];
  $("inspectSkills").innerHTML = skills.length
    ? skills.map(s => `<span class="tag-pill">${esc(s)}</span>`).join("")
    : `<span style="color: var(--text-mute); font-size: 0.85rem; font-weight: 700;">No specific skills extracted</span>`;

  // Hotspots
  const hotspots = Array.isArray(target.data.hotspots) ? target.data.hotspots : [];
  $("inspectHotspots").innerHTML = hotspots.length
    ? hotspots.map(h => `<div class="hotspot-box">⚠️ ${esc(h)}</div>`).join("")
    : `<div class="hotspot-box" style="background: var(--green-light); border-color: var(--green); color: var(--green-shadow);">✅ No major red flags identified. Ready to shine!</div>`;

  // Active button state
  const isActive = target.id === activeResumeId;
  $("setActiveBtn").textContent = isActive ? "✅ Active for Practice" : "⭐ Use For Practice";
  $("setActiveBtn").disabled = isActive;
}

$("setActiveBtn").onclick = () => {
  if (inspectedResumeId) {
    activeResumeId = inspectedResumeId;
    $("selResume").value = activeResumeId;
    renderResumeGallery();
    $("msg").textContent = "Set as active resume for practice!";
    setTimeout(() => { if ($("msg").textContent.includes("active resume")) $("msg").textContent = ""; }, 3000);
  }
};

$("delResumeBtn").onclick = async () => {
  if (!inspectedResumeId) return;
  if (confirm("Delete this resume?")) {
    await rm("resumes", inspectedResumeId);
    inspectedResumeId = "";
    await refreshResumes();
    $("msg").textContent = "Resume deleted.";
  }
};

$("selResume").onchange = () => {
  activeResumeId = $("selResume").value;
  inspectedResumeId = activeResumeId;
  renderResumeGallery();
};

/* ==========================================================================
   Document Parsing & Uploading
   ========================================================================== */
async function extractTextFromFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf")) {
    if (!window.pdfjsLib) throw new Error("PDF parser not ready.");
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    let fullText = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      fullText += textContent.items.map(x => x.str).join(" ") + "\n";
    }
    return fullText;
  }
  if (name.endsWith(".docx")) {
    if (!window.mammoth) throw new Error("DOCX parser not ready.");
    const res = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return res.value;
  }
  return await file.text();
}

async function uploadResume(file) {
  $("msg").textContent = "Analyzing resume with AI…";
  try {
    const rawText = await extractTextFromFile(file);
    if (!rawText || rawText.trim().length < 30) {
      throw new Error("The file is empty or unreadable.");
    }

    const res = await fetch("/api/structure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: rawText })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Structuring failed");

    const id = crypto.randomUUID();
    await put("resumes", {
      id,
      text: rawText,
      data,
      filename: file.name,
      added: Date.now()
    });

    inspectedResumeId = id;
    await refreshResumes(id);
    $("msg").textContent = `Saved "${data.label}"!`;
    setTimeout(() => { if ($("msg").textContent.includes("Saved")) $("msg").textContent = ""; }, 4000);
  } catch (err) {
    $("msg").textContent = "Upload error: " + err.message;
  }
}

// Drag & Drop
const dropZone = $("drop");
dropZone.onclick = () => $("file").click();
$("file").onchange = e => e.target.files[0] && uploadResume(e.target.files[0]);
dropZone.onkeydown = e => (e.key === "Enter" || e.key === " ") && $("file").click();
dropZone.ondragover = e => { e.preventDefault(); dropZone.classList.add("over"); };
dropZone.ondragleave = () => dropZone.classList.remove("over");
dropZone.ondrop = e => {
  e.preventDefault();
  dropZone.classList.remove("over");
  if (e.dataTransfer.files[0]) uploadResume(e.dataTransfer.files[0]);
};

/* ==========================================================================
   Prompt Engine & Personas
   ========================================================================== */
function generateSystemPrompt(activeResume) {
  const persona = $("selPersona").value;
  const personaDirectives = {
    friendly: "You are a warm, encouraging, upbeat peer and interview coach. Speak enthusiastically, giving constructive advice.",
    senior: "You are a seasoned Senior VP / Hiring Manager. You evaluate strategic communication, leadership, and STAR-method responses.",
    tech: "You are a sharp Principal Engineer / Tech Lead. You probe technical architecture, trade-offs, and resume metrics deeply.",
    hr: "You are a professional Talent Partner evaluating culture fit, career motivations, and situational questions."
  };

  const personaInstruction = personaDirectives[persona] || personaDirectives.friendly;
  const list = resumes.map(r => `- ${r.data.label} (Role: ${r.data.role})${r.id === activeResume.id ? " <= [ACTIVE CANDIDATE]" : ""}`).join("\n");

  return `### SYSTEM ROLE
${personaInstruction}
You are speaking via real-time bidirectional voice call. Speak naturally, concisely, and punchily (1-3 sentences max per turn). Never output bullet lists to read aloud.

### MODES:
- CHAT: Warmup chat, motivations, casual prep.
- INTERVIEW: Realistic interview practice. Ask ONE question at a time.
- COACH: Critique candidate's last answer, give a model answer using STAR method.
- GRILL (HOTSPOTS): Directly probe the candidate's resume hotspots and weak spots.

Call 'set_mode' whenever switching mode. If user says goodbye or concludes, call 'end_interview'. Never mention tools aloud.

### GREETING:
Speak first. Give a friendly greeting acknowledging their target role (${activeResume.data.role || "the role"}), and invite them to begin.

ACTIVE CANDIDATE PROFILE:
${JSON.stringify(activeResume.data)}

RAW RESUME TEXT:
${activeResume.text.slice(0, 15000)}`;
}

/* ==========================================================================
   Audio Resampler & Worklet (Hardware Independent 16kHz)
   ========================================================================== */
const AUDIO_WORKLET_CODE = `
class ResamplingProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    this.port.postMessage({
      samples: input[0].slice(0),
      sampleRate: sampleRate
    });
    return true;
  }
}
registerProcessor("resampling-processor", ResamplingProcessor);
`;

function resampleAndEncodePCM(float32Array, inputSampleRate, targetSampleRate = 16000) {
  if (inputSampleRate === targetSampleRate) {
    const pcm16 = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return pcm16;
  }

  const ratio = inputSampleRate / targetSampleRate;
  const newLength = Math.round(float32Array.length / ratio);
  const pcm16 = new Int16Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const originIndex = i * ratio;
    const leftIndex = Math.floor(originIndex);
    const rightIndex = Math.min(leftIndex + 1, float32Array.length - 1);
    const fraction = originIndex - leftIndex;
    const sample = (1 - fraction) * float32Array[leftIndex] + fraction * float32Array[rightIndex];
    const s = Math.max(-1, Math.min(1, sample));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }

  return pcm16;
}

const bufferToBase64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

/* ==========================================================================
   Microphone & Playback Pipeline
   ========================================================================== */
async function startMic() {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });

  inCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (inCtx.state === "suspended") await inCtx.resume();

  const blob = new Blob([AUDIO_WORKLET_CODE], { type: "application/javascript" });
  const workletUrl = URL.createObjectURL(blob);
  await inCtx.audioWorklet.addModule(workletUrl);
  URL.revokeObjectURL(workletUrl);

  const sourceNode = inCtx.createMediaStreamSource(micStream);
  const workletNode = new AudioWorkletNode(inCtx, "resampling-processor");
  
  inAn = inCtx.createAnalyser();
  inAn.fftSize = 256;
  
  sourceNode.connect(inAn);
  sourceNode.connect(workletNode);

  workletNode.port.onmessage = (e) => {
    if (!session || isMuted) return;
    const { samples, sampleRate } = e.data;
    const pcm16 = resampleAndEncodePCM(samples, sampleRate, 16000);
    const base64Audio = bufferToBase64(pcm16.buffer);
    
    session.sendRealtimeInput({
      audio: {
        data: base64Audio,
        mimeType: "audio/pcm;rate=16000"
      }
    });
  };
}

function playAudioChunk(base64PCM) {
  if (!outCtx) return;
  const binaryString = atob(base64PCM);
  const sampleCount = binaryString.length >> 1;
  const audioBuffer = outCtx.createBuffer(1, sampleCount, 24000);
  const channelData = audioBuffer.getChannelData(0);

  for (let i = 0; i < sampleCount; i++) {
    const low = binaryString.charCodeAt(2 * i);
    const high = binaryString.charCodeAt(2 * i + 1);
    const int16 = ((high << 8) | low) << 16 >> 16;
    channelData[i] = int16 / 32768.0;
  }

  const source = outCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(outAn);

  const currentTime = outCtx.currentTime;
  nextAudioTime = Math.max(nextAudioTime, currentTime);
  source.start(nextAudioTime);
  nextAudioTime += audioBuffer.duration;

  activeSources.push(source);
  source.onended = () => {
    activeSources = activeSources.filter(s => s !== source);
  };
}

/* ==========================================================================
   Single Unified Live Conversation Feed
   ========================================================================== */
function handleTranscriptChunk(speaker, text) {
  if (!text) return;

  if (speaker !== lastSpeaker) {
    lastSpeaker = speaker;
    liveTranscript.push({ speaker, text: "", timestamp: Date.now() });
  }

  const currentEntry = liveTranscript[liveTranscript.length - 1];
  currentEntry.text += text;
  renderChatFeed();
}

function renderChatFeed() {
  const feed = $("transcriptFeed");
  if (!liveTranscript.length) {
    feed.innerHTML = `<div style="color: var(--text-mute); font-weight: 700; text-align: center; padding: 24px;">Your conversation will appear here in real-time as you speak…</div>`;
    return;
  }

  feed.innerHTML = liveTranscript.map(entry => `
    <div class="chat-bubble ${entry.speaker === 'you' ? 'you' : 'buddy'}">
      <span class="bubble-author">${entry.speaker === 'you' ? '👤 You' : '🦉 Interview Buddy'}</span>
      <span>${esc(entry.text)}</span>
    </div>
  `).join("");

  feed.scrollTop = feed.scrollHeight;
}

window.copyLiveTranscript = function() {
  if (!liveTranscript.length) return;
  const text = liveTranscript.map(t => `${t.speaker === 'you' ? 'Candidate' : 'Interviewer'}: ${t.text}`).join("\n\n");
  navigator.clipboard.writeText(text);
  $("msg").textContent = "Transcript copied to clipboard!";
  setTimeout(() => { if ($("msg").textContent.includes("copied")) $("msg").textContent = ""; }, 3000);
};

/* ==========================================================================
   Live Session Connection & Lifecycle
   ========================================================================== */
async function startSession() {
  const activeResume = resumes.find(r => r.id === $("selResume").value);
  if (!activeResume) {
    $("msg").textContent = "Please upload or select a resume first.";
    return;
  }

  $("start").disabled = true;
  $("msg").textContent = "Connecting to Gemini 3.8 Live Voice…";
  updateStatus("thinking", "Connecting…");

  try {
    const tokenRes = await fetch("/api/token", { method: "POST" });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.token) {
      throw new Error(tokenData.error || "Failed to generate token");
    }

    outCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
    if (outCtx.state === "suspended") await outCtx.resume();
    outAn = outCtx.createAnalyser();
    outAn.fftSize = 256;
    outAn.connect(outCtx.destination);
    nextAudioTime = outCtx.currentTime;

    const selectedVoice = $("selVoice").value || "Puck";
    const ai = new GoogleGenAI({ apiKey: tokenData.token, httpOptions: { apiVersion: "v1alpha" } });

    let lastLiveErr = null;
    for (const liveModel of LIVE_MODELS) {
      try {
        session = await ai.live.connect({
          model: liveModel,
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: selectedVoice }
              }
            },
            systemInstruction: generateSystemPrompt(activeResume),
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            contextWindowCompression: { slidingWindow: {} },
            tools: [{
              functionDeclarations: [
                {
                  name: "set_mode",
                  description: "Update the active practice mode",
                  parameters: {
                    type: "OBJECT",
                    properties: {
                      mode: { type: "STRING", enum: ["chat", "interview", "coach", "grill"] }
                    },
                    required: ["mode"]
                  }
                },
                {
                  name: "end_interview",
                  description: "Gracefully end the interview session"
                }
              ]
            }]
          },
          callbacks: {
            onmessage: handleServerMessage,
            onclose: () => stopSession(),
            onerror: (err) => {
              console.error("Live session error:", err);
              $("msg").textContent = "Live session connection error.";
              stopSession();
            }
          }
        });
        if (session) break;
      } catch (err) {
        lastLiveErr = err;
        console.warn(`Live model ${liveModel} failed, trying next:`, err);
      }
    }

    if (!session) {
      throw new Error("Could not connect to Live Audio API: " + (lastLiveErr?.message || "All models failed"));
    }

    await startMic();
    sessionStartTime = Date.now();
    liveTranscript = [];
    lastSpeaker = "";
    isMuted = false;
    renderChatFeed();

    // Trigger initial greeting
    session.sendClientContent({
      turns: [{ role: "user", parts: [{ text: "(The call connected. Please greet me warmly.)" }] }],
      turnComplete: true
    });

    $("start").hidden = true;
    $("end").hidden = false;
    $("muteBtn").hidden = false;
    $("msg").textContent = "";
    updateStatus("live", "Live Call");
  } catch (err) {
    console.error("Failed to start session:", err);
    $("msg").textContent = "Could not start session: " + err.message;
    updateStatus("ready");
    $("start").disabled = false;
    session = null;
  }
}

function handleServerMessage(message) {
  const content = message.serverContent;
  
  if (content?.interrupted) {
    activeSources.forEach(s => { try { s.stop(); } catch {} });
    activeSources = [];
    if (outCtx) nextAudioTime = outCtx.currentTime;
    updateStatus("live");
  }

  if (content?.modelTurn?.parts) {
    content.modelTurn.parts.forEach(part => {
      if (part.inlineData?.data) {
        playAudioChunk(part.inlineData.data);
      }
    });
  }

  if (content?.inputTranscription?.text) {
    handleTranscriptChunk("you", content.inputTranscription.text);
  }
  if (content?.outputTranscription?.text) {
    handleTranscriptChunk("buddy", content.outputTranscription.text);
  }

  if (message.toolCall?.functionCalls) {
    message.toolCall.functionCalls.forEach(fc => {
      if (fc.name === "set_mode" && fc.args?.mode) {
        currentMode = fc.args.mode;
        document.querySelectorAll(".mode-pill").forEach(btn => {
          btn.classList.toggle("active", btn.dataset.mode === currentMode);
        });
        updateStatus(session ? "live" : "ready", `Mode: ${currentMode.toUpperCase()}`);
      }

      session?.sendToolResponse({
        functionResponses: [{ id: fc.id, name: fc.name, response: { success: true } }]
      });

      if (fc.name === "end_interview") {
        setTimeout(stopSession, 5000);
      }
    });
  }
}

async function stopSession() {
  if (!session) return;
  const s = session;
  session = null;

  try { s.close(); } catch {}

  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }
  if (inCtx) { try { await inCtx.close(); } catch {} inCtx = null; }
  if (outCtx) { try { await outCtx.close(); } catch {} outCtx = null; }

  if (liveTranscript.length > 0) {
    const sessionRecord = {
      id: crypto.randomUUID(),
      date: sessionStartTime,
      durationSec: Math.max(1, Math.round((Date.now() - sessionStartTime) / 1000)),
      resumeId: activeResumeId,
      mode: currentMode,
      persona: $("selPersona").value,
      transcript: liveTranscript
    };
    await put("sessions", sessionRecord);
    $("msg").textContent = "Practice session saved in History!";
  }

  $("start").hidden = false;
  $("start").disabled = false;
  $("end").hidden = true;
  $("muteBtn").hidden = true;
  updateStatus("ready", "Ready");
  refreshResumes(activeResumeId);
}

function toggleMute() {
  isMuted = !isMuted;
  const btn = $("muteBtn");
  btn.classList.toggle("active", isMuted);
  $("micEmoji").textContent = isMuted ? "🔇" : "🎙️";
  updateStatus(isMuted ? "muted" : "live");
}

$("start").onclick = startSession;
$("end").onclick = stopSession;
$("muteBtn").onclick = toggleMute;

window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
  if (e.code === "Space" && session) {
    e.preventDefault();
    toggleMute();
  } else if (e.code === "Escape" && session) {
    e.preventDefault();
    stopSession();
  }
});

/* ==========================================================================
   Practice History View (Clean Duolingo Cards)
   ========================================================================== */
async function renderHistory() {
  const listEl = $("historyList");
  const sessions = (await all("sessions")).sort((a, b) => (b.date || 0) - (a.date || 0));

  if (!sessions.length) {
    listEl.innerHTML = `<p style="color: var(--text-mute); font-weight: 700; text-align: center; padding: 32px;">No sessions completed yet. Practice in the Studio tab!</p>`;
    return;
  }

  listEl.innerHTML = sessions.map(s => {
    const dateStr = new Date(s.date).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    const mins = Math.floor(s.durationSec / 60);
    const secs = s.durationSec % 60;
    const durationFormatted = `${mins > 0 ? mins + 'm ' : ''}${secs}s`;
    const turnsCount = Array.isArray(s.transcript) ? s.transcript.length : 0;

    return `
      <div class="history-card-item">
        <div class="history-meta-row">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="history-badge">⏱️ ${durationFormatted}</span>
            <span style="font-weight: 800; font-size: 0.9rem; color: var(--text);">🗓️ ${dateStr}</span>
          </div>
          <button class="btn-gray" style="padding: 4px 10px; font-size: 0.75rem; color: var(--red);" onclick="deleteSession('${s.id}')">🗑️ Delete</button>
        </div>
        <div style="font-size: 0.85rem; font-weight: 700; color: var(--text-secondary);">
          Mode: <strong style="color: var(--blue-shadow); text-transform: uppercase;">${s.mode || 'Chat'}</strong> · Persona: <strong>${s.persona || 'Coach'}</strong> · ${turnsCount} Exchanges
        </div>
        <details style="font-size: 0.88rem; font-weight: 600; color: var(--text);">
          <summary style="cursor: pointer; color: var(--blue); font-weight: 800; padding: 4px 0;">View Full Transcript</summary>
          <div style="background: #f8fafc; padding: 12px; border-radius: var(--radius-sm); margin-top: 8px; display: flex; flex-direction: column; gap: 8px; max-height: 200px; overflow-y: auto;">
            ${(s.transcript || []).map(t => `
              <div><strong style="color: ${t.speaker === 'you' ? 'var(--blue-shadow)' : 'var(--green-shadow)'};">${t.speaker === 'you' ? 'Candidate' : 'Buddy'}:</strong> ${esc(t.text)}</div>
            `).join('')}
          </div>
        </details>
        <div style="display: flex; gap: 8px; margin-top: 4px;">
          <button class="btn-blue" style="padding: 6px 14px; font-size: 0.8rem;" onclick="exportSession('${s.id}')">📋 Copy Transcript</button>
        </div>
      </div>
    `;
  }).join("");
}

window.deleteSession = async function(id) {
  await rm("sessions", id);
  await renderHistory();
  await updateStorageUtilization();
};

window.exportSession = async function(id) {
  const sessions = await all("sessions");
  const target = sessions.find(s => s.id === id);
  if (!target) return;
  const fullText = (target.transcript || []).map(t => `${t.speaker === 'you' ? 'Candidate' : 'Interviewer'}: ${t.text}`).join("\n\n");
  navigator.clipboard.writeText(fullText);
  $("msg").textContent = "Transcript copied to clipboard!";
  setTimeout(() => { if ($("msg").textContent.includes("copied")) $("msg").textContent = ""; }, 3000);
};

$("clearHistoryBtn").onclick = async () => {
  if (confirm("Clear all practice history?")) {
    await clearStore("sessions");
    await renderHistory();
    await updateStorageUtilization();
  }
};

/* ==========================================================================
   Voice Reactive Visualizer Canvas (Duolingo Playful Style)
   ========================================================================== */
const canvas = $("orb");
const ctx = canvas.getContext("2d");
const prefersReducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

function calculateAudioLevel(analyser) {
  if (!analyser) return 0;
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const val = data[i] - 128;
    sum += val * val;
  }
  return Math.min(1, Math.sqrt(sum / data.length) / 32);
}

let smoothedLevel = 0;
let animationPhase = 0;

function drawOrb() {
  const isBuddySpeaking = activeSources.length > 0;
  const isCandidateSpeaking = session && !isBuddySpeaking && !isMuted;
  const activeAnalyser = isBuddySpeaking ? outAn : (isCandidateSpeaking ? inAn : null);
  
  const rawLevel = session ? calculateAudioLevel(activeAnalyser) : 0;
  smoothedLevel += (rawLevel - smoothedLevel) * 0.2;
  animationPhase += prefersReducedMotion ? 0 : 0.04 + smoothedLevel * 0.15;

  ctx.clearRect(0, 0, 520, 520);

  // Colors: Duolingo Green for candidate, Sunny Yellow for Buddy, Sky Blue for idle
  let primaryColor = "88, 204, 2";     // #58cc02
  let secondaryColor = "70, 163, 2";   // #46a302

  if (isBuddySpeaking) {
    primaryColor = "255, 200, 0";      // #ffc800
    secondaryColor = "229, 165, 0";    // #e5a500
  } else if (!session) {
    primaryColor = "28, 176, 246";     // #1cb0f6
    secondaryColor = "24, 153, 214";   // #1899d6
  }

  const baseRadius = 80 + smoothedLevel * 45;

  // Draw 3 playful bouncing organic rings
  for (let ring = 0; ring < 3; ring++) {
    ctx.beginPath();
    const ringOffset = ring * 20;
    const waveCount = 3 + ring;

    for (let angle = 0; angle <= Math.PI * 2; angle += 0.05) {
      const bounce = Math.sin(angle * waveCount + animationPhase * (1 + ring * 0.4)) * (6 + smoothedLevel * 30) * (1 - ring * 0.2);
      const r = (baseRadius + ringOffset + bounce) * 1.25;
      const x = 260 + Math.cos(angle) * r;
      const y = 260 + Math.sin(angle) * r;

      if (angle === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }

    ctx.closePath();
    ctx.strokeStyle = `rgba(${secondaryColor}, ${0.9 - ring * 0.25})`;
    ctx.lineWidth = 4.5 - ring * 0.8;
    ctx.stroke();

    if (ring === 0) {
      ctx.fillStyle = `rgba(${primaryColor}, ${0.25 + smoothedLevel * 0.35})`;
      ctx.fill();
    }
  }

  requestAnimationFrame(drawOrb);
}

/* ==========================================================================
   Real-Time Client Storage Utilization (Exact IndexedDB Payload)
   ========================================================================== */
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

async function updateStorageUtilization() {
  try {
    let quotaBytes = 0;

    // Get browser quota ceiling
    if (navigator.storage && navigator.storage.estimate) {
      const estimate = await navigator.storage.estimate();
      quotaBytes = estimate.quota || 0;
    }

    // Measure exact client data payload (resumes + sessions)
    const resumesList = await all("resumes");
    const sessionsList = await all("sessions");

    let exactAppBytes = 0;

    // Calculate exact byte size for resumes
    for (const r of resumesList) {
      const textBytes = new Blob([r.text || ""]).size;
      const jsonBytes = new Blob([JSON.stringify(r.data || {})]).size;
      const metaBytes = new Blob([JSON.stringify({ id: r.id, filename: r.filename, added: r.added })]).size;
      exactAppBytes += textBytes + jsonBytes + metaBytes;
    }

    // Calculate exact byte size for sessions
    for (const s of sessionsList) {
      const turnBytes = new Blob([JSON.stringify(s.transcript || [])]).size;
      const metaBytes = new Blob([JSON.stringify({ id: s.id, date: s.date, durationSec: s.durationSec, mode: s.mode, persona: s.persona })]).size;
      exactAppBytes += turnBytes + metaBytes;
    }

    // If all items are deleted, exactAppBytes is strictly 0 B
    if (resumesList.length === 0 && sessionsList.length === 0) {
      exactAppBytes = 0;
    }

    const displayQuotaBytes = quotaBytes > 0 ? quotaBytes : (50 * 1024 * 1024 * 1024);
    const percentUsed = (exactAppBytes / displayQuotaBytes) * 100;
    const percentDisplay = exactAppBytes === 0 ? "0.00%" : (percentUsed < 0.01 ? "< 0.01%" : `${percentUsed.toFixed(2)}%`);

    const fillEl = $("storageBarFill");
    const usageEl = $("storageUsageText");
    const limitEl = $("storageLimitText");
    const resumePill = $("storageResumeCountPill");
    const sessionPill = $("storageSessionCountPill");

    if (fillEl) fillEl.style.width = exactAppBytes === 0 ? "0%" : `${Math.max(1, Math.min(100, percentUsed))}%`;
    if (usageEl) usageEl.textContent = `Used: ${formatBytes(exactAppBytes)} (${percentDisplay})`;
    if (limitEl) limitEl.textContent = `Quota Ceiling: ${formatBytes(displayQuotaBytes)}`;
    if (resumePill) resumePill.textContent = `📄 ${resumesList.length} Resume${resumesList.length === 1 ? '' : 's'}`;
    if (sessionPill) sessionPill.textContent = `🏆 ${sessionsList.length} Session${sessionsList.length === 1 ? '' : 's'}`;
  } catch (err) {
    console.warn("Storage estimate error:", err);
  }
}

// Hook storage updates into DB modifications
const originalRefreshResumes = refreshResumes;
refreshResumes = async function(preferredId) {
  await originalRefreshResumes(preferredId);
  await updateStorageUtilization();
};

// Initialize
drawOrb();
refreshResumes();
updateStorageUtilization();


