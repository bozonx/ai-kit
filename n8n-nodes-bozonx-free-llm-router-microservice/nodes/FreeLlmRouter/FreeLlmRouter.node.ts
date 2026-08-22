import { ChatOpenAI, type ClientOptions } from '@langchain/openai';
import {
	type INodeType,
	type INodeTypeDescription,
	type SupplyData,
	type ISupplyDataFunctions,
	NodeConnectionTypes,
} from 'n8n-workflow';

/**
 * Free LLM Router node for n8n
 * Uses ChatOpenAI from @langchain/openai to ensure full n8n compatibility
 */
export class FreeLlmRouter implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Free LLM Router Chat Model',
		name: 'freeLlmRouter',
		icon: 'file:free-llm-router.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["model"]}}',
		description: 'Chat Model using Free LLM Router Microservice',
		defaults: {
			name: 'Free LLM Router Chat Model',
		},
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Language Models', 'Chat Models (Recommended)'],
			},
			resources: {
				primaryDocumentation: [
					{
						url: 'https://github.com/bozonx/free-llm-router-microservice/tree/main/n8n-nodes-bozonx-free-llm-router-microservice#readme',
					},
				],
			},
		},
		credentials: [
			{
				name: 'freeLlmRouterApi',
				required: true,
			},
		],
		// eslint-disable-next-line n8n-nodes-base/node-class-description-inputs-wrong-regular-node
		inputs: [],
		outputs: [NodeConnectionTypes.AiLanguageModel],
		outputNames: ['Chat Model'],
		properties: [
			// Model configuration
			{
				displayName: 'Model',
				name: 'model',
				type: 'string',
				default: 'auto',
				placeholder: 'auto',
				description:
					'Model selection. Options:<br>' +
					'• <b>auto</b> - Smart Strategy automatically selects the best model<br>' +
					'• <b>Specific model</b> - Enter model name (e.g., llama-3.3-70b or openrouter/deepseek-r1)<br>' +
					'• <b>Priority list</b> - Comma-separated models in priority order (e.g., "openrouter/deepseek-r1, llama-3.3-70b, auto")',
			},
			{
				displayName: 'Selection Mode',
				name: 'selectionMode',
				type: 'options',
				options: [
					{
						name: 'Weighted Random (Default)',
						value: 'weighted_random',
						description: 'Selects randomly based on weight (quality/speed score)',
					},
					{
						name: 'Best',
						value: 'best',
						description: 'Always selects the model with the highest score',
					},
					{
						name: 'Top N Random',
						value: 'top_n_random',
						description: 'Selects randomly among the top 3 best models',
					},
				],
				default: 'weighted_random',
				description: 'How to select the model from the filtered candidates',
			},

			// Model filtering
			{
				displayName: 'Tags',
				name: 'tags',
				type: 'string',
				default: '',
				placeholder: 'coding&tier-1, llama',
				description: 'Tags to filter models. Items separated by comma are combined with <b>OR</b>. Use <b>&</b> for <b>AND</b> within a group (e.g., "coding&tier-1, llama").',
			},
			{
				displayName: 'Type',
				name: 'type',
				type: 'options',
				options: [
					{
						name: 'Any',
						value: '',
					},
					{
						name: 'Fast',
						value: 'fast',
					},
					{
						name: 'Reasoning',
						value: 'reasoning',
					},
				],
				default: '',
				description: 'Filter models by type',
			},
			{
				displayName: 'JSON Response',
				name: 'jsonResponse',
				type: 'boolean',
				default: false,
				description:
					'Whether to request structured JSON output from the model. Filters for models that support JSON response format.',
			},

			// Advanced options
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Temperature',
						name: 'temperature',
						type: 'number',
						typeOptions: {
							numberPrecision: 1,
							minValue: 0,
							maxValue: 2,
							numberStepSize: 0.1,
						},
						default: 0.7,
						description: 'Controls randomness in the output. Higher values make output more random',
					},
					{
						displayName: 'Maximum Tokens',
						name: 'maxTokens',
						type: 'number',
						typeOptions: {
							minValue: 1,
							maxValue: 10000000,
						},
						default: 1000,
						description: 'Maximum number of tokens to generate in the response',
					},
					{
						displayName: 'Top P',
						name: 'topP',
						type: 'number',
						typeOptions: {
							numberPrecision: 2,
							minValue: 0,
							maxValue: 1,
							numberStepSize: 0.1,
						},
						default: 1,
						description:
							'Controls diversity via nucleus sampling. Lower values make output more focused',
					},
					{
						displayName: 'Frequency Penalty',
						name: 'frequencyPenalty',
						type: 'number',
						typeOptions: {
							numberPrecision: 1,
							minValue: -2,
							maxValue: 2,
							numberStepSize: 0.1,
						},
						default: 0,
						description:
							'Penalizes new tokens based on their frequency. Positive values decrease repetition',
					},
					{
						displayName: 'Presence Penalty',
						name: 'presencePenalty',
						type: 'number',
						typeOptions: {
							numberPrecision: 1,
							minValue: -2,
							maxValue: 2,
							numberStepSize: 0.1,
						},
						default: 0,
						description:
							'Penalizes new tokens based on their presence. Positive values encourage new topics',
					},
					{
						displayName: 'Filter: Minimum Context Size',
						name: 'filterMinContextSize',
						type: 'number',
						default: 0,
						description: 'Minimum context window size required for model filtering',
					},
					{
						displayName: 'Filter: Minimum Max Output Tokens',
						name: 'filterMinMaxOutputTokens',
						type: 'number',
						default: 0,
						description: 'Minimum maximum output tokens required for model filtering',
					},
					{
						displayName: 'Filter: Prefer Lowest Latency',
						name: 'filterPreferLowestLatency',
						type: 'boolean',
						default: false,
						description:
							'Whether to prefer models with lowest measured latency (based on real statistics)',
					},
					{
						displayName: 'Filter: Minimum Success Rate',
						name: 'filterMinSuccessRate',
						type: 'number',
						typeOptions: {
							numberPrecision: 2,
							minValue: 0,
							maxValue: 1,
							numberStepSize: 0.05,
						},
						default: 0,
						description: 'Minimum success rate for model selection (0-1)',
					},
					{
						displayName: 'Filter: Supports Image',
						name: 'filterSupportsImage',
						type: 'boolean',
						default: false,
						description: 'Whether to require models that support image input',
					},
					{
						displayName: 'Filter: Supports Video',
						name: 'filterSupportsVideo',
						type: 'boolean',
						default: false,
						description: 'Whether to require models that support video input',
					},
					{
						displayName: 'Filter: Supports Audio',
						name: 'filterSupportsAudio',
						type: 'boolean',
						default: false,
						description: 'Whether to require models that support audio input',
					},
					{
						displayName: 'Filter: Supports File',
						name: 'filterSupportsFile',
						type: 'boolean',
						default: false,
						description: 'Whether to require models that support file input',
					},
					{
						displayName: 'Filter: Supports Tools',
						name: 'filterSupportsTools',
						type: 'boolean',
						default: false,
						description: 'Whether to require models that support function calling and tool use',
					},
					{
						displayName: 'Routing: Provider Timeout (seconds)',
						name: 'timeout',
						type: 'number',
						typeOptions: {
							minValue: 1,
							maxValue: 600,
						},
						default: undefined,
						placeholder: '60',
						description:
							'Maximum time in seconds to wait for a response from a provider for a single attempt. Overrides microservice config value if set.',
					},
					{
						displayName: 'Routing: Max Model Switches',
						name: 'maxModelSwitches',
						type: 'number',
						typeOptions: {
							minValue: 1,
							maxValue: 10,
						},
						default: undefined,
						placeholder: '3',
						description:
							'Maximum number of model switches (trying different models) for this request. Overrides microservice config value if set.',
					},
					{
						displayName: 'Routing: Max Same Model Retries',
						name: 'maxSameModelRetries',
						type: 'number',
						typeOptions: {
							minValue: 0,
							maxValue: 10,
						},
						default: undefined,
						placeholder: '2',
						description:
							'Maximum retries on the same model for temporary errors (429, network errors) for this request. Overrides microservice config value if set.',
					},
					{
						displayName: 'Routing: Retry Delay (ms)',
						name: 'retryDelay',
						type: 'number',
						typeOptions: {
							minValue: 0,
							maxValue: 30000,
						},
						default: undefined,
						placeholder: '3000',
						description:
							'Delay between retries in milliseconds for this request. Overrides microservice config value if set.',
					},
					{
						displayName: 'Fallback Model',
						name: 'fallbackModel',
						type: 'string',
						default: '',
						placeholder: 'deepseek/deepseek-chat',
						description:
							'Fallback model in format "provider/model" (e.g., "deepseek/deepseek-chat" or "openrouter/deepseek-r1"). Applied only if fallback is enabled in microservice config. Provider is the first part before "/", model can contain additional "/" characters.',
					},
				],
			},
		],
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const credentials = await this.getCredentials('freeLlmRouterApi');
		const modelInput = (this.getNodeParameter('model', itemIndex) as string).trim();
		const options = this.getNodeParameter('options', itemIndex, {}) as {
			topP?: number;
			frequencyPenalty?: number;
			presencePenalty?: number;
			timeout?: number;
			temperature?: number;
			maxTokens?: number;
			filterMinContextSize?: number;
			filterMinMaxOutputTokens?: number;
			filterPreferLowestLatency?: boolean;
			filterMinSuccessRate?: number;
			filterSupportsImage?: boolean;
			filterSupportsVideo?: boolean;
			filterSupportsAudio?: boolean;
			filterSupportsFile?: boolean;
			filterSupportsTools?: boolean;
			maxModelSwitches?: number;
			maxSameModelRetries?: number;
			retryDelay?: number;
			fallbackModel?: string;
		};

		const temperature = options.temperature ?? 0.7;
		const maxTokens = options.maxTokens ?? 1000;

		// Get main-level filter parameters
		const tags = this.getNodeParameter('tags', itemIndex, '') as string;
		const type = this.getNodeParameter('type', itemIndex, '') as string;
		const jsonResponse = this.getNodeParameter('jsonResponse', itemIndex, false) as boolean;
		const selectionMode = this.getNodeParameter(
			'selectionMode',
			itemIndex,
			'weighted_random',
		) as string;

		// Build model kwargs (filter options) for Free LLM Router
		const modelKwargs: Record<string, unknown> = {};

		if (tags) {
			modelKwargs.tags = tags.split(',').map((t) => t.trim());
		}
		if (type) {
			modelKwargs.type = type;
		}
		if (selectionMode && selectionMode !== 'weighted_random') {
			modelKwargs.selection_mode = selectionMode;
		}

		if (options.filterMinContextSize !== undefined && options.filterMinContextSize > 0) {
			modelKwargs.min_context_size = options.filterMinContextSize;
		}
		if (options.filterMinMaxOutputTokens !== undefined && options.filterMinMaxOutputTokens > 0) {
			modelKwargs.min_max_output_tokens = options.filterMinMaxOutputTokens;
		}
		if (options.filterPreferLowestLatency) {
			modelKwargs.prefer_fast = options.filterPreferLowestLatency;
		}
		if (options.filterMinSuccessRate !== undefined && options.filterMinSuccessRate > 0) {
			modelKwargs.min_success_rate = options.filterMinSuccessRate;
		}
		if (options.filterSupportsImage) {
			modelKwargs.supports_image = true;
		}
		if (options.filterSupportsVideo) {
			modelKwargs.supports_video = true;
		}
		if (options.filterSupportsAudio) {
			modelKwargs.supports_audio = true;
		}
		if (options.filterSupportsFile) {
			modelKwargs.supports_file = true;
		}
		if (options.filterSupportsTools) {
			modelKwargs.supports_tools = true;
		}
		if (jsonResponse) {
			modelKwargs.response_format = { type: 'json_object' };
		}
		if (options.maxModelSwitches !== undefined && options.maxModelSwitches > 0) {
			modelKwargs.max_model_switches = options.maxModelSwitches;
		}
		if (options.maxSameModelRetries !== undefined && options.maxSameModelRetries >= 0) {
			modelKwargs.max_same_model_retries = options.maxSameModelRetries;
		}
		if (options.retryDelay !== undefined && options.retryDelay >= 0) {
			modelKwargs.retry_delay = options.retryDelay;
		}
		if (options.timeout !== undefined && options.timeout > 0) {
			modelKwargs.timeout_secs = options.timeout;
		}

		// Parse and apply fallback model if provided
		if (options.fallbackModel && options.fallbackModel.trim()) {
			const fallbackValue = options.fallbackModel.trim();
			const firstSlashIndex = fallbackValue.indexOf('/');

			if (firstSlashIndex > 0) {
				const fallbackProvider = fallbackValue.substring(0, firstSlashIndex);
				const fallbackModelName = fallbackValue.substring(firstSlashIndex + 1);

				if (fallbackProvider && fallbackModelName) {
					modelKwargs.fallback_provider = fallbackProvider;
					modelKwargs.fallback_model = fallbackModelName;
				}
			}
		}

		// Merge all router-specific parameters into modelKwargs
		const finalModelKwargs = Object.keys(modelKwargs).length > 0 ? modelKwargs : undefined;

		// Prepare authentication for ChatOpenAI
		let apiKey = 'not-needed';
		const requestHeaders: Record<string, string> = {};

		if (credentials.authentication === 'bearer') {
			apiKey = credentials.token as string;
		} else if (credentials.authentication === 'basic') {
			// For Basic Auth, we pass it via headers
			requestHeaders.Authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
			// LangChain/OpenAI SDK still needs an apiKey string to not throw error,
			// but our header will be sent in defaultHeaders.
			apiKey = 'basic-auth-used';
		}

		// Ensure baseURL includes /api/v1 as expected by the microservice
		let baseUrl = (credentials.baseUrl as string).replace(/\/+$/, '');
		if (!baseUrl.endsWith('/api/v1')) {
			baseUrl = `${baseUrl}/api/v1`;
		}

		// Configuration for ChatOpenAI to use Free LLM Router endpoint
		const configuration: ClientOptions = {
			baseURL: baseUrl,
			defaultHeaders: requestHeaders,
		};

		// Create ChatOpenAI instance pointing to Free LLM Router
		const model = new ChatOpenAI({
			apiKey: apiKey,
			model: modelInput || 'auto',
			temperature,
			maxTokens,
			topP: options.topP,
			frequencyPenalty: options.frequencyPenalty,
			presencePenalty: options.presencePenalty,
			timeout: 600000,
			maxRetries: 0,
			configuration,
			modelKwargs: finalModelKwargs,
		});

		return {
			response: model,
		};
	}
}
