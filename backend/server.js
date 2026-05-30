import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import OpenAI from "openai";
import { ChromaClient } from "chromadb";
import PDFParser from "pdf2json";
import 'dotenv/config';
 
// Ensure global fetch is available (Node 18+ has it; older Node can use node-fetch)
try {
  if (typeof fetch === 'undefined') {
    // top-level await is allowed in ESM; dynamically import node-fetch as a fallback
    const nf = await import('node-fetch').catch(() => null);
    if (nf && nf.default) global.fetch = nf.default;
  }
} catch (e) {
  console.warn('Could not polyfill fetch:', e?.message || e);
}

if (!process.env.OPENAI_API_KEY) {
  console.warn('⚠️ OPENAI_API_KEY is not set. OpenAI requests will fail until you set it.');
}

const execAsync = promisify(exec);
const app = express();
const upload = multer({ dest: 'uploads/' });

// ── OPENAI CONFIGURATION ─────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const chroma = new ChromaClient({
  host: process.env.CHROMA_HOST || "localhost",
  port: Number(process.env.CHROMA_PORT || 8000),
  ssl: process.env.CHROMA_SSL === "true" || false,
});
const VIDEO_COLLECTION_NAME = "video_context";
let currentVideoId = null;
let videoSegmentIds = [];

async function getVideoCollection() {
  return await chroma.getOrCreateCollection({ name: VIDEO_COLLECTION_NAME });
}

function chunkText(text, maxChunkSize = 800) {
  const chunks = [];
  let cursor = 0;

  while (cursor < text.length) {
    let end = cursor + maxChunkSize;
    if (end >= text.length) {
      chunks.push(text.slice(cursor).trim());
      break;
    }

    let splitPoint = text.lastIndexOf("\n", end);
    if (splitPoint <= cursor) splitPoint = text.lastIndexOf(" ", end);
    if (splitPoint <= cursor) splitPoint = end;

    chunks.push(text.slice(cursor, splitPoint).trim());
    cursor = splitPoint;
  }

  return chunks.filter(chunk => chunk.length > 20);
}

async function indexVideoContext(videoId, chunks) {
  const collection = await getVideoCollection();
  if (!chunks.length) return;

  if (videoSegmentIds.length) {
    try {
      await collection.delete({ ids: videoSegmentIds });
    } catch (error) {
      console.warn("⚠️ Failed to delete old video context segments:", error.message);
    }
  }

  const ids = chunks.map((_, index) => `${videoId}-${index}`);
  const embeddingResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: chunks.map(chunk => chunk.text),
  });

  const embeddings = embeddingResponse.data.map(item => item.embedding);
  await collection.add({
    ids,
    embeddings,
    documents: chunks.map(chunk => chunk.text),
    metadatas: chunks.map(chunk => chunk.metadata),
  });

  currentVideoId = videoId;
  videoSegmentIds = ids;
}

function buildVideoContextChunks({ id, title, url, transcript, visualDescription }) {
  const chunks = [];

  if (title || url) {
    const metadataText = [`Video ID: ${id}`];
    if (title) metadataText.push(`Title: ${title}`);
    if (url) metadataText.push(`URL: ${url}`);

    chunks.push({
      text: metadataText.join("\n"),
      metadata: { type: "metadata", videoId: id },
    });
  }

  if (transcript) {
    const transcriptChunks = chunkText(transcript, 900);
    transcriptChunks.forEach((chunk, index) => {
      chunks.push({
        text: `Transcript segment ${index + 1}:\n${chunk}`,
        metadata: { type: "transcript", index, videoId: id },
      });
    });
  }

  if (visualDescription) {
    chunks.push({
      text: `Visual analysis:\n${visualDescription}`,
      metadata: { type: "visual", videoId: id },
    });
  }

  return chunks;
}

async function retrieveRelevantVideoContext(question, nResults = 4) {
  const collection = await getVideoCollection();
  const embeddingResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: question,
  });

  const queryEmbedding = embeddingResponse.data[0].embedding;
  const queryResult = await collection.query({
    queryEmbeddings: [queryEmbedding],
    nResults,
    include: ["documents", "metadatas", "distances"],
  });

  const documents = queryResult.documents?.[0] ?? [];
  const metadatas = queryResult.metadatas?.[0] ?? [];

  return documents
    .map((doc, idx) => {
      if (!doc) return null;
      const meta = metadatas[idx];
      return `${meta?.type ? `[${meta.type}] ` : ""}${doc}`;
    })
    .filter(Boolean);
}

app.use(cors());
app.use(express.json());

// ── IN-MEMORY CONTEXT STORES ─────────────────────────────────────────
let pdfTextContent = "";
let videoContext   = "";     // transcript/description text
let videoFrames    = [];     // array of base64 JPEG strings (max 10 frames)
let videoMeta      = {};     // { title, source }

// Create uploads directory
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');
if (!fs.existsSync('./frames'))  fs.mkdirSync('./frames');

// ── Optional: youtube-transcript ──────────────────────────────────────
let YoutubeTranscript;
try {
  const mod = await import('youtube-transcript');
  YoutubeTranscript = mod.YoutubeTranscript;
} catch {
  console.warn("⚠️  youtube-transcript not installed. Run: npm install youtube-transcript");
}

// ── Optional: ytdl-core ───────────────────────────────────────────────
let ytdl;
try {
  const mod = await import('@distube/ytdl-core');
  ytdl = mod.default;
} catch {
  console.warn("⚠️  @distube/ytdl-core not installed. Run: npm install @distube/ytdl-core");
}

// ════════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════════

function extractYouTubeId(url) {
  const match = url.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

/**
 * Encode a local image file as base64
 */
function encodeImageToBase64(filePath) {
  return fs.readFileSync(filePath).toString('base64');
}

/**
 * Extract N evenly-spaced frames from a video file using ffmpeg.
 * Returns array of base64 JPEG strings.
 */
async function extractFramesFromFile(videoPath, numFrames = 8) {
  const framesDir = `./frames/${Date.now()}`;
  fs.mkdirSync(framesDir, { recursive: true });

  try {
    // Get video duration
    const { stdout } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`
    );
    const duration = parseFloat(stdout.trim());

    // Extract frames at even intervals
    const interval = duration / (numFrames + 1);
    const framePromises = [];

    for (let i = 1; i <= numFrames; i++) {
      const timestamp = (interval * i).toFixed(2);
      const outputPath = path.join(framesDir, `frame_${i}.jpg`);
      framePromises.push(
        execAsync(
          `ffmpeg -ss ${timestamp} -i "${videoPath}" -vframes 1 -q:v 2 -vf "scale=640:-1" "${outputPath}" -y`
        ).then(() => ({ timestamp, outputPath })).catch(() => null)
      );
    }

    const results = (await Promise.all(framePromises)).filter(Boolean);
    const frames = results
      .filter(r => fs.existsSync(r.outputPath))
      .map(r => ({
        timestamp: r.timestamp,
        base64: encodeImageToBase64(r.outputPath)
      }));

    // Cleanup frame files
    fs.rmSync(framesDir, { recursive: true, force: true });
    return frames;

  } catch (err) {
    fs.rmSync(framesDir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Download a YouTube video (low quality) and extract frames.
 * Falls back to thumbnail-only if ytdl is unavailable.
 */
async function extractYouTubeFrames(videoId, url) {
  if (!ytdl) {
    console.warn("ytdl not available — using thumbnail frames only.");
    return await extractFramesFromThumbnail(videoId);
  }

  const tmpPath = `./uploads/yt_${videoId}_${Date.now()}.mp4`;

  try {
    // Download lowest quality mp4 stream
    await new Promise((resolve, reject) => {
      const stream = ytdl(url, { quality: 'lowestvideo', filter: 'videoonly' });
      const file = fs.createWriteStream(tmpPath);
      stream.pipe(file);
      file.on('finish', resolve);
      file.on('error', reject);
      stream.on('error', reject);
    });

    const frames = await extractFramesFromFile(tmpPath, 8);
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    return frames;

  } catch (err) {
    console.warn("YouTube frame extraction failed:", err.message);
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    return await extractFramesFromThumbnail(videoId);
  }
}

/**
 * Fallback: fetch YouTube thumbnail and use it as a single "frame"
 */
async function extractFramesFromThumbnail(videoId) {
  try {
    const res = await fetch(`https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`);
    if (!res.ok) throw new Error('Thumbnail not found');
    const buffer = await res.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    return [{ timestamp: "0", base64 }];
  } catch {
    return [];
  }
}

/**
 * Ask GPT-4o vision to describe/analyze a set of frames.
 * Returns a detailed textual description.
 */
async function analyzeFramesWithVision(frames, extraContext = "") {
  if (frames.length === 0) return "No frames available for visual analysis.";

  // Build image content blocks
  const imageBlocks = frames.map((f, i) => ([
    {
      type: "text",
      text: `Frame ${i + 1}${f.timestamp ? ` (at ${f.timestamp}s)` : ''}:`
    },
    {
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${f.base64}`, detail: "high" }
    }
  ])).flat();

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 2000,
    messages: [
      {
        role: "system",
        content:
          "You are a video analysis expert. Analyze the provided video frames carefully. " +
          "Describe: what is happening visually, the setting/environment, people/objects present, " +
          "actions taking place, text visible on screen, mood/tone, and any other notable details. " +
          "Be thorough and educational. " +
          (extraContext ? `Additional context: ${extraContext}` : "")
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Please analyze these video frames in detail:" },
          ...imageBlocks
        ]
      }
    ]
  });

  return response.choices[0].message.content;
}

// ════════════════════════════════════════════════════════════════════
//  STATUS CHECK
// ════════════════════════════════════════════════════════════════════
app.get("/status", async (req, res) => {
  try {
    await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "ping" }],
    });
    res.json({ status: "SUCCESS", message: "OpenAI connected!" });
  } catch (err) {
    res.status(500).json({ status: "FAILED", error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════
//  PDF ROUTES
// ════════════════════════════════════════════════════════════════════
app.post("/upload", upload.single("pdfFile"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });

  const pdfParser = new PDFParser(null, 1);

  pdfParser.on("pdfParser_dataError", err => {
    console.error("PDF Parsing Error:", err);
    res.status(500).json({ error: "Could not parse PDF." });
  });

  pdfParser.on("pdfParser_dataReady", () => {
    pdfTextContent = pdfParser.getRawTextContent();
    console.log("✅ PDF analyzed.");
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.json({ success: true, message: "PDF processed successfully!" });
  });

  pdfParser.loadPDF(req.file.path);
});

app.post("/ask", async (req, res) => {
  const { question } = req.body;
  if (!pdfTextContent) return res.status(400).json({ answer: "Please upload a PDF first." });

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a helpful academic assistant in Voice Mode. Answer questions based ONLY on the provided document. " +
            "Speak naturally and concisely. Never say you cannot speak — your text is converted to audio automatically."
        },
        {
          role: "user",
          content: `DOCUMENT DATA:\n${pdfTextContent.substring(0, 10000)}\n\nQUESTION: ${question}`
        }
      ],
      temperature: 0.3,
    });

    const aiText = response.choices[0].message.content;
    const mp3 = await openai.audio.speech.create({ model: "tts-1", voice: "alloy", input: aiText });
    const base64Audio = Buffer.from(await mp3.arrayBuffer()).toString("base64");

    res.json({ answer: aiText, audio: `data:audio/mp3;base64,${base64Audio}` });
  } catch (err) {
    res.status(500).json({ answer: "OpenAI error: " + err.message });
  }
});

// ════════════════════════════════════════════════════════════════════
//  VIDEO ROUTES
// ════════════════════════════════════════════════════════════════════

/**
 * ANALYZE YOUTUBE — downloads frames + transcript → GPT-4o vision analysis
 */
app.post("/analyze-video", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "No URL provided." });

  const videoId = extractYouTubeId(url);
  if (!videoId) return res.status(400).json({ error: "Invalid YouTube URL." });

  try {
    console.log(`🎬 Starting analysis for video: ${videoId}`);

    // 1. Fetch transcript (if available)
    let transcript = "";
    if (YoutubeTranscript) {
      try {
        const transcriptArr = await YoutubeTranscript.fetchTranscript(videoId);
        transcript = transcriptArr.map(t => t.text).join(" ");
        console.log(`✅ Transcript fetched (${transcriptArr.length} segments)`);
      } catch (e) {
        console.warn("Transcript unavailable:", e.message);
      }
    }

    // 2. Extract frames (download video or fallback to thumbnail)
    console.log("🖼️  Extracting frames...");
    videoFrames = await extractYouTubeFrames(videoId, url);
    console.log(`✅ ${videoFrames.length} frames extracted`);

    // 3. Run vision analysis on frames
    console.log("🤖 Running vision analysis...");
    const visualDescription = await analyzeFramesWithVision(
      videoFrames,
      transcript ? `Transcript: ${transcript.substring(0, 3000)}` : ""
    );
    console.log("✅ Vision analysis complete");

    // 4. Store full context and index embeddings
    videoContext = [
      `YouTube Video ID: ${videoId}`,
      `URL: ${url}`,
      transcript ? `\n=== TRANSCRIPT ===\n${transcript.substring(0, 8000)}` : "\n(No transcript available)",
      `\n=== VISUAL ANALYSIS (from ${videoFrames.length} frames) ===\n${visualDescription}`
    ].join("\n");

    const chunks = buildVideoContextChunks({
      id: videoId,
      title: `YouTube Video (${videoId})`,
      url,
      transcript,
      visualDescription,
    });
    await indexVideoContext(videoId, chunks);

    videoMeta = {
      title: `YouTube Video (${videoId})`,
      thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      hasTranscript: !!transcript,
      frameCount: videoFrames.length,
      visualSummary: visualDescription.substring(0, 200) + "..."
    };

    res.json({ meta: videoMeta });

  } catch (err) {
    console.error("analyze-video error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * ANALYZE VIDEO FILE — extracts frames with ffmpeg → GPT-4o vision
 */
app.post("/analyze-video-file", upload.single("videoFile"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No video file uploaded." });

  const videoPath = req.file.path;
  const originalName = req.file.originalname;

  try {
    console.log(`🎬 Analyzing uploaded video: ${originalName}`);

    // Extract frames using ffmpeg
    console.log("🖼️  Extracting frames with ffmpeg...");
    videoFrames = await extractFramesFromFile(videoPath, 8);
    console.log(`✅ ${videoFrames.length} frames extracted`);

    // Vision analysis
    console.log("🤖 Running vision analysis...");
    const visualDescription = await analyzeFramesWithVision(videoFrames);
    console.log("✅ Vision analysis complete");

    videoContext = [
      `Uploaded Video: ${originalName}`,
      `Size: ${(req.file.size / 1024 / 1024).toFixed(2)} MB`,
      `\n=== VISUAL ANALYSIS (from ${videoFrames.length} frames) ===\n${visualDescription}`
    ].join("\n");

    const videoId = `uploaded-${Date.now()}`;
    const chunks = buildVideoContextChunks({
      id: videoId,
      title: originalName,
      url: "",
      transcript: "",
      visualDescription,
    });
    await indexVideoContext(videoId, chunks);

    videoMeta = {
      title: originalName,
      frameCount: videoFrames.length,
      visualSummary: visualDescription.substring(0, 200) + "..."
    };

    // Clean up uploaded video
    if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);

    res.json({ meta: videoMeta });

  } catch (err) {
    console.error("analyze-video-file error:", err.message);
    if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);

    // Fallback: store without frames
    videoContext = `Uploaded Video: ${originalName}\nNote: Frame extraction failed — ffmpeg may not be installed.`;
    res.json({ meta: { title: originalName, frameCount: 0 } });
  }
});

/**
 * VIDEO ASK — answers questions using vision context + optional frame re-inspection
 */
app.post("/ask-video", async (req, res) => {
  const { question } = req.body;

  if (!videoContext) {
    return res.status(400).json({ answer: "Please analyze a video first." });
  }
  if (!question?.trim()) {
    return res.status(400).json({ answer: "Please provide a question." });
  }

  try {
    const relevantContext = await retrieveRelevantVideoContext(question, 5);
    const contextSnippet = relevantContext.length
      ? relevantContext.join("\n\n---\n\n")
      : videoContext.substring(0, 12000);

    // Decide whether to include raw frames (for visual questions)
    const visualKeywords = /show|look|see|color|appear|visual|scene|frame|background|text on|wearing|object|person|face|gesture|slide|diagram|chart|graph|image/i;
    const includeFrames = visualKeywords.test(question) && videoFrames.length > 0;

    let messages;

    if (includeFrames) {
      // Send up to 4 frames alongside the question for direct visual inspection
      const selectedFrames = videoFrames.slice(0, 4);
      const imageBlocks = selectedFrames.map((f, i) => ({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${f.base64}`, detail: "high" }
      }));

      messages = [
        {
          role: "system",
          content:
            "You are an expert academic video assistant. You can SEE the video frames provided. " +
            "Use both the frames and the stored context to answer questions thoroughly. " +
            "Be educational, clear, and concise. Your text will be read aloud.\n\n" +
            `STORED VIDEO CONTEXT:\n${contextSnippet}`
        },
        {
          role: "user",
          content: [
            { type: "text", text: `Question about the video: ${question}` },
            { type: "text", text: "Here are video frames for reference:" },
            ...imageBlocks
          ]
        }
      ];
    } else {
      // Text-only — use stored analysis
      messages = [
        {
          role: "system",
          content:
            "You are an expert academic video assistant. Use the stored video analysis and transcript " +
            "to answer questions clearly, educationally, and concisely. " +
            "Your text will be read aloud — keep answers natural.\n\n" +
            `VIDEO CONTEXT:\n${contextSnippet}`
        },
        {
          role: "user",
          content: question
        }
      ];
    }

    const response = await openai.chat.completions.create({
      model: includeFrames ? "gpt-4o" : "gpt-4o-mini",
      messages,
      max_tokens: 800,
      temperature: 0.4,
    });

    const aiText = response.choices[0].message.content;

    // TTS
    const mp3 = await openai.audio.speech.create({
      model: "tts-1",
      voice: "alloy",
      input: aiText,
    });
    const base64Audio = Buffer.from(await mp3.arrayBuffer()).toString("base64");

    res.json({ answer: aiText, audio: `data:audio/mp3;base64,${base64Audio}` });

  } catch (err) {
    console.error("ask-video error:", err.message);
    res.status(500).json({ answer: "OpenAI error: " + err.message });
  }
});

// ════════════════════════════════════════════════════════════════════
//  START SERVER
// ════════════════════════════════════════════════════════════════════
const PORT = 5001;
app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
  console.log(`💡 Vision-powered video analysis ready!`);
});