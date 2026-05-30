import React, { useState, useEffect, useRef } from "react";
import axios from "axios";
import "./App.css";

function stopCurrentVoice() {
  if (window.currentVoice) {
    try {
      window.currentVoice.pause();
      window.currentVoice.currentTime = 0;
    } catch (err) {
      console.warn("Failed to stop previous voice playback:", err);
    }
  }
  window.currentVoice = null;
}

// ─── PDF MODE COMPONENT ────────────────────────────────────────────────────────
function PdfMode({ status }) {
  const [file, setFile] = useState(null);
  const [question, setQuestion] = useState("");
  const [chatHistory, setChatHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [pdfReady, setPdfReady] = useState(false);
  const chatEndRef = useRef(null);
  const recognitionRef = useRef(null);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatHistory]);
  useEffect(() => () => { recognitionRef.current?.abort(); }, []);

  const startListening = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return alert("Use Chrome for voice input.");

    if (recognitionRef.current) {
      recognitionRef.current.abort();
      recognitionRef.current = null;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.continuous = false;

    recognition.onstart = () => setIsListening(true);
    recognition.onend = () => setIsListening(false);
    recognition.onresult = (e) => {
      const transcript = e.results[0][0].transcript;
      setQuestion(prev => prev ? `${prev} ${transcript}` : transcript);
    };
    recognition.onerror = (event) => {
      setIsListening(false);
      alert(`Voice recognition error: ${event.error}`);
    };

    recognitionRef.current = recognition;
    recognition.start();
  };

  const handleUpload = async () => {
    if (!file) return alert("Please select a PDF file.");
    const formData = new FormData();
    formData.append("pdfFile", file);
    try {
      setLoading(true);
      await axios.post("http://localhost:5001/upload", formData);
      setPdfReady(true);
      setChatHistory([{ role: "bot", text: "PDF analyzed! I'm ready to discuss it with you. What would you like to know?" }]);
    } catch {
      alert("Upload Error");
    } finally {
      setLoading(false);
    }
  };

  const handleAsk = async () => {
    if (!question.trim()) return;
    const userMsg = question.trim();
    setQuestion("");
    setChatHistory(prev => [...prev, { role: "user", text: userMsg }]);
    try {
      setLoading(true);
      const res = await axios.post("http://localhost:5001/ask", { question: userMsg });
      setChatHistory(prev => [...prev, { role: "bot", text: res.data.answer }]);
      if (res.data.audio) {
        stopCurrentVoice();
        const audio = new Audio(res.data.audio);
        window.currentVoice = audio;
        audio.play();
      }
    } catch {
      setChatHistory(prev => [...prev, { role: "bot", text: "Error connecting to AI." }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mode-layout">
      <div className="sidebar">
        <div className="sidebar-section">
          <div className="sidebar-section-title">
            <span className="sidebar-icon"></span> Document
          </div>
          <label className="file-label">
            <input type="file" accept=".pdf" onChange={(e) => { setFile(e.target.files[0]); setPdfReady(false); }} />
            <span className="file-btn">{file ? file.name.slice(0, 22) + (file.name.length > 22 ? "…" : "") : "Choose PDF…"}</span>
          </label>
          <button onClick={handleUpload} className="action-btn primary" disabled={loading || !file}>
            {loading ? <span className="spinner" /> : "Analyze PDF"}
          </button>
          {pdfReady && <div className="ready-badge">Ready to chat</div>}
        </div>

        <div className="sidebar-section">
          <div className="sidebar-section-title"><span className="sidebar-icon"></span> Voice</div>
          <button onClick={startListening} className={`action-btn voice-btn ${isListening ? "listening" : ""}`}>
            {isListening ? "Listening…" : "Start Voice"}
          </button>
        </div>

        <div className="connection-status" data-ok={status.includes("Connected")}>
          <span className="status-dot" /> {status}
        </div>
      </div>

      <div className="chat-main">
        <div className="chat-history">
          {chatHistory.length === 0 && (
            <div className="empty-state">
              <div className="empty-icon"></div>
              <div className="empty-title">No document loaded</div>
              <div className="empty-sub">Upload a PDF from the sidebar to begin your conversation.</div>
            </div>
          )}
          {chatHistory.map((msg, i) => (
            <div key={i} className={`msg ${msg.role}`}>
              {msg.role === "bot" && <span className="msg-avatar">AI</span>}
              <span className="msg-bubble">{msg.text}</span>
              {msg.role === "user" && <span className="msg-avatar">You</span>}
            </div>
          ))}
          <div ref={chatEndRef} />
        </div>

        <div className="input-area">
          <textarea
            placeholder={pdfReady ? "Ask about the PDF…" : "Upload a PDF first…"}
            value={question}
            disabled={!pdfReady && chatHistory.length === 0}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), handleAsk())}
          />
          <button className="send-btn" onClick={handleAsk} disabled={loading || !question.trim()}>
            {loading ? <span className="spinner" /> : "↑"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── ANALYSIS PROGRESS COMPONENT ──────────────────────────────────────────────
function AnalysisProgress({ steps, currentStep }) {
  return (
    <div className="analysis-progress">
      <div className="progress-title">Analyzing Video…</div>
      {steps.map((step, i) => (
        <div
          key={i}
          className={`progress-step ${i < currentStep ? "done" : i === currentStep ? "active" : "pending"}`}>
          <span className="step-icon">
            {i < currentStep ? "Done" : i === currentStep ? "…" : ""}
          </span>
          <span className="step-label">{step}</span>
        </div>
      ))}
    </div>
  );
}

// ─── VIDEO MODE COMPONENT ──────────────────────────────────────────────────────
function VideoMode({ status }) {
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [videoFile, setVideoFile] = useState(null);
  const [inputMode, setInputMode] = useState("youtube");
  const [question, setQuestion] = useState("");
  const [chatHistory, setChatHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [analysisStep, setAnalysisStep] = useState(-1); // -1 = not analyzing
  const [isListening, setIsListening] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [videoMeta, setVideoMeta] = useState(null);
  const chatEndRef = useRef(null);
  const recognitionRef = useRef(null);

  const ANALYSIS_STEPS = [
    "Fetching transcript…",
    "Downloading video frames…",
    "Running vision analysis (GPT-4o)…",
    "Building knowledge context…"
  ];

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatHistory]);
  useEffect(() => () => { recognitionRef.current?.abort(); }, []);

  const getYouTubeId = (url) => {
    const match = url.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
  };

  const youtubeId = getYouTubeId(youtubeUrl);

  const startListening = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return alert("Use Chrome for voice input.");

    if (recognitionRef.current) {
      recognitionRef.current.abort();
      recognitionRef.current = null;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.continuous = false;

    recognition.onstart = () => setIsListening(true);
    recognition.onend = () => setIsListening(false);
    recognition.onresult = (e) => {
      const transcript = e.results[0][0].transcript;
      setQuestion(prev => prev ? `${prev} ${transcript}` : transcript);
    };
    recognition.onerror = (event) => {
      setIsListening(false);
      alert(`Voice recognition error: ${event.error}`);
    };

    recognitionRef.current = recognition;
    recognition.start();
  };

  // Simulate step progression while waiting for backend
  const runStepTimer = () => {
    setAnalysisStep(0);
    const timings = [2000, 5000, 15000]; // rough step durations
    timings.forEach((delay, i) => {
      setTimeout(() => setAnalysisStep(i + 1), delay);
    });
  };

  const handleAnalyzeYoutube = async () => {
    if (!youtubeUrl.trim()) return alert("Please paste a YouTube URL.");
    if (!getYouTubeId(youtubeUrl)) return alert("Invalid YouTube URL.");
    try {
      setLoading(true);
      runStepTimer();
      const res = await axios.post("http://localhost:5001/analyze-video", { url: youtubeUrl }, { timeout: 120000 });
      setAnalysisStep(4); // all done
      setVideoMeta(res.data.meta);
      setVideoReady(true);

      const frameInfo = res.data.meta?.frameCount
        ? `I analyzed **${res.data.meta.frameCount} video frames** using computer vision`
        : "I analyzed the video content";
      const transcriptInfo = res.data.meta?.hasTranscript
        ? " and retrieved the full transcript."
        : " (no transcript was available, I relied on visual analysis).";

      setChatHistory([{
        role: "bot",
        text: `Video ready! ${frameInfo}${transcriptInfo} I can now answer questions about what's shown, said, and discussed in this video. What would you like to know?`
      }]);
    } catch (err) {
      setAnalysisStep(-1);
      alert("Analysis failed: " + (err.response?.data?.error || err.message));
    } finally {
      setLoading(false);
      setTimeout(() => setAnalysisStep(-1), 1000);
    }
  };

  const handleAnalyzeFile = async () => {
    if (!videoFile) return alert("Please select a video file.");
    const formData = new FormData();
    formData.append("videoFile", videoFile);
    try {
      setLoading(true);
      runStepTimer();
      const res = await axios.post("http://localhost:5001/analyze-video-file", formData, { timeout: 180000 });
      setAnalysisStep(4);
      setVideoMeta(res.data.meta);
      setVideoReady(true);
      const frameInfo = res.data.meta?.frameCount > 0
        ? `I extracted and analyzed **${res.data.meta.frameCount} frames** using GPT-4o vision.`
        : "I registered the video (frame extraction requires ffmpeg — install it for full vision support).";
      setChatHistory([{
        role: "bot",
        text: `"${videoFile.name}" is ready! ${frameInfo} Ask me anything about the video content!`
      }]);
    } catch {
      setAnalysisStep(-1);
      alert("Analysis failed. Make sure ffmpeg is installed for video file support.");
    } finally {
      setLoading(false);
      setTimeout(() => setAnalysisStep(-1), 1000);
    }
  };

  const handleAsk = async () => {
    if (!question.trim()) return;
    const userMsg = question.trim();
    setQuestion("");
    setChatHistory(prev => [...prev, { role: "user", text: userMsg }]);
    try {
      setLoading(true);
      const res = await axios.post("http://localhost:5001/ask-video", {
        question: userMsg,
        videoUrl: inputMode === "youtube" ? youtubeUrl : null,
      }, { timeout: 60000 });
      setChatHistory(prev => [...prev, { role: "bot", text: res.data.answer }]);
      if (res.data.audio) {
        stopCurrentVoice();
        const audio = new Audio(res.data.audio);
        window.currentVoice = audio;
        audio.play();
      }
    } catch {
      setChatHistory(prev => [...prev, { role: "bot", text: "Error connecting to AI." }]);
    } finally {
      setLoading(false);
    }
  };

  const resetVideo = () => {
    setVideoReady(false);
    setVideoMeta(null);
    setChatHistory([]);
    setYoutubeUrl("");
    setVideoFile(null);
    setAnalysisStep(-1);
  };

  return (
    <div className="mode-layout">
      {/* VIDEO SIDEBAR */}
      <div className="sidebar">
        <div className="sidebar-section">
          <div className="sidebar-section-title">
            <span className="sidebar-icon"></span> Video Source
          </div>
          <div className="toggle-group">
            <button
              className={`toggle-btn ${inputMode === "youtube" ? "active" : ""}`}
              onClick={() => { setInputMode("youtube"); resetVideo(); }}
            >YouTube</button>
            <button
              className={`toggle-btn ${inputMode === "file" ? "active" : ""}`}
              onClick={() => { setInputMode("file"); resetVideo(); }}
            >Upload</button>
          </div>
        </div>

        {/* YouTube input */}
        {inputMode === "youtube" && (
          <div className="sidebar-section">
            <div className="sidebar-section-title">YouTube URL</div>
            <input
              type="text"
              className="url-input"
              placeholder="https://youtube.com/watch?v=..."
              value={youtubeUrl}
              onChange={(e) => { setYoutubeUrl(e.target.value); setVideoReady(false); }}
            />
            {youtubeId && (
              <div className="yt-preview">
                <img src={`https://img.youtube.com/vi/${youtubeId}/mqdefault.jpg`} alt="thumbnail" />
              </div>
            )}
            <button
              onClick={handleAnalyzeYoutube}
              className="action-btn primary"
              disabled={loading || !youtubeUrl.trim()}
            >
              {loading ? <span className="spinner" /> : "Analyze Video"}
            </button>
          </div>
        )}

        {/* File input */}
        {inputMode === "file" && (
          <div className="sidebar-section">
            <div className="sidebar-section-title">Video File</div>
            <label className="file-label">
              <input type="file" accept="video/*" onChange={(e) => { setVideoFile(e.target.files[0]); setVideoReady(false); }} />
              <span className="file-btn">{videoFile ? videoFile.name.slice(0, 20) + "…" : "Choose video…"}</span>
            </label>
            <button
              onClick={handleAnalyzeFile}
              className="action-btn primary"
              disabled={loading || !videoFile}
            >
              {loading ? <span className="spinner" /> : "Analyze Video"}
            </button>
            <div className="hint" style={{ marginTop: 8 }}>
              Requires <code>ffmpeg</code> installed
            </div>
          </div>
        )}

        {/* Progress indicator during analysis */}
        {loading && analysisStep >= 0 && (
          <AnalysisProgress steps={ANALYSIS_STEPS} currentStep={analysisStep} />
        )}

        {/* Video ready badge + meta */}
        {videoReady && (
          <div className="ready-badge video-ready">
            <div>Ready to chat</div>
            {videoMeta?.frameCount > 0 && (
              <div className="meta-info">{videoMeta.frameCount} frames analyzed</div>
            )}
            {videoMeta?.hasTranscript && (
              <div className="meta-info">Transcript loaded</div>
            )}
            <button className="reset-btn" onClick={resetVideo}>Reset</button>
          </div>
        )}

        {/* Capability hints when no video loaded */}
        {!videoReady && !loading && (
          <div className="capability-hints">
            <div className="hint-title">AI can now SEE the video:</div>
            <div className="hint">Describe visual content & scenes</div>
            <div className="hint">Summarize what's said</div>
            <div className="hint">Identify people, objects, text</div>
            <div className="hint">Discuss themes & ideas</div>
            <div className="hint">Answer specific questions</div>
            <div className="hint">Explain charts, diagrams, slides</div>
          </div>
        )}

        {/* Voice */}
        <div className="sidebar-section">
          <div className="sidebar-section-title"><span className="sidebar-icon"></span> Voice</div>
          <button onClick={startListening} className={`action-btn voice-btn ${isListening ? "listening" : ""}`}>
            {isListening ? "Listening…" : "Start Voice"}
          </button>
        </div>

        <div className="connection-status" data-ok={status.includes("Connected")}>
          <span className="status-dot" /> {status}
        </div>
      </div>

      {/* VIDEO CHAT AREA */}
      <div className="chat-main">
        {videoReady && inputMode === "youtube" && youtubeId && (
          <div className="yt-embed-bar">
            <iframe
              src={`https://www.youtube.com/embed/${youtubeId}`}
              title="YouTube video"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </div>
        )}

        <div className="chat-history">
          {chatHistory.length === 0 && !loading && (
            <div className="empty-state">
              <div className="empty-icon"></div>
              <div className="empty-title">No video loaded</div>
              <div className="empty-sub">
                {inputMode === "youtube"
                  ? "Paste a YouTube URL in the sidebar, then click Analyze Video."
                  : "Upload a video file from the sidebar to begin."}
              </div>
              <div className="empty-sub" style={{ marginTop: 8, fontSize: "0.8rem", opacity: 0.6 }}>
                Analysis uses GPT-4o vision — the AI will actually <em>see</em> the video frames.
              </div>
            </div>
          )}
          {loading && analysisStep >= 0 && chatHistory.length === 0 && (
            <div className="empty-state">
              <div className="empty-icon" style={{ fontSize: "2rem" }}></div>
              <div className="empty-title">Analyzing video…</div>
              <div className="empty-sub">This may take 20–60 seconds. The AI is watching the video!</div>
            </div>
          )}
          {chatHistory.map((msg, i) => (
            <div key={i} className={`msg ${msg.role}`}>
              {msg.role === "bot" && <span className="msg-avatar">AI</span>}
              <span className="msg-bubble">{msg.text}</span>
              {msg.role === "user" && <span className="msg-avatar">You</span>}
            </div>
          ))}
          <div ref={chatEndRef} />
        </div>

        <div className="input-area">
          <textarea
            placeholder={
              loading && analysisStep >= 0
                ? "Analyzing video, please wait…"
                : videoReady
                  ? "Ask about the video… (e.g. 'What do you see in this video?')"
                  : "Analyze a video first…"
            }
            value={question}
            disabled={!videoReady || loading}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), handleAsk())}
          />
          <button className="send-btn" onClick={handleAsk} disabled={loading || !question.trim() || !videoReady}>
            {loading ? <span className="spinner" /> : "↑"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── ROOT APP ──────────────────────────────────────────────────────────────────
function App() {
  const [activeTab, setActiveTab] = useState("pdf");
  const [status, setStatus] = useState("Checking…");

  useEffect(() => {
    axios.get("http://localhost:5001/status")
      .then(() => setStatus("AI Connected"))
      .catch(() => setStatus("AI Offline"));
  }, []);

  return (
    <div className="app-container">
      <div className="top-nav">
        <div className="app-brand">
          <span className="brand-icon"></span>
          <span className="brand-name">Academic Voice Assistant</span>
        </div>
        <div className="tab-switcher">
          <button
            className={`tab-btn ${activeTab === "pdf" ? "active" : ""}`}
            onClick={() => setActiveTab("pdf")}
          >
            PDF Chat
          </button>
          <button
            className={`tab-btn ${activeTab === "video" ? "active" : ""}`}
            onClick={() => setActiveTab("video")}
          >
            Video Chat
          </button>
        </div>
        <div className="nav-spacer" />
        <button
          className="stop-btn"
          onClick={stopCurrentVoice}
          title="Stop speaker"
          style={{ marginLeft: 12 }}
        >
          Stop
        </button>
      </div>

      <div className="tab-content">
        {activeTab === "pdf"   && <PdfMode   status={status} />}
        {activeTab === "video" && <VideoMode status={status} />}
      </div>
    </div>
  );
}

export default App;
