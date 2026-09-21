import { openAiCompatibleSttAdapter, type VerboseTranscription } from './openai-compatible.js';

/**
 * Groq: whisper at a price that makes the free tier cost nothing worth counting.
 *
 * Batch only, and no speaker labels — which is why it is nominated for
 * `transcription` and never for `subtitles`. The catalog says so; this file
 * only has to be honest about what it can do. The wire format is OpenAI's, plus
 * two things of Groq's own: audio by URL, and a request id.
 */

interface GroqTranscription extends VerboseTranscription {
  x_groq?: { id?: string };
}

export const groqSttProvider = openAiCompatibleSttAdapter<GroqTranscription>({
  provider: 'groq',
  defaultBaseUrl: 'https://api.groq.com/openai/v1',
  acceptsUrl: true,
  requestId: response => response.x_groq?.id,
});
