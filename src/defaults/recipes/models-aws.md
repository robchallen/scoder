# Models on AWS (Bedrock)

## When to use

The agent uses models hosted on AWS Bedrock.

## Env

```
AWS_PROFILE
AWS_REGION
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
AWS_BEARER_TOKEN_BEDROCK
```

(Only the ones the user's setup uses.)

## Ports

None.

## Read-only binds

`$HOME/.aws` when `AWS_PROFILE` is used (profiles and SSO cache live
there).

## Read-write binds

None — unless SSO token refresh inside the sandbox is needed, in which case
`$HOME/.aws/sso/cache` read-write.

## Skills

None.

## MCP servers

None.
