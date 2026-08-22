import type { ModelDefinition } from '../../models/interfaces/model.interface.js';
import type { ModelReference } from '../utils/model-parser.js';

export type SelectionMode = 'weighted_random' | 'best' | 'top_n_random';

/**
 * Selection criteria for model choosing
 */
export interface SelectionCriteria {
  /**
   * Priority list of models to try (in order).
   * Each entry can specify an optional provider.
   * If empty, Smart Strategy is used.
   */
  models?: ModelReference[];

  /**
   * If true, fall back to Smart Strategy after exhausting `models`.
   * If false, go directly to paid fallback after `models` are exhausted.
   */
  allowAutoFallback?: boolean;

  /**
   * Tags filter. Supports OR logic for elements and AND logic via '&'.
   * Can be a string ("tag1, tag2&tag3") or array (["tag1", "tag2&tag3"]).
   */
  tags?: string | string[];

  /**
   * Model type filter
   */
  type?: 'fast' | 'reasoning';

  /**
   * Minimum context size required
   */
  minContextSize?: number;

  /**
   * Minimum max output tokens required
   */
  minMaxOutputTokens?: number;

  /**
   * JSON response support required
   */
  jsonResponse?: boolean;

  /**
   * Models to exclude (already tried)
   */
  excludeModels?: string[];

  /**
   * Prefer models with lowest latency
   */
  preferFast?: boolean;

  /**
   * Selection mode for smart strategy
   */
  selectionMode?: SelectionMode;

  /**
   * Minimum success rate for model selection (0-1)
   */
  minSuccessRate?: number;

  /**
   * Image input support required
   * If true, only select models that support image_url content
   */
  supportsImage?: boolean;

  /**
   * Video input support required
   * If true, only select models that support video content
   */
  supportsVideo?: boolean;

  /**
   * Audio input support required
   * If true, only select models that support audio content
   */
  supportsAudio?: boolean;

  /**
   * File/document input support required
   * If true, only select models that support file/document content
   */
  supportsFile?: boolean;

  /**
   * Tools/function calling support required
   * If true, only select models that support function calling and tool use
   */
  supportsTools?: boolean;
}

/**
 * Model with effective priority and weight after applying overrides
 */
export interface ModelWithEffectivePriority extends ModelDefinition {
  effectivePriority: number;
  effectiveWeight: number;
}

/**
 * Selection strategy interface
 */
export interface SelectionStrategy {
  /**
   * Select a model from the list based on criteria
   */
  select(_models: ModelDefinition[], _criteria: SelectionCriteria): ModelDefinition | null;
}
