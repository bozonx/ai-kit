module.exports = {
    ...require('./.eslintrc.js'),
    rules: {
        'n8n-nodes-base/node-class-description-inputs-wrong-regular-node': 'error',
        'n8n-nodes-base/node-class-description-outputs-wrong': 'error',
        'n8n-nodes-base/node-dirname-against-convention': 'error',
        'n8n-nodes-base/node-execute-block-double-assertion-for-items': 'error',
        'n8n-nodes-base/node-param-default-missing': 'error',
        'n8n-nodes-base/node-param-description-missing-final-period': 'error',
        'n8n-nodes-base/node-param-display-name-miscased': 'error',
        'n8n-nodes-base/node-param-display-name-wrong-for-dynamic-options': 'error',
    },
};
