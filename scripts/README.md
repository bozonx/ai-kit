# Fetch Models Script

## Overview

This script fetches and filters models from the OpenRouter API, outputting only suitable free LLM models that meet specific criteria.

## Usage

```bash
pnpm update-models
```

## What it does

1. **Fetches** all models from OpenRouter API (`https://openrouter.ai/api/v1/models`)
2. **Filters** models based on:
   - ✅ FREE pricing (prompt and completion costs are '0')
   - ✅ Text-based LLM only (excludes image/video/STT/embedding models)
   - ✅ Streaming support
   - ✅ Tools/function calling support
   - ✅ JSON response mode support
3. **Outputs** filtered results as JSON to stdout

## Output Format

```json
{
  "fetchedAt": "2025-12-18T10:00:00.000Z",
  "totalModels": 349,
  "filteredModels": 17,
  "models": [
    {
      "id": "meta-llama/llama-3.3-70b-instruct:free",
      "name": "Meta: Llama 3.3 70B Instruct",
      "contextLength": 131072,
      "maxOutputTokens": 4096,
      "pricing": {
        "prompt": "0",
        "completion": "0"
      },
      "architecture": {
        "modality": "text->text",
        "tokenizer": "llama3",
        "instruct_type": "llama3"
      }
    }
  ]
}
```

## Use Cases

1. **Manual inspection**: Run the script to see what free models are currently available
2. **Automated updates**: Use with the `update-models-prompt.md` to update `models.yaml`
3. **CI/CD integration**: Periodically check for new free models

## Filtering Logic

### Excluded Model Types
- Whisper (STT)
- DALL-E, Stable Diffusion, Midjourney (image generation)
- TTS/Speech models
- Video models
- Embedding models
- Moderation models

### Included Model Families
Models from these families are known to support tools and JSON:
- GPT-4, GPT-3.5
- Claude
- Gemini
- Llama 3
- Mistral, Mixtral
- Qwen
- DeepSeek
- Command

## Notes

- The script uses heuristics to determine tool and JSON support
- Vision support is detected separately and doesn't affect filtering
- All filtered models are assumed to support streaming
