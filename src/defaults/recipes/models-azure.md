# Models on Azure

## When to use

The agent uses models hosted on Azure OpenAI / Azure AI.

## Env

```
AZURE_OPENAI_API_KEY
AZURE_OPENAI_BASE_URL
AZURE_OPENAI_RESOURCE_NAME
AZURE_OPENAI_API_VERSION
AZURE_OPENAI_DEPLOYMENT_NAME_MAP
```

## Ports

None.

## Read-only binds

`$HOME/.azure` only if the agent authenticates through the Azure CLI's
credentials rather than a key.

## Read-write binds

None.

## Skills

None.

## MCP servers

None.
