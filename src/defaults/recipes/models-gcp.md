# Models on Google Cloud (Vertex AI)

## When to use

The agent uses models hosted on Google Cloud / Vertex AI.

## Env

```
GOOGLE_CLOUD_PROJECT
GOOGLE_CLOUD_LOCATION
GOOGLE_APPLICATION_CREDENTIALS
GEMINI_API_KEY
```

## Ports

None.

## Read-only binds

The file `GOOGLE_APPLICATION_CREDENTIALS` points at, if it is under
`$HOME`; or `$HOME/.config/gcloud` for `gcloud`-based credentials.

## Read-write binds

None.

## MCP servers

None.
