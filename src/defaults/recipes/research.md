# Research projects

## When to use

The project involves academic research, and referencing.

## Env

Web search providers

## Ports

A local research service on the host, if the user runs one (e.g. Zotero's
local API on `23119`). Local document editing MCP servers may need specific ports
open.

## Read-only binds

None.

## Read-write binds

A directory outside the project for downloaded sources, if wanted:
`$HOME/<path>`.

## Skills

Look for locally hosted skills that are relevant to document parsing for 
references, zotero library querying and management, bibliographic api querying,
writing styles, latex.

Pi has a specific zotero plugin (git:github.com/robchallen/pi-zotero-web) that 
can access zotero directly. Other agents may have a `zotero-cli` skill.

## MCP servers

Suggest MCP servers such as Nelson (LibreOffice), MS Word or google docs MCP if
available.
