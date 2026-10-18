import "dotenv/config";
import express from "express";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

// Most recent call result, kept in memory (lost when the server restarts).
let latest: {
  instrument: string | null;
  userText: string;
  conversationId: string;
} | null = null;

// One turn of the call transcript (only the fields we use).
type Turn = { role?: string; message?: string | null };

const webhookSecret = process.env.ELEVENLABS_WEBHOOK_SECRET;

if (!webhookSecret) {
  throw new Error("Set ELEVENLABS_WEBHOOK_SECRET in .env");
}

const elevenlabs = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY ?? "webhook-only",
});

const app = express();

// CORS for the app (phone/glasses webview) calling /api routes.
// Answers the preflight OPTIONS request that custom headers trigger.
app.use("/api", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, ngrok-skip-browser-warning"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

// Keep this route's raw body intact so signature verification works.
// Don't add express.json() before this route.
app.post(
  "/webhooks/elevenlabs",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.header("ElevenLabs-Signature");

    if (!signature || !Buffer.isBuffer(req.body)) {
      res.status(400).send("Missing signature or request body");
      return;
    }

    try {
      const event: any = await elevenlabs.webhooks.constructEvent(
        req.body.toString("utf8"),
        signature,
        webhookSecret
      );

      if (event.type === "post_call_transcription") {
        const { conversation_id, analysis } = event.data;
        const turns: Turn[] = event.data.transcript ?? [];

        // ElevenLabs' extracted value (identifier is case-insensitive here).
        const results = (analysis?.data_collection_results ?? {}) as Record<string, any>;
        const entry = Object.entries(results).find(
          ([key]) => key.toLowerCase() === "instrument"
        )?.[1];
        const instrument: string | null = entry?.value || null;

        // Everything the caller said, as a fallback for parseInstrument().
        const userText = turns
          .filter((t: Turn) => t.role === "user" && t.message)
          .map((t: Turn) => t.message as string)
          .join(" ");

        latest = { instrument, userText, conversationId: conversation_id };

        console.log("Conversation:", conversation_id);
        console.log("Instrument:", instrument);
        console.log("User said:", userText || "(nothing)");
        console.log("Summary:", analysis?.transcript_summary);
      }

      // A 2xx response tells ElevenLabs the webhook was received.
      res.status(200).json({ received: true });
    } catch (error) {
      console.error("Webhook signature check or processing failed:", error);
      res.status(401).send("Invalid webhook");
    }
  }
);

app.get("/", (_req, res) => {
  res.send("Webhook server is running");
});

// The app polls this to learn which instrument the caller said.
app.get("/api/latest-instrument", (_req, res) => {
  res.json(latest ?? { instrument: null, userText: "", conversationId: null });
});

app.post(
  "/api/transcribe",
  // Raise the limit if you send raw PCM/WAV for more than a few seconds.
  express.raw({ type: "audio/*", limit: "5mb" }),
  async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "no audio" });
      return;
    }
    if (!process.env.ELEVENLABS_API_KEY) {
      res.status(500).json({ error: "ELEVENLABS_API_KEY is not set" });
      return;
    }
    try {
      // Use whatever audio type the client actually sent.
      const contentType = req.header("content-type") ?? "audio/wav";
      const result = await elevenlabs.speechToText.convert({
        // Copy into a plain Uint8Array so newer TS typings accept it.
        file: new Blob([new Uint8Array(req.body)], { type: contentType }),
        modelId: "scribe_v1",
      });
      const text = (result as any).text ?? "";
      console.log("Heard:", text);
      res.json({ text });
    } catch (err) {
      console.error("Transcription failed:", err);
      res.status(502).json({ error: "transcription failed" });
    }
  }
);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Webhook server listening on http://localhost:${port}`);
});