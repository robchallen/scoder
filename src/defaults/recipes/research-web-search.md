# Research projects with web search

## When to use

The agent will search the web or fetch pages as part of the work
(literature, documentation, data gathering).

## Env

The search provider the user has a key for — ask which; list only that:

```
WEB_SEARCH_PROVIDER
BRAVE_SEARCH_API_KEY
TAVILY_API_KEY
SERPER_API_KEY
EXA_API_KEY
YOUCOM_API_KEY
JINA_API_KEY
FIRECRAWL_API_KEY
PERPLEXITY_API_KEY
```

## Ports

A local research service on the host, if the user runs one (e.g. Zotero's
local API on `23119`).

## Read-only binds

None.

## Read-write binds

A directory outside the project for downloaded sources, if wanted:
`$HOME/<path>`.

## Skills

This recipe is mostly about skills: research work leans on them more than
on toolchains. Pick from the candidates on this machine that match, and
ask about the rest:

```
web-search|web-fetch
.*research.*
arxiv.*|pubmed.*|semantic-scholar.*
citation.*|bibtex.*|zotero.*
pdf.*
```

Patterns that match nothing do no harm, but keep the file to what the
user actually has.

## MCP servers

The user's own research MCP servers, from their recipes in
`~/.config/scoder/recipes/`.
