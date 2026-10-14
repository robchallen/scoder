# Base: every project

## When to use

Always. Every project starts from this, then adds the recipes for its
languages and tools. This recipe deals with inference providers, web search
providers, classifier providers, and harness specific overrides.

## Inference provider env

Does the sandbox need API keys for inference providers? Not if they are 
configured directly into the harness or the services are provided by OAuth.
Likely possibilities are: 

```
OPENROUTER_API_KEY
ANTHROPIC_API_KEY
COPILOT_PROVIDER_API_KEY
COPILOT_GITHUB_TOKEN
AZURE_OPENAI_API_KEY
OPENAI_API_KEY
DEEPSEEK_API_KEY
GEMINI_API_KEY
MISTRAL_API_KEY
GROQ_API_KEY
CEREBRAS_API_KEY
CLOUDFLARE_API_KEY
XAI_API_KEY
AI_GATEWAY_API_KEY
ZAI_API_KEY
OPENCODE_API_KEY
FIREWORKS_API_KEY
TOGETHER_API_KEY
KIMI_API_KEY
MINIMAX_API_KEY
XIAOMI_API_KEY
```

This setting is possibly configured already in `~/.config/scoder/sandbox/env`, so 
check you are not duplicating. Remember users previous choices and offer those 
first. Discuss with the user whether this is a user level choice `~/.config/scoder/sandbox/env`
or a project level choice `<project>/.sandbox/env`.

## Web search provider env

Which web search providers does the user have access to?

```
WEB_SEARCH_PROVIDER
FIRECRAWL_API_KEY
BRAVE_SEARCH_API_KEY
TAVILY_API_KEY
SERPER_API_KEY
EXA_API_KEY
YOUCOM_API_KEY
JINA_API_KEY
PERPLEXITY_API_KEY
```

As above, check it is not already configured, discuss if this is a user level choice `~/.config/scoder/sandbox/env`
or a project level choice `<project>/.sandbox/env`.

## Decision model providers

Are there decision models being used? If so `TYPESAFE_API_KEY` and for pi 
support specifically `PI_JEV_*`

As above, check it is not already configured, discuss if this is a user level choice `~/.config/scoder/sandbox/env`
or a project level choice `<project>/.sandbox/env`.

## Read-only binds

Does the user have any source code dependencies of this project, reference
material, or data directories they want included, for this specific project?

## Read-write binds

Does the user have any output of cache directories that the project needs to 
be able to write to, for this specific project? Offer to scan the project for 
output or cache directories, if the user is unsure.

## Skills

Propose locally available skills for using github. Propose local meta-skills (skill 
creation skills) and available software developement methodology skills.

Which other skills are relevant to the existing project? Consult other project specific recipes for more detail. 

scoder specific skills are automatically injected so don't need to be suggested.

## Locally hosted inference providers

Does the user plan to use locally hosted providers with a harness? Remember the
users previous choices and offer those. If using local models depending
on the harness they will need some or all of the following:

### Locally hosted env

Depends on the users choice of current and future harnesses.

claude needs `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, 
but also `ANTHROPIC_DEFAULT_*_MODEL` can be useful.

opencode needs `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`

copilot needs `COPILOT_PROVIDER_TYPE`, `COPILOT_PROVIDER_BASE_URL`,
`COPILOT_PROVIDER_API_KEY`, `COPILOT_MODEL`

pi can resolve locally hosted models using a plugin, `git:github.com/ai4ci/pi-vllm`,

decision models may be locally hosted and need `TYPESAFE_BASE_URL` to be passed
through to the sandbox.

As above, check it is not already configured, discuss if this is a user level choice `~/.config/scoder/sandbox/env`
or a project level choice `<project>/.sandbox/env`.

### Locally hosted ports

Usually nothing to add: scoder auto-detects a server on `11434` (any
listener) and on `11435` (one answering an OpenAI-style `/v1/models`) and
adds the port itself. Add other ports explicitly.

## Alternative hosting platforms

Does the user have inference providers hosted on non standard platforms, such 
as Azure, AWS Bedrock, Google Cloud / Vertex?

### Azure specific env

```
AZURE_OPENAI_API_KEY
AZURE_OPENAI_BASE_URL
AZURE_OPENAI_RESOURCE_NAME
AZURE_OPENAI_API_VERSION
AZURE_OPENAI_DEPLOYMENT_NAME_MAP
```

As above, check it is not already configured, discuss if this is a user level choice `~/.config/scoder/sandbox/env`
or a project level choice `<project>/.sandbox/env`.

### Azure specific read-only binds

`$HOME/.azure` only if the agent authenticates through the Azure CLI's
credentials rather than a key.

### AWS specific env

```
AWS_PROFILE
AWS_REGION
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
AWS_BEARER_TOKEN_BEDROCK
```

As above, check it is not already configured, discuss if this is a user level choice `~/.config/scoder/sandbox/env`
or a project level choice `<project>/.sandbox/env`.

### AWS specific read-only binds

`$HOME/.aws` when `AWS_PROFILE` is used (profiles and SSO cache live
there).

### AWS specific read-write binds

None — unless SSO token refresh inside the sandbox is needed, in which case
`$HOME/.aws/sso/cache` read-write.

## Google cloud specific env

```
GOOGLE_CLOUD_PROJECT
GOOGLE_CLOUD_LOCATION
GOOGLE_APPLICATION_CREDENTIALS
GEMINI_API_KEY
```

As above, check it is not already configured, discuss if this is a user level choice `~/.config/scoder/sandbox/env`
or a project level choice `<project>/.sandbox/env`.

## Google cloud specific read-only binds

The file `GOOGLE_APPLICATION_CREDENTIALS` points at, if it is under
`$HOME`; or `$HOME/.config/gcloud` for `gcloud`-based credentials.
