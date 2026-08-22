/**
 * OpenAI-compatible function calling types
 * Based on OpenAI API specification
 */

/**
 * JSON Schema for function parameters
 */
export interface FunctionParameters {
  type: 'object';
  properties: Record<string, any>;
  required?: string[];
  [key: string]: any;
}

/**
 * Function definition for tool
 */
export interface ToolFunction {
  /**
   * Function name (must be a-z, A-Z, 0-9, underscores and dashes, max 64 chars)
   */
  name: string;

  /**
   * Description of what the function does
   */
  description?: string;

  /**
   * JSON Schema describing the function parameters
   */
  parameters?: FunctionParameters;
}

/**
 * Tool definition (currently only 'function' type is supported)
 */
export interface Tool {
  /**
   * Tool type (currently only 'function' is supported)
   */
  type: 'function';

  /**
   * Function definition
   */
  function: ToolFunction;
}

/**
 * Function call details in tool call
 */
export interface ToolCallFunction {
  /**
   * Function name
   */
  name: string;

  /**
   * Function arguments as JSON string
   */
  arguments: string;
}

/**
 * Tool call made by the model
 */
export interface ToolCall {
  /**
   * Unique identifier for the tool call
   */
  id: string;

  /**
   * Tool type (currently only 'function' is supported)
   */
  type: 'function';

  /**
   * Function call details
   */
  function: ToolCallFunction;
}

/**
 * Tool choice constraint
 * - 'auto': Model decides whether to call a function
 * - 'none': Model will not call any function
 * - Object: Force model to call specific function
 */
export type ToolChoice =
  | 'auto'
  | 'none'
  | {
      type: 'function';
      function: {
        name: string;
      };
    };
