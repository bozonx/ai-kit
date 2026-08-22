import type { ICredentialType, INodeProperties, Icon } from 'n8n-workflow';

/**
 * Credentials for Free LLM Router Microservice API
 */
export class FreeLlmRouterApi implements ICredentialType {
	name = 'freeLlmRouterApi';
	displayName = 'Free LLM Router API';
	documentationUrl =
		'https://github.com/bozonx/free-llm-router-microservice/tree/main/n8n-nodes-bozonx-free-llm-router-microservice#readme';
	icon = 'file:../nodes/FreeLlmRouter/free-llm-router.svg' as unknown as Icon;
	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'http://free-llm-router-microservice:8080',
			placeholder: 'https://llm-router.example.com',
			required: true,
			description: 'Base URL of the Free LLM Router microservice (without /api/v1)',
		},
		{
			displayName: 'Authentication',
			name: 'authentication',
			type: 'options',
			options: [
				{
					name: 'None',
					value: 'none',
				},
				{
					name: 'Basic Auth',
					value: 'basic',
				},
				{
					name: 'Bearer Token',
					value: 'bearer',
				},
			],
			default: 'none',
			description: 'Authentication method to use',
		},
		{
			displayName: 'Username',
			name: 'username',
			type: 'string',
			default: '',
			required: true,
			description: 'Username for Basic authentication',
			displayOptions: {
				show: {
					authentication: ['basic'],
				},
			},
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Password for Basic authentication',
			displayOptions: {
				show: {
					authentication: ['basic'],
				},
			},
		},
		{
			displayName: 'Token',
			name: 'token',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Bearer token for Authorization header',
			displayOptions: {
				show: {
					authentication: ['bearer'],
				},
			},
		},
	];

	authenticate: ICredentialType['authenticate'] = {
		type: 'generic',
		properties: {
			headers: {
				Authorization:
					'={{$credentials.authentication === "bearer" ? ("Bearer " + $credentials.token) : ($credentials.authentication === "basic" ? ("Basic " + Buffer.from($credentials.username + ":" + $credentials.password).toString("base64")) : undefined)}}',
			},
		},
	};

	test: ICredentialType['test'] = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/api/v1/health',
		},
	};
}
