# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately through GitHub: **Security → Report a vulnerability** on
<https://github.com/Normansrule/strategy-showdown/security/advisories/new>.

Please include what you found, how to reproduce it, and what an attacker could do with it. You should get an
acknowledgement within 7 days. Once a fix is released, the advisory will be published and credit given if you
want it.

## Supported versions

Only the latest release and the `main` branch get fixes.

## Scope

In scope: the website under `docs/`, the file loaders (`docs/engine/data/`), the desktop server
(`desktop/server.mjs`), the Python scripts in `scripts/`, and the GitHub workflows. What the project does and
does not defend against is described in [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md).

Errors in formulas, parameters or citations are not security issues. Please report them as normal issues;
they matter just as much.
