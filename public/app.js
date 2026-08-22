// Configuration
function getApiBasePathFromLocation() {
    const pathname = (window.location.pathname || '/').replace(/\/+/g, '/');
    const uiMatch = pathname.match(/(^|\/)ui(\/|$)/);

    if (uiMatch && typeof uiMatch.index === 'number') {
        const prefix = pathname.slice(0, uiMatch.index);
        const normalizedPrefix = prefix.replace(/\/+$/, '');
        return `${normalizedPrefix}/api/v1` || '/api/v1';
    }

    if (pathname === '/' || pathname === '') return '/api/v1';

    const normalizedPathname = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
    const lastSlashIndex = normalizedPathname.lastIndexOf('/');
    const base = lastSlashIndex >= 0 ? normalizedPathname.slice(0, lastSlashIndex) : '';
    return `${base}/api/v1` || '/api/v1';
}

const API_BASE_PATH = getApiBasePathFromLocation();

const REFRESH_INTERVAL = 5000; // 5 seconds
let refreshTimer = null;
let currentTab = 'overview';
let currentModelSort = localStorage.getItem('modelSort') || 'default';
let cachedModels = [];
let activeTagFilters = [];

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    initializeTabs();
    initializeRefreshButtons();
    initializeModelsSort();
    initializeFilterIndicator();
    initializeTester();
    loadAllData();
});

// Tab Management
function initializeTabs() {
    const tabButtons = document.querySelectorAll('.tab-button');

    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            const tabName = button.getAttribute('data-tab');
            switchTab(tabName);
        });
    });
}

function switchTab(tabName) {
    // Update buttons
    document.querySelectorAll('.tab-button').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-tab') === tabName);
    });

    // Update content
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.toggle('active', content.id === `tab-${tabName}`);
    });

    currentTab = tabName;

    // Load data for specific tab
    if (tabName === 'overview') {
        loadMetrics();
    } else if (tabName === 'models') {
        loadModels();
    } else if (tabName === 'rate-limits') {
        loadRateLimits();
    }
}

// Refresh Buttons
function initializeRefreshButtons() {
    document.getElementById('refresh-metrics')?.addEventListener('click', loadMetrics);
    document.getElementById('refresh-models')?.addEventListener('click', () => loadModels());
    document.getElementById('refresh-rate-limits')?.addEventListener('click', loadRateLimits);
}

// Models Sort
function initializeModelsSort() {
    const sortSelect = document.getElementById('model-sort');
    if (!sortSelect) return;

    sortSelect.value = currentModelSort;

    sortSelect.addEventListener('change', (e) => {
        currentModelSort = e.target.value;
        localStorage.setItem('modelSort', currentModelSort);
        if (cachedModels.length > 0) {
            displayModels(cachedModels);
        }
    });
}

function initializeFilterIndicator() {
    const clearBtn = document.getElementById('clear-filter');
    if (clearBtn) {
        clearBtn.addEventListener('click', clearTagFilter);
    }
}

// Load All Data
async function loadAllData() {
    await Promise.all([
        checkHealth(),
        loadMetrics(),
    ]);
}

// Health Check
async function checkHealth() {
    try {
        const response = await fetch(`${API_BASE_PATH}/health`);
        const isHealthy = response.ok;

        updateServiceStatus(isHealthy);
    } catch (error) {
        console.error('Health check failed:', error);
        updateServiceStatus(false);
    }
}

function updateServiceStatus(isHealthy) {
    const statusElement = document.getElementById('service-status');
    const dotElement = statusElement?.querySelector('.status-dot');
    const textElement = statusElement?.querySelector('span:last-child');

    if (dotElement && textElement) {
        if (isHealthy) {
            dotElement.classList.remove('error');
            textElement.textContent = 'Online';
        } else {
            dotElement.classList.add('error');
            textElement.textContent = 'Offline';
        }
    }
}

// Load Metrics
async function loadMetrics() {
    try {
        const response = await fetch(`${API_BASE_PATH}/admin/metrics`);

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const metrics = await response.json();
        updateMetrics(metrics);
        updateLastUpdate();
    } catch (error) {
        console.error('Failed to load metrics:', error);
    }
}

function updateMetrics(metrics) {
    // Update simple metrics
    document.getElementById('total-requests').textContent = formatNumber(metrics.totalRequests || 0);
    document.getElementById('successful-requests').textContent = formatNumber(metrics.successfulRequests || 0);
    document.getElementById('failed-requests').textContent = formatNumber(metrics.failedRequests || 0);
    document.getElementById('avg-latency').innerHTML = `${formatNumber(metrics.avgLatency || 0)}<span class="unit">ms</span>`;
    document.getElementById('fallbacks-used').textContent = formatNumber(metrics.fallbacksUsed || 0);

    // Update models status
    document.getElementById('models-available').textContent = formatNumber(metrics.modelsAvailable || 0);
    document.getElementById('models-open').textContent = formatNumber(metrics.modelsInOpenState || 0);
    document.getElementById('models-unavailable').textContent = formatNumber(metrics.modelsPermanentlyUnavailable || 0);

    // Update uptime
    document.getElementById('uptime').textContent = formatUptime(metrics.uptime || 0);
}

// Load Models State
async function loadModels() {
    const container = document.getElementById('models-list');

    if (!container) return;

    container.innerHTML = '<div class="loading-state">Loading models...</div>';
    activeTagFilters = [];
    updateFilterIndicator();

    try {
        const response = await fetch(`${API_BASE_PATH}/admin/state`);

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        cachedModels = data.models || [];
        displayModels(cachedModels);
        updateLastUpdate();
    } catch (error) {
        console.error('Failed to load models:', error);
        container.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">⚠️</span>
        <p>Failed to load models. Please try again.</p>
      </div>
    `;
    }
}

function displayModels(models) {
    const container = document.getElementById('models-list');

    if (!container) return;

    if (models.length === 0) {
        container.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">📭</span>
        <p>No models found.</p>
      </div>
    `;
        return;
    }

    let filteredModels = [...models];
    if (activeTagFilters.length > 0) {
        filteredModels = filteredModels.filter(m =>
            activeTagFilters.some(tag => m.tags && m.tags.includes(tag))
        );
    }

    const sortedModels = sortModels(filteredModels, currentModelSort);

    if (sortedModels.length === 0 && activeTagFilters.length > 0) {
        container.innerHTML = `
            <div class="empty-state">
                <span class="empty-icon">🔍</span>
                <p>No models found with tags: ${activeTagFilters.map(t => `"${escapeHtml(t)}"`).join(', ')}.</p>
                <button class="refresh-button" onclick="clearTagFilter()" style="margin-top: 1rem;">Clear All Filters</button>
            </div>
        `;
        return;
    }

    container.innerHTML = sortedModels.map(model => `
    <div class="model-card">
      <div class="model-header">
        <div class="model-info">
          <div class="model-title-row">
            <h3>${escapeHtml(model.name)}</h3>
            <div class="model-type-badge ${model.type === 'reasoning' ? 'reasoning' : ''}">${model.type || 'fast'}</div>
          </div>
          <div class="model-provider">${escapeHtml(model.provider || 'Unknown')} / ${escapeHtml(model.model)}</div>
          
          <div class="capabilities-list">
             <span class="capability-badge supported" title="Text Generation">📝</span>
             <span class="capability-badge ${model.supportsImage ? 'supported' : ''}" title="Image Input">🖼️</span>
             <span class="capability-badge ${model.supportsVideo ? 'supported' : ''}" title="Video Input">🎥</span>
             <span class="capability-badge ${model.supportsAudio ? 'supported' : ''}" title="Audio Input">🎤</span>
             <span class="capability-badge ${model.supportsFile ? 'supported' : ''}" title="File Input">📄</span>
             <span class="capability-badge ${model.jsonResponse ? 'supported' : ''}" title="JSON Mode">{}</span>
          </div>

          ${renderTags(model.tags)}
        </div>
        <div class="circuit-badge ${getCircuitClass(model.circuitState)}">
          ${getCircuitIcon(model.circuitState)} ${escapeHtml(model.circuitState || 'UNKNOWN')}
        </div>
      </div>
      <div class="model-stats">
        <div class="stat-item">
          <div class="stat-item-label">Weight</div>
          <div class="stat-item-value">${model.weight || 1}</div>
        </div>
        <div class="stat-item">
            <div class="stat-item-label">Context</div>
            <div class="stat-item-value">${formatBytes(model.contextSize)}</div>
        </div>
        <div class="stat-item">
          <div class="stat-item-label">Success Rate</div>
          <div class="stat-item-value">${calculateSuccessRate(model.stats)}%</div>
        </div>
        <div class="stat-item">
          <div class="stat-item-label">Avg Latency</div>
          <div class="stat-item-value">${formatNumber(model.stats?.avgLatency || 0)} ms</div>
        </div>
        <div class="stat-item">
          <div class="stat-item-label">Requests</div>
          <div class="stat-item-value">${formatNumber(model.stats?.lifetimeTotalRequests || 0)}</div>
        </div>
      </div>
    </div>
    `).join('');

    // Add event listeners to tags
    container.querySelectorAll('.tag').forEach(tagEl => {
        tagEl.style.cursor = 'pointer';
        tagEl.addEventListener('click', (e) => {
            e.preventDefault();
            const tag = e.target.textContent;
            applyTagFilter(tag);
        });
    });
}

function applyTagFilter(tag) {
    if (activeTagFilters.includes(tag)) {
        activeTagFilters = activeTagFilters.filter(t => t !== tag);
    } else {
        activeTagFilters.push(tag);
    }
    updateFilterIndicator();
    displayModels(cachedModels);
}

window.removeTagFilter = function (tag) {
    activeTagFilters = activeTagFilters.filter(t => t !== tag);
    updateFilterIndicator();
    displayModels(cachedModels);
};

window.clearTagFilter = function () {
    activeTagFilters = [];
    updateFilterIndicator();
    displayModels(cachedModels);
};

function updateFilterIndicator() {
    const indicator = document.getElementById('active-filter-indicator');
    const tagsContainer = document.getElementById('filter-tags-list');

    if (!indicator || !tagsContainer) return;

    if (activeTagFilters.length > 0) {
        tagsContainer.innerHTML = activeTagFilters.map(tag => `
            <span class="filter-bubble">
                ${escapeHtml(tag)}
                <span class="remove-bubble" onclick="removeTagFilter('${escapeHtml(tag)}')">&times;</span>
            </span>
        `).join('');
        indicator.style.display = 'flex';
    } else {
        indicator.style.display = 'none';
    }
}

function renderTags(tags) {
    if (!tags || !tags.length) return '';
    return `
        <div class="tags-list">
            ${tags.map(tag => `<span class="tag ${activeTagFilters.includes(tag) ? 'active' : ''}">${escapeHtml(tag)}</span>`).join('')}
        </div>
    `;
}

function formatBytes(tokens) {
    if (!tokens) return '0';
    if (tokens >= 1000000) return (tokens / 1000000).toFixed(1) + 'M';
    if (tokens >= 1000) return (tokens / 1000).toFixed(0) + 'k';
    return tokens;
}

function getCircuitClass(state) {
    const stateMap = {
        'CLOSED': 'closed',
        'OPEN': 'open',
        'HALF_OPEN': 'half-open',
        'PERMANENTLY_UNAVAILABLE': 'unavailable'
    };
    return stateMap[state] || 'closed';
}

function getCircuitIcon(state) {
    const iconMap = {
        'CLOSED': '✓',
        'OPEN': '⚠',
        'HALF_OPEN': '⟳',
        'PERMANENTLY_UNAVAILABLE': '✗'
    };
    return iconMap[state] || '?';
}

function calculateSuccessRate(stats) {
    if (!stats || stats.totalRequests === 0) return 0;
    return Math.round((stats.successCount / stats.totalRequests) * 100);
}

function sortModels(models, sortType) {
    switch (sortType) {
        case 'requests':
            return models.sort((a, b) => (b.stats?.lifetimeTotalRequests || 0) - (a.stats?.lifetimeTotalRequests || 0));
        case 'latency':
            // Sort by average latency (lower is better), but only for models that have at least one request
            return models.sort((a, b) => {
                const aLat = a.stats?.avgLatency || Infinity;
                const bLat = b.stats?.avgLatency || Infinity;
                if (aLat === bLat) return 0;
                return aLat - bLat;
            });
        case 'success_rate':
            return models.sort((a, b) => calculateSuccessRate(b.stats) - calculateSuccessRate(a.stats));
        case 'default':
        default:
            return models; // Already sorted by default from API
    }
}

// Load Rate Limits
async function loadRateLimits() {
    const container = document.getElementById('rate-limits-container');

    if (!container) return;

    container.innerHTML = '<div class="loading-state">Loading rate limits...</div>';

    try {
        const response = await fetch(`${API_BASE_PATH}/admin/rate-limits`);

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        displayRateLimits(data);
        updateLastUpdate();
    } catch (error) {
        console.error('Failed to load rate limits:', error);
        container.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">⚠️</span>
        <p>Failed to load rate limits. Please try again.</p>
      </div>
    `;
    }
}

function displayRateLimits(data) {
    const container = document.getElementById('rate-limits-container');

    if (!container) return;

    if (!data.enabled) {
        container.innerHTML = `
        <div class="empty-state">
            <span class="empty-icon">⚡</span>
            <p>Rate limiting is currently disabled.</p>
        </div>
        `;
        return;
    }

    container.innerHTML = `
    <div class="rate-limit-card">
      <div class="rate-limit-header">
        <h3>🌐 Global Configuration</h3>
      </div>
      <div class="rate-limit-stats">
        <div class="stat-item">
          <div class="stat-item-label">Limit (Minute)</div>
          <div class="stat-item-value">${formatNumber(data.requestsPerMinute || 0)} req/min</div>
        </div>
        <div class="stat-item">
          <div class="stat-item-label">Active Model Buckets</div>
          <div class="stat-item-value">${formatNumber(data.activeBuckets?.models || 0)}</div>
        </div>
      </div>
    </div>
  `;
}

// API Tester
function initializeTester() {
    const sendButton = document.getElementById('send-test-request');
    const tempSlider = document.getElementById('test-temperature');
    const tempValue = document.getElementById('temp-value');

    // Temperature slider
    tempSlider?.addEventListener('input', (e) => {
        if (tempValue) {
            tempValue.textContent = e.target.value;
        }
    });

    // Send request button
    sendButton?.addEventListener('click', sendTestRequest);
}

async function sendTestRequest() {
    const button = document.getElementById('send-test-request');
    const responseContainer = document.getElementById('test-response');

    if (!button || !responseContainer) return;

    const model = document.getElementById('test-model')?.value || 'auto';
    const message = document.getElementById('test-message')?.value || 'Hello!';
    const temperature = parseFloat(document.getElementById('test-temperature')?.value || '0.7');
    const maxTokens = parseInt(document.getElementById('test-max-tokens')?.value || '150', 10);
    const imageUrl = document.getElementById('test-image-url')?.value?.trim();
    const imageDetail = document.getElementById('test-image-detail')?.value || 'auto';
    const videoUrl = document.getElementById('test-video-url')?.value?.trim();
    const audioUrl = document.getElementById('test-audio-url')?.value?.trim();
    const fileUrl = document.getElementById('test-file-url')?.value?.trim();

    const streaming = document.getElementById('test-streaming')?.checked || false;
    const toolsInput = document.getElementById('test-tools')?.value?.trim();
    const tagsInput = document.getElementById('test-tags')?.value?.trim();
    const maxModelSwitches = parseInt(document.getElementById('test-max-model-switches')?.value || '3', 10);

    // Disable button
    button.disabled = true;
    button.innerHTML = '<span class="button-icon">⏳</span> Sending...';

    // Show loading state
    responseContainer.innerHTML = '<div class="loading-state">Sending request...</div>';

    // Build message content
    let messageContent = [];
    let textPart = message;

    // Append other URLs to text for now as DTO strict validation might reject custom types
    // Accessing models that support these modalities typically implies they might parse URLs or we need to update DTO
    if (videoUrl) textPart += `\n\n[VIDEO: ${videoUrl}]`;
    if (audioUrl) textPart += `\n\n[AUDIO: ${audioUrl}]`;
    if (fileUrl) textPart += `\n\n[FILE: ${fileUrl}]`;

    if (imageUrl) {
        messageContent = [
            { type: 'text', text: textPart },
            { type: 'image_url', image_url: { url: imageUrl, detail: imageDetail } }
        ];
    } else {
        messageContent = textPart; // Simple string if no capability requiring complex structure is used
    }
    // Note: If we wanted to strictly test 'supports_video' routing, passing the flag is key.

    const requestBody = {
        model,
        messages: [{
            role: 'user',
            content: messageContent
        }],
        temperature,
        max_tokens: maxTokens,
        stream: streaming,
        // Set flags based on inputs
        supports_image: !!imageUrl,
        supports_video: !!videoUrl,
        supports_audio: !!audioUrl,
        supports_file: !!fileUrl,
        max_model_switches: maxModelSwitches
    };

    // Add tags if provided
    if (tagsInput) {
        requestBody.tags = tagsInput.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0);
    }

    // Add tools if provided
    if (toolsInput) {
        try {
            const tools = JSON.parse(toolsInput);
            if (Array.isArray(tools) && tools.length > 0) {
                requestBody.tools = tools;
                requestBody.tool_choice = 'auto';
            }
        } catch (error) {
            displayTestResponse({ error: `Invalid tools JSON: ${error.message}` }, 0, false);
            button.disabled = false;
            button.innerHTML = '<span class="button-icon">🚀</span> Send Request';
            return;
        }
    }

    try {
        const startTime = Date.now();

        if (streaming) {
            await handleStreamingRequest(requestBody, responseContainer, startTime);
        } else {
            await handleNormalRequest(requestBody, responseContainer, startTime);
        }
    } catch (error) {
        displayTestResponse({ error: error.message }, 0, false);
    } finally {
        // Re-enable button
        button.disabled = false;
        button.innerHTML = '<span class="button-icon">🚀</span> Send Request';
    }
}

async function handleNormalRequest(requestBody, responseContainer, startTime) {
    const response = await fetch(`${API_BASE_PATH}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody)
    });

    const elapsed = Date.now() - startTime;
    const data = await response.json();

    if (response.ok) {
        displayTestResponse(data, elapsed, true);
    } else {
        displayTestResponse(data, elapsed, false);
    }
}

async function handleStreamingRequest(requestBody, responseContainer, startTime) {
    const response = await fetch(`${API_BASE_PATH}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const error = await response.json();
        displayTestResponse(error, Date.now() - startTime, false);
        return;
    }

    // Handle SSE streaming
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    let routerInfo = null;
    let toolCalls = [];
    let finishReason = null;

    responseContainer.innerHTML = `<pre class="response-content response-success streaming-response">⚡ Streaming Response:\n\n</pre>`;
    const contentElement = responseContainer.querySelector('.streaming-response');

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.trim() || line.trim() === 'data: [DONE]') continue;

                if (line.startsWith('data: ')) {
                    try {
                        const jsonData = JSON.parse(line.slice(6));

                        // Extract router info from first chunk
                        if (jsonData._router && !routerInfo) {
                            routerInfo = jsonData._router;
                        }

                        // Process choices
                        if (jsonData.choices && jsonData.choices[0]) {
                            const delta = jsonData.choices[0].delta;

                            // Accumulate content
                            if (delta.content) {
                                fullContent += delta.content;
                                contentElement.textContent = `⚡ Streaming Response:\n\n${fullContent}`;
                            }

                            // Handle tool calls
                            if (delta.tool_calls) {
                                delta.tool_calls.forEach(tc => {
                                    if (!toolCalls[tc.index]) {
                                        toolCalls[tc.index] = {
                                            id: tc.id || '',
                                            type: tc.type || 'function',
                                            function: { name: '', arguments: '' }
                                        };
                                    }
                                    if (tc.function?.name) {
                                        toolCalls[tc.index].function.name += tc.function.name;
                                    }
                                    if (tc.function?.arguments) {
                                        toolCalls[tc.index].function.arguments += tc.function.arguments;
                                    }
                                });
                            }

                            // Get finish reason
                            if (jsonData.choices[0].finish_reason) {
                                finishReason = jsonData.choices[0].finish_reason;
                            }
                        }
                    } catch (e) {
                        console.error('Failed to parse SSE chunk:', e);
                    }
                }
            }
        }

        const elapsed = Date.now() - startTime;

        // Build final display
        let finalContent = `✓ Streaming Complete (${elapsed}ms)\n\n`;
        finalContent += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        finalContent += `Response:\n`;
        finalContent += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        finalContent += fullContent || 'No content';

        if (toolCalls.length > 0) {
            finalContent += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
            finalContent += `Tool Calls:\n`;
            finalContent += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
            finalContent += JSON.stringify(toolCalls, null, 2);
        }

        if (finishReason) {
            finalContent += `\n\nFinish Reason: ${finishReason}`;
        }

        if (routerInfo) {
            finalContent += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
            finalContent += `Router Metadata:\n`;
            finalContent += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
            finalContent += `Provider: ${routerInfo.provider || 'N/A'}\n`;
            finalContent += `Model: ${routerInfo.model || 'N/A'}\n`;
            finalContent += `Latency: ${routerInfo.latency || 0}ms\n`;
            finalContent += `Attempts: ${routerInfo.attempts || 0}`;
        }

        contentElement.textContent = finalContent;

    } catch (error) {
        displayTestResponse({ error: `Streaming error: ${error.message}` }, Date.now() - startTime, false);
    }
}

function displayTestResponse(data, elapsed, success) {
    const container = document.getElementById('test-response');

    if (!container) return;

    const className = success ? 'response-success' : 'response-error';
    const statusIcon = success ? '✓' : '✗';

    let content = '';

    if (success && data.choices && data.choices[0]) {
        const message = data.choices[0].message?.content || 'No content';
        const routerInfo = data._router || {};

        content = `
${statusIcon} Request Successful (${elapsed}ms)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Response:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${message}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Router Metadata:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Provider: ${routerInfo.provider || 'N/A'}
Model: ${routerInfo.model || 'N/A'}
Latency: ${routerInfo.latency || 0}ms
Attempts: ${routerInfo.attempts || 0}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Full Response:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${JSON.stringify(data, null, 2)}
    `;
    } else {
        content = `
${statusIcon} Request Failed

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Error:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${JSON.stringify(data, null, 2)}
    `;
    }

    container.innerHTML = `<pre class="response-content ${className}">${escapeHtml(content)}</pre>`;
}

// Utility Functions
function formatNumber(num) {
    return num.toLocaleString('en-US');
}

function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (days > 0) {
        return `${days}d ${hours}h`;
    } else if (hours > 0) {
        return `${hours}h ${minutes}m`;
    } else {
        return `${minutes}m`;
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function updateLastUpdate() {
    const element = document.getElementById('last-update');
    if (element) {
        element.textContent = new Date().toLocaleTimeString();
    }
}

