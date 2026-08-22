# Free LLM Router n8n Node

n8n community node for [Free LLM Router Microservice](https://github.com/bozonx/free-llm-router-microservice).

This node provides a LangChain-compatible model interface that can be connected to the "Basic LLM Chain" and other LangChain nodes in n8n.

## Features

- 🤖 **LangChain Compatible** - Works seamlessly with Basic LLM Chain and other LangChain nodes
- 🔄 **Smart Model Selection** - Automatic model selection with Smart Strategy
- 🎯 **Priority Lists** - Define model priority lists for fallback
- 🏷️ **Advanced Filtering** - Filter models by tags, type, context size, and success rate
- 🛠️ **Function Calling** - Full support for OpenAI-compatible tools/function calling
- 🖼️ **Vision Support** - Send images along with text for multimodal analysis
- 🛡️ **Authentication** - Supports None, Basic Auth, and Bearer Token authentication
- ⚙️ **Full Control** - Access to all OpenAI-compatible parameters
- 📡 **Streaming Support** - Real-time response streaming with LangChain callbacks

## Installation

### Community Nodes (Recommended)

1. Go to **Settings** → **Community Nodes** in your n8n instance
2. Click **Install a community node**
3. Enter `n8n-nodes-bozonx-free-llm-router-microservice`
4. Click **Install**

### Manual Installation

```bash
cd ~/.n8n/nodes
npm install n8n-nodes-bozonx-free-llm-router-microservice
```

Restart your n8n instance after installation.

## Prerequisites

You need a running instance of the Free LLM Router Microservice. See the [main project README](https://github.com/bozonx/free-llm-router-microservice) for setup instructions.

Quick start with Docker:

```bash
git clone https://github.com/bozonx/free-llm-router-microservice.git
cd free-llm-router-microservice
cp config.yaml.example config.yaml
cp .env.production.example .env.production
# Edit .env.production to add your API keys
docker compose -f docker/docker-compose.yml up -d
```

## Setup

### 1. Create Credentials

1. In n8n, go to **Credentials** → **New**
2. Search for "Free LLM Router API"
3. Configure:
   - **Base URL**: Your microservice URL (e.g., `http://free-llm-router-microservice:8080`)
   - **Authentication**: Choose None, Basic Auth, or Bearer Token
   - Add credentials if using authentication

### 2. Add the Node to Your Workflow

1. Create or open a workflow
2. Add the **Free LLM Router Model** node
3. Connect it to a **Basic LLM Chain** or other LangChain node
4. Configure model selection and parameters

## Usage

### Model Selection Modes

#### Auto (Smart Strategy)
Let the router automatically select the best model based on:
- Model availability and health (Circuit Breaker)
- Priority and weight configuration
- Success rate and latency statistics
- Optional filters (tags, type, context size, etc.)

#### Specific Model
Choose a specific model by name:
- `llama-3.3-70b` - Any provider
- `openrouter/deepseek-r1` - Specific provider

#### Priority List
Provide comma-separated list of models to try in order:
- `openrouter/deepseek-r1, llama-3.3-70b, auto`
- Models are tried sequentially
- Add `auto` at the end to fallback to Smart Strategy

### Filter Options (Auto Mode)

When using Auto mode, you can filter models by:

- **Tags**: Filter by model capabilities (e.g., `code, reasoning`)
- **Type**: `fast` or `reasoning`
- **Minimum Context Size**: Required context window size
- **Prefer Fast**: Prioritize models with lowest latency
- **Minimum Success Rate**: Filter out unreliable models (0-1)

### Parameters

All standard OpenAI parameters are supported:

- **Temperature** (0-2): Controls randomness
- **Maximum Tokens**: Max tokens to generate
- **Top P** (0-1): Nucleus sampling parameter
- **Frequency Penalty** (-2 to 2): Reduces repetition
- **Presence Penalty** (-2 to 2): Encourages new topics
- **Timeout**: Request timeout in milliseconds

### Routing Options

Advanced routing parameters for fine-tuning request behavior:

- **Max Model Switches**: Maximum number of different models to try
- **Max Same Model Retries**: Maximum retries on the same model for temporary errors (429, network errors)
- **Retry Delay**: Delay between retries in milliseconds
- **Fallback Model**: Override fallback model in format `provider/model` (e.g., `deepseek/deepseek-chat` or `openrouter/deepseek-r1`). Applied only if fallback is enabled in microservice config. Provider is the first part before `/`, model can contain additional `/` characters.

## Example Workflows

### Simple Chat with Auto Selection

1. Add **Free LLM Router Model** node
   - Model Selection: Auto
   - Temperature: 0.7
   - Maximum Tokens: 1000

2. Add **Basic LLM Chain** node
   - Connect Free LLM Router to "model" input
   - Set your prompt

### Code Generation with Filtering

1. Add **Free LLM Router Model** node
   - Model Selection: Auto
   - Filter Options:
     - Tags: `code`
     - Type: `fast`
     - Prefer Fast: Yes

2. Connect to **Basic LLM Chain**

### Model Fallback Chain

1. Add **Free LLM Router Model** node
   - Model Selection: Priority List
   - Model Priority List: `openrouter/deepseek-r1, llama-3.3-70b, auto`

2. Connect to **Basic LLM Chain**

This will try DeepSeek R1 first, then Llama 3.3, then fall back to Smart Strategy.

### Function Calling with Tools

1. Add **Free LLM Router Model** node
   - Model Selection: Auto or specific model
   - Temperature: 0.7

2. Add **Tool** nodes (e.g., Calculator, Web Search)

3. Add **Agent** node
   - Connect Free LLM Router to "model" input
   - Connect Tools to "tools" input
   - Set your prompt

The model will automatically use `bindTools()` to enable function calling with the connected tools.

### Vision (Image Analysis)

The node supports vision-capable models (like `gemini-2.0-flash-exp`) for multimodal analysis.

**How to use:**

1. Add **Free LLM Router Model** node
2. Configure it to use a vision-capable model (e.g. filter by tag `vision` or select specific model)
3. Connect it to an **AI Agent** node in n8n
4. The AI Agent handles the user input (text + images) and passes it to the model

**Note:** Vision support works through the AI Agent interface in n8n. Ensure you select a model that supports vision (e.g., `gemini-2.0-flash-exp`).

**Available vision-capable models:**
- `gemini-2.0-flash-exp` (recommended, 1M tokens context, supports `vision` tag)
- `nemotron-nano-12b-v2-vl` (128K tokens context, supports `vision` tag)


## Response Metadata

All responses include router metadata in the `_router` field:

```json
{
  "_router": {
    "provider": "openrouter",
    "model_name": "llama-3.3-70b",
    "attempts": 1,
    "fallback_used": false,
    "errors": []
  }
}
```

## Troubleshooting

### Node not appearing in n8n

1. Check that the installation was successful
2. Restart your n8n instance
3. Clear browser cache

### Connection errors

1. Verify the Base URL in credentials
2. Check that the microservice is running: `curl http://your-service:8080/api/v1/health`
3. Verify authentication settings match your microservice configuration

### No models available

1. Check microservice logs
2. Verify `models.yaml` configuration
3. Check Circuit Breaker status via Admin API: `GET /api/v1/admin/state`

## Resources

- [Free LLM Router Microservice Documentation](https://github.com/bozonx/free-llm-router-microservice)
- [n8n Documentation](https://docs.n8n.io/)
- [LangChain Documentation](https://js.langchain.com/)

## License

[MIT](LICENSE)

## Support

For issues and questions:
- [GitHub Issues](https://github.com/bozonx/free-llm-router-microservice/issues)
- [n8n Community Forum](https://community.n8n.io/)
