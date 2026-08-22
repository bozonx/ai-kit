import axios from 'axios';
import yaml from 'js-yaml';

// ============================================================================
// CONSTANTS THAT NEED REGULAR UPDATES
// ============================================================================
// These constants should be reviewed and updated periodically as new models
// and capabilities are released. Update patterns to include new model families,
// versions, and language support as they become available.
// ============================================================================

// Tag Patterns - Use Cases
const USE_CASE_PATTERNS = {
    CODING: /code|coder|codestral|devstral|programming|kat-coder/,
    CREATIVE: /creative|story|writer|poet/,
    ANALYSIS: /analysis|analyst|research|deepresearch|data/,
    CHAT: /chat|assistant|instruct|conversational/,
    AGENTIC: /llama-3\.|gemini|claude|gpt-4|deepseek|qwen|command|agent/,
    ROLEPLAY: /roleplay|rp|character|storytelling/,
    UNCENSORED: /dolphin|hermes|uncensored|noufani|unholy|wizard/,
    TRANSLATION: /translate|translation|multilingual/,
    // Finance: reasoning models and strong analytical models (Tier 1-2)
    FINANCE: /gpt-4|claude-3|gemini.*pro|llama-3\.(1|3).*70b|deepseek.*r1|qwen.*72b|qwen.*110b|command-r-plus/,
} as const;

// Tag Patterns - Language Support
const LANGUAGE_PATTERNS = {
    ENGLISH: /llama-3|gemini|gpt-|claude|mistral|mixtral|qwen|deepseek|command|phi/,
    SPANISH: /llama-3|gemini|mistral|mixtral|command|gpt-|claude/,
    FRENCH: /llama-3|gemini|mistral|mixtral|command|gpt-|claude/,
    GERMAN: /llama-3|gemini|mistral|mixtral|command|gpt-|claude/,
    ITALIAN: /llama-3|gemini|mistral|mixtral|command|gpt-|claude/,
    PORTUGUESE: /llama-3|gemini|mistral|mixtral|command|gpt-|claude/,
    RUSSIAN: /deepseek|qwen|glm|tongyi|yandex|saiga|rugpt|llama-3|gemini|gpt-/,
    CHINESE: /qwen|glm|deepseek|tongyi|yi-|llama-3|gemini|gpt-|claude/,
    JAPANESE: /llama-3|gemini|gpt-|claude|qwen|deepseek|command/,
    KOREAN: /llama-3|gemini|gpt-|claude|qwen|deepseek|command/,
    VIETNAMESE: /llama-3|gemini|gpt-|claude|qwen|deepseek|command/,
    THAI: /llama-3|gemini|gpt-|claude|qwen|deepseek|command/,
    INDONESIAN: /llama-3|gemini|gpt-|claude|qwen|deepseek|command/,
    ARABIC: /llama-3|gemini|gpt-|claude|command|qwen/,
    HINDI: /llama-3|gemini|gpt-|claude|command|qwen/,
    TURKISH: /llama-3|gemini|gpt-|claude|mistral|mixtral|command/,
    POLISH: /llama-3|gemini|gpt-|claude|mistral|mixtral|command/,
    UKRAINIAN: /llama-3|gemini|gpt-|claude|mistral|mixtral|command/,
    CZECH: /llama-3|gemini|gpt-|claude|mistral|mixtral|command/,
    GREEK: /llama-3|gemini|gpt-|claude|mistral|mixtral|command/,
    SWEDISH: /llama-3|gemini|gpt-|claude|mistral|mixtral|command/,
    DUTCH: /llama-3|gemini|gpt-|claude|mistral|mixtral|command/,
} as const;

// Model Family Patterns
const MODEL_FAMILIES = {
    llama: /llama/,
    gemini: /gemini/,
    gemma: /gemma/,
    qwen: /qwen/,
    deepseek: /deepseek/,
    mistral: /mistral/,
    mixtral: /mixtral/,
    claude: /claude/,
    gpt: /gpt-/,
    phi: /phi-/,
    command: /command/,
    nemotron: /nemotron/,
    glm: /glm/,
    hermes: /hermes/,
    dolphin: /dolphin/,
    yi: /\byi-/,
    nova: /nova/,
    olmo: /olmo/,
} as const;

// Tools Support Heuristics
const TOOLS_SUPPORT_PATTERNS = [
    'gpt-',
    'claude-3',
    'gemini-',
    'llama-3',
    'mistral',
    'mixtral',
    'qwen',
    'deepseek',
    'command',
    'phi',
    'gemma',
    'nemotron',
] as const;

// JSON Support Heuristics (includes tools support + additional patterns)
const JSON_SUPPORT_ADDITIONAL_PATTERNS = [
    'instruct',
] as const;

// Reasoning Model Patterns
const REASONING_PATTERNS = [
    'reasoning',
    'r1',
    'think',
] as const;

// Tier 1 Models - Flagship top-tier models
// Patterns are designed to match current and future versions
const TIER_1_PATTERNS = [
    // GPT-4 and future versions (GPT-5, GPT-6, etc.)
    /gpt-[4-9]/,
    // Claude 3+ Opus/Sonnet and future versions
    /claude-[3-9][.\d]*-(opus|sonnet)/,
    // Gemini Pro/Ultra variants (current and future versions)
    /gemini-([1-9]\.?[0-9]*-)?(pro|ultra)/,
    // Llama 3+ large models (70B, 405B and larger)
    /llama-[3-9]\.?\d*-(70b|[1-9]\d{2}b)/,
    // Command R Plus
    /command-r-plus/,
    // DeepSeek V3 and future versions
    /deepseek-v[3-9]/,
    // Qwen 2.5+ large models (72B, 110B and larger)
    /qwen-[2-9]\.?\d*-(72b|110b|[1-9]\d{2}b)/,
] as const;

// Tier 2 Models - Strong mid-tier models
// Patterns are designed to match current and future versions
const TIER_2_PATTERNS = [
    // Llama 3+ small-medium models (8B, 13B, etc. but not 70B+)
    /llama-[3-9]\.?\d*-(8b|13b|[1-5]\d?b)(?!70b|405b)/,
    // Mistral Medium/Large/Nemo and future variants
    /mistral-(medium|large|nemo)/,
    // All Mixtral variants
    /mixtral/,
    // Qwen 2+ medium models (14B-32B range)
    /qwen-[2-9]\.?\d*-(14b|32b|[1-6]\d?b)(?!72b|110b)/,
    // Gemma 2+ 27B models
    /gemma-[2-9]\.?\d*-27b/,
    // Phi-3+ Medium and larger
    /phi-[3-9]\.?\d*-(medium|large)/,
    // DeepSeek V2.5 and similar mid-tier versions
    /deepseek-v2\.[5-9]/,
    // Command R (base version, not Plus)
    /command-r(?!-plus)/,
    // GLM-4 and future versions
    /glm-[4-9]/,
    // Nemotron (all variants)
    /nemotron/,
] as const;

// Model Status Patterns
const LATEST_MODEL_PATTERNS = [
    // Latest versions as of December 2024
    /llama-3\.3/,
    /gemini-2\.0/,
    /gpt-4o/,
    /claude-3\.7/,
    /deepseek-v3/,
    /qwen-2\.5/,
    /gemma-2/,
    /phi-4/,
    /glm-4/,
] as const;

const PREVIEW_PATTERNS = [
    /preview/,
    /experimental/,
    /beta/,
    /alpha/,
] as const;

const STABLE_PATTERNS = [
    // Exclude preview/experimental models from stable
    // Stable = not preview AND has been released for some time
] as const;

// Model Size Patterns (based on parameter count)
const SIZE_PATTERNS = {
    SMALL: /([1-9]b|1[0-4]b)(?!\d)/,  // 1B-14B
    MEDIUM: /(1[5-9]b|[2-6]\db)(?!\d)/,  // 15B-69B
    LARGE: /(7\db|[8-9]\db|[1-9]\d{2}b)/,  // 70B+
} as const;

// Context Size Thresholds
const LONG_CONTEXT_THRESHOLD = 500000;

// Minimum Token Requirements
const MIN_CONTEXT_SIZE = 8000;
const MIN_MAX_OUTPUT_TOKENS = 4000;

// ============================================================================
// STATIC CONFIGURATION CONSTANTS
// ============================================================================
// These constants rarely change and define the basic configuration
// ============================================================================

// API Configuration
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/models';

// Default Values
const DEFAULT_WEIGHT = 1;
const DEFAULT_CONTEXT_SIZE = 4096;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const FREE_MODEL_PRICE = 0;

// Output Configuration
const REQUIRED_OUTPUT_MODALITY = 'text';

// Supported Parameters
const SUPPORTED_PARAMS = {
    TOOLS: 'tools',
    TOOL_CHOICE: 'tool_choice',
    RESPONSE_FORMAT: 'response_format',
    STRUCTURED_OUTPUTS: 'structured_outputs',
} as const;

// Input Modalities
const INPUT_MODALITIES = {
    TEXT: 'text',
    IMAGE: 'image',
    VIDEO: 'video',
    AUDIO: 'audio',
    FILE: 'file',
} as const;

// Language Code Mapping
const LANGUAGE_CODES = {
    ENGLISH: 'en',
    SPANISH: 'es',
    FRENCH: 'fr',
    GERMAN: 'de',
    ITALIAN: 'it',
    PORTUGUESE: 'pt',
    RUSSIAN: 'ru',
    CHINESE: 'zh',
    JAPANESE: 'ja',
    KOREAN: 'ko',
    VIETNAMESE: 'vi',
    THAI: 'th',
    INDONESIAN: 'id',
    ARABIC: 'ar',
    HINDI: 'hi',
    TURKISH: 'tr',
    POLISH: 'pl',
    UKRAINIAN: 'uk',
    CZECH: 'cs',
    GREEK: 'el',
    SWEDISH: 'sv',
    DUTCH: 'nl',
} as const;

// Special Tags
const SPECIAL_TAGS = {
    VISION: 'vision',
} as const;

// Model Name Cleanup
const MODEL_NAME_SUFFIX_TO_REMOVE = ':free';

// Provider Configuration
const DEFAULT_PROVIDER = 'openrouter';
const FALLBACK_PROVIDER_PREFIX = 'other';

// Weight Tiers
const TIER_1_WEIGHT = 3;
const TIER_2_WEIGHT = 2;
const TIER_3_WEIGHT = 1;

interface OpenRouterModel {
    id: string;
    name: string;
    context_length: number;
    architecture?: {
        modality?: string;
        tokenizer?: string;
        instruct_type?: string;
        input_modalities?: string[];
        output_modalities?: string[];
    };
    pricing: {
        prompt: string;
        completion: string;
    };
    top_provider?: {
        max_completion_tokens?: number;
        is_moderated?: boolean;
    };
    supported_parameters?: string[];
}

interface FilteredModel {
    name: string;
    provider: string;
    model: string;
    type: 'fast' | 'reasoning';
    contextSize: number;
    maxOutputTokens: number;
    tags: string[];
    jsonResponse: boolean;
    available: boolean;
    weight: number;
    supportsImage?: boolean;
    supportsVideo?: boolean;
    supportsAudio?: boolean;
    supportsFile?: boolean;
    supportsTools?: boolean;
}

/**
 * Determine weight based on model tier
 * Tier 1 (weight 3): Flagship models - GPT-4, Claude 3 Opus/Sonnet, Gemini Pro/Ultra, Llama 3.1/3.3 70B+, etc.
 * Tier 2 (weight 2): Strong mid-tier models - Llama 3 8B, Mistral, Mixtral, Qwen 2.5 32B+, etc.
 * Tier 3 (weight 1): All other models
 */
function determineWeight(id: string): number {
    const lowerId = id.toLowerCase();

    // Check Tier 1 patterns
    for (const pattern of TIER_1_PATTERNS) {
        if (pattern.test(lowerId)) {
            return TIER_1_WEIGHT;
        }
    }

    // Check Tier 2 patterns
    for (const pattern of TIER_2_PATTERNS) {
        if (pattern.test(lowerId)) {
            return TIER_2_WEIGHT;
        }
    }

    // Default to Tier 3
    return TIER_3_WEIGHT;
}

/**
 * Extract simplified model name
 */
function extractName(id: string): string {
    const parts = id.split('/');
    const main = parts.length > 1 ? parts[1] : parts[0];
    return main.replace(MODEL_NAME_SUFFIX_TO_REMOVE, '');
}

/**
 * Detect use case tags based on model characteristics
 */
function detectUseCaseTags(id: string, modelName: string): string[] {
    const tags: string[] = [];
    const combined = `${id} ${modelName}`.toLowerCase();

    // Coding
    if (combined.match(USE_CASE_PATTERNS.CODING)) {
        tags.push('coding');
    } else {
        tags.push('not-coder');
    }

    // Creative writing
    if (combined.match(USE_CASE_PATTERNS.CREATIVE)) {
        tags.push('creative');
    }

    // Analysis & data
    if (combined.match(USE_CASE_PATTERNS.ANALYSIS)) {
        tags.push('analysis');
    }

    // Chat & assistants
    if (combined.match(USE_CASE_PATTERNS.CHAT)) {
        tags.push('chat');
    }

    // Agentic capabilities (models good at following complex instructions)
    if (combined.match(USE_CASE_PATTERNS.AGENTIC)) {
        tags.push('agentic');
    }

    // Roleplay
    if (combined.match(USE_CASE_PATTERNS.ROLEPLAY)) {
        tags.push('roleplay');
    }

    // Uncensored
    if (combined.match(USE_CASE_PATTERNS.UNCENSORED)) {
        tags.push('uncensored');
    }

    // Translation
    if (combined.match(USE_CASE_PATTERNS.TRANSLATION)) {
        tags.push('translation');
    }

    // Finance - models good for financial analysis, trading, market analysis
    // Includes reasoning models and strong analytical capabilities
    if (combined.match(USE_CASE_PATTERNS.FINANCE)) {
        tags.push('finance');
    }

    return tags;
}

/**
 * Detect language support tags for 15 major European and Asian languages
 * Returns tags like 'best-for-en', 'best-for-ru', 'best-for-zh', etc.
 */
function detectLanguageTags(id: string, modelName: string): string[] {
    const tags: string[] = [];
    const combined = `${id} ${modelName}`.toLowerCase();

    // English - most multilingual models
    if (combined.match(LANGUAGE_PATTERNS.ENGLISH)) {
        tags.push(`best-for-${LANGUAGE_CODES.ENGLISH}`);
    }

    // Spanish - major multilingual models
    if (combined.match(LANGUAGE_PATTERNS.SPANISH)) {
        tags.push(`best-for-${LANGUAGE_CODES.SPANISH}`);
    }

    // French - major multilingual models
    if (combined.match(LANGUAGE_PATTERNS.FRENCH)) {
        tags.push(`best-for-${LANGUAGE_CODES.FRENCH}`);
    }

    // German - major multilingual models
    if (combined.match(LANGUAGE_PATTERNS.GERMAN)) {
        tags.push(`best-for-${LANGUAGE_CODES.GERMAN}`);
    }

    // Italian - major multilingual models
    if (combined.match(LANGUAGE_PATTERNS.ITALIAN)) {
        tags.push(`best-for-${LANGUAGE_CODES.ITALIAN}`);
    }

    // Portuguese - major multilingual models
    if (combined.match(LANGUAGE_PATTERNS.PORTUGUESE)) {
        tags.push(`best-for-${LANGUAGE_CODES.PORTUGUESE}`);
    }

    // Russian - models with good Russian support
    if (combined.match(LANGUAGE_PATTERNS.RUSSIAN)) {
        tags.push(`best-for-${LANGUAGE_CODES.RUSSIAN}`);
    }

    // Chinese - Chinese and multilingual models
    if (combined.match(LANGUAGE_PATTERNS.CHINESE)) {
        tags.push(`best-for-${LANGUAGE_CODES.CHINESE}`);
    }

    // Japanese - multilingual models with Asian language support
    if (combined.match(LANGUAGE_PATTERNS.JAPANESE)) {
        tags.push(`best-for-${LANGUAGE_CODES.JAPANESE}`);
    }

    // Korean - multilingual models with Asian language support
    if (combined.match(LANGUAGE_PATTERNS.KOREAN)) {
        tags.push(`best-for-${LANGUAGE_CODES.KOREAN}`);
    }

    // Vietnamese - multilingual models with Asian language support
    if (combined.match(LANGUAGE_PATTERNS.VIETNAMESE)) {
        tags.push(`best-for-${LANGUAGE_CODES.VIETNAMESE}`);
    }

    // Thai - multilingual models with Asian language support
    if (combined.match(LANGUAGE_PATTERNS.THAI)) {
        tags.push(`best-for-${LANGUAGE_CODES.THAI}`);
    }

    // Indonesian - multilingual models
    if (combined.match(LANGUAGE_PATTERNS.INDONESIAN)) {
        tags.push(`best-for-${LANGUAGE_CODES.INDONESIAN}`);
    }

    // Arabic - multilingual models
    if (combined.match(LANGUAGE_PATTERNS.ARABIC)) {
        tags.push(`best-for-${LANGUAGE_CODES.ARABIC}`);
    }

    // Hindi - multilingual models with Indian language support
    if (combined.match(LANGUAGE_PATTERNS.HINDI)) {
        tags.push(`best-for-${LANGUAGE_CODES.HINDI}`);
    }

    // Turkish - multilingual models
    if (combined.match(LANGUAGE_PATTERNS.TURKISH)) {
        tags.push(`best-for-${LANGUAGE_CODES.TURKISH}`);
    }

    // Polish - European multilingual models
    if (combined.match(LANGUAGE_PATTERNS.POLISH)) {
        tags.push(`best-for-${LANGUAGE_CODES.POLISH}`);
    }

    // Ukrainian - European multilingual models
    if (combined.match(LANGUAGE_PATTERNS.UKRAINIAN)) {
        tags.push(`best-for-${LANGUAGE_CODES.UKRAINIAN}`);
    }

    // Czech - European multilingual models
    if (combined.match(LANGUAGE_PATTERNS.CZECH)) {
        tags.push(`best-for-${LANGUAGE_CODES.CZECH}`);
    }

    // Greek - European multilingual models
    if (combined.match(LANGUAGE_PATTERNS.GREEK)) {
        tags.push(`best-for-${LANGUAGE_CODES.GREEK}`);
    }

    // Swedish - European multilingual models
    if (combined.match(LANGUAGE_PATTERNS.SWEDISH)) {
        tags.push(`best-for-${LANGUAGE_CODES.SWEDISH}`);
    }

    // Dutch - European multilingual models
    if (combined.match(LANGUAGE_PATTERNS.DUTCH)) {
        tags.push(`best-for-${LANGUAGE_CODES.DUTCH}`);
    }

    return tags;
}

/**
 * Extract model family and version tags
 */
function extractFamilyTags(id: string, modelName: string): string[] {
    const tags: string[] = [];
    const combined = `${id} ${modelName}`.toLowerCase();

    for (const [family, pattern] of Object.entries(MODEL_FAMILIES)) {
        if (pattern.test(combined)) {
            tags.push(family);

            // Extract major version
            const versionMatch = combined.match(new RegExp(`${family}[\\s-]*(\\d+)`));
            if (versionMatch) {
                tags.push(`${family}-${versionMatch[1]}`);
            }
        }
    }

    return tags;
}

/**
 * Detect model status tags (latest, stable, preview)
 */
function detectStatusTags(id: string, modelName: string): string[] {
    const tags: string[] = [];
    const combined = `${id} ${modelName}`.toLowerCase();

    // Preview/Experimental
    if (PREVIEW_PATTERNS.some(pattern => combined.match(pattern))) {
        tags.push('preview');
        return tags; // Preview models are not stable
    }

    // Latest
    if (LATEST_MODEL_PATTERNS.some(pattern => combined.match(pattern))) {
        tags.push('latest');
    }

    // Stable (not preview and not latest)
    if (!tags.includes('latest')) {
        tags.push('stable');
    }

    return tags;
}

/**
 * Detect model size tags based on parameter count
 */
function detectSizeTags(id: string, modelName: string): string[] {
    const tags: string[] = [];
    const combined = `${id} ${modelName}`.toLowerCase();

    // Check for size patterns
    if (combined.match(SIZE_PATTERNS.SMALL)) {
        tags.push('small');
    } else if (combined.match(SIZE_PATTERNS.LARGE)) {
        tags.push('large');
        tags.push('not-small');
    } else if (combined.match(SIZE_PATTERNS.MEDIUM)) {
        tags.push('medium');
        tags.push('not-small');
    }

    return tags;
}

/**
 * Generate all tags for a model
 */
function generateTags(
    id: string,
    modelName: string,
    isReasoning: boolean,
    supportsImage: boolean,
    contextSize: number,
    maxOutputTokens: number,
    supportsTools: boolean,
    supportsJson: boolean
): string[] {
    const tags: string[] = [];

    // Add use case tags
    tags.push(...detectUseCaseTags(id, modelName));

    // Add language tags
    tags.push(...detectLanguageTags(id, modelName));

    // Add family tags
    tags.push(...extractFamilyTags(id, modelName));

    // Add tier tags based on weight
    const weight = determineWeight(id);
    if (weight === TIER_1_WEIGHT) {
        tags.push('tier-1');
        tags.push('tier-1-2');
    } else if (weight === TIER_2_WEIGHT) {
        tags.push('tier-2');
        tags.push('tier-1-2');
    } else {
        tags.push('tier-3');
    }

    // Add status tags
    tags.push(...detectStatusTags(id, modelName));

    // Add size tags
    const sizeTags = detectSizeTags(id, modelName);
    tags.push(...sizeTags);

    // Add "powerful" and "not-small" tags for models that are definitely not small
    if (sizeTags.includes('medium') || sizeTags.includes('large') || weight === TIER_1_WEIGHT) {
        tags.push('powerful');
        tags.push('not-small');
    }

    // Add vision tag if applicable
    if (supportsImage) {
        tags.push(SPECIAL_TAGS.VISION);
    }

    // Add long-context tag if both input and output meet threshold
    if (contextSize >= LONG_CONTEXT_THRESHOLD && maxOutputTokens >= LONG_CONTEXT_THRESHOLD) {
        tags.push('long-context');
    }

    // Add capabilities tags
    if (supportsTools) {
        tags.push('tools');
    }
    if (supportsJson) {
        tags.push('json-mode');
    }

    // Add capabilities tags
    if (supportsTools) {
        tags.push('tools');
    }
    if (supportsJson) {
        tags.push('json-mode');
    }

    // Remove duplicates and sort
    return [...new Set(tags)].sort();
}

async function fetchAndFilterModels() {
    try {
        const response = await axios.get(OPENROUTER_API_URL);
        const allModels: OpenRouterModel[] = response.data.data;

        // Filter models based on user requirements:
        // - output_modalities: [ "text" ] (text output only)
        // - support for: json output and tools
        // Modalities are set as parameters (supportsImage, supportsVideo, etc.)

        const filtered = allModels.filter(model => {
            // Must be free (standard for this project)
            const isFree = parseFloat(model.pricing.prompt) === FREE_MODEL_PRICE &&
                parseFloat(model.pricing.completion) === FREE_MODEL_PRICE;
            if (!isFree) return false;

            // Output modalities check
            const outputModalities = model.architecture?.output_modalities || [INPUT_MODALITIES.TEXT];

            // Output must be text only as requested
            if (!outputModalities.includes(REQUIRED_OUTPUT_MODALITY)) return false;

            // Filter only by minimum token requirements (if strictly needed, but we relaxed them)
            // We moved tools/json checks to tagging instead of filtering

            // Filter by minimum token requirements
            const contextSize = model.context_length || DEFAULT_CONTEXT_SIZE;
            const maxOutputTokens = model.top_provider?.max_completion_tokens || DEFAULT_MAX_OUTPUT_TOKENS;

            if (contextSize < MIN_CONTEXT_SIZE || maxOutputTokens < MIN_MAX_OUTPUT_TOKENS) {
                return false;
            }

            return true;
        });

        const mapped: FilteredModel[] = filtered.map(model => {
            const lowerId = model.id.toLowerCase();
            const isReasoning = REASONING_PATTERNS.some(pattern => lowerId.includes(pattern));

            const name = extractName(model.id);
            const inputModalities = model.architecture?.input_modalities || [INPUT_MODALITIES.TEXT];
            const supportsImage = inputModalities.includes(INPUT_MODALITIES.IMAGE);

            // Re-eval capabilities for tagging
            const supportsToolsHeuristic = (id: string) => {
                const lowerId = id.toLowerCase();
                return TOOLS_SUPPORT_PATTERNS.some(pattern => lowerId.includes(pattern));
            };

            const supportsJsonHeuristic = (id: string) => {
                const lowerId = id.toLowerCase();
                return supportsToolsHeuristic(id) ||
                    JSON_SUPPORT_ADDITIONAL_PATTERNS.some(pattern => lowerId.includes(pattern));
            };

            const supportsTools = model.supported_parameters?.includes(SUPPORTED_PARAMS.TOOLS) ||
                model.supported_parameters?.includes(SUPPORTED_PARAMS.TOOL_CHOICE) ||
                supportsToolsHeuristic(model.id);

            const supportsJson = model.supported_parameters?.includes(SUPPORTED_PARAMS.RESPONSE_FORMAT) ||
                model.supported_parameters?.includes(SUPPORTED_PARAMS.STRUCTURED_OUTPUTS) ||
                supportsJsonHeuristic(model.id);

            const result: FilteredModel = {
                name: name,
                provider: DEFAULT_PROVIDER,
                model: model.id,
                type: isReasoning ? 'reasoning' : 'fast',
                contextSize: model.context_length || DEFAULT_CONTEXT_SIZE,
                maxOutputTokens: model.top_provider?.max_completion_tokens || DEFAULT_MAX_OUTPUT_TOKENS,
                tags: generateTags(
                    model.id,
                    name,
                    isReasoning,
                    supportsImage,
                    model.context_length || DEFAULT_CONTEXT_SIZE,
                    model.top_provider?.max_completion_tokens || DEFAULT_MAX_OUTPUT_TOKENS,
                    supportsTools,
                    supportsJson
                ),
                jsonResponse: supportsJson,
                available: true,
                weight: determineWeight(model.id),
                supportsTools: supportsTools,
            };

            // Set multimodal support flags based on input_modalities
            if (inputModalities.includes(INPUT_MODALITIES.IMAGE)) {
                result.supportsImage = true;
            }
            if (inputModalities.includes(INPUT_MODALITIES.VIDEO)) {
                result.supportsVideo = true;
            }
            if (inputModalities.includes(INPUT_MODALITIES.AUDIO)) {
                result.supportsAudio = true;
            }
            if (inputModalities.includes(INPUT_MODALITIES.FILE)) {
                result.supportsFile = true;
            }

            return result;
        });

        // Group by provider prefix
        const grouped: Record<string, FilteredModel[]> = {};
        for (const model of mapped) {
            const providerPrefix = model.model.split('/')[0] || FALLBACK_PROVIDER_PREFIX;
            if (!grouped[providerPrefix]) grouped[providerPrefix] = [];
            grouped[providerPrefix].push(model);
        }

        // Sort providers and models
        const sortedProviders = Object.keys(grouped).sort();
        const finalModels: FilteredModel[] = [];

        for (const provider of sortedProviders) {
            const models = grouped[provider].sort((a, b) => a.name.localeCompare(b.name));
            finalModels.push(...models);
        }

        const output = {
            models: finalModels
        };

        // Output as YAML
        console.log(yaml.dump(output, { noRefs: true, indent: 2, lineWidth: -1 }));

    } catch (error) {
        console.error('Error fetching models:', error);
        process.exit(1);
    }
}

fetchAndFilterModels();
