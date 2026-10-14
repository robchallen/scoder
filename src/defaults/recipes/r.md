# R

## When to use

The project has `DESCRIPTION`, a `*.Rproj`, or `.R`/`.Rmd`/`.qmd` files.

## Env

`R_LIBS_USER` only if the user keeps their library somewhere unusual.

## Ports

None.

## Read-only binds

The user's R library and profile, so installed packages load:

```
$HOME/R
$HOME/.Rprofile
```

N.b. `.Rprofile` may not exist, it still needs a grant.

## Read-write binds

None — install packages on the host.

## Skills

```
r-.*|tidyverse.*|shiny.*|quarto.*
```

## MCP servers

With `--ide rstudio` or `--ide positron`: btw (`btw::btw_mcp_server()`) —
see "RStudio: btw" and "Positron" under MCP servers in the
`configure-scoder-sandbox` skill.
