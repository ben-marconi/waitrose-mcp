# Security policy

This is an unofficial, personal-project MCP server that can hold Waitrose
account credentials and, when enabled, place orders using the account's
existing payment setup. Give write access only to trusted MCP clients.

- Never commit credentials, session tokens, or `.env` files. Report any you
  find in history as a security issue.
- If you find a vulnerability (auth bypass, token leakage, unintended write
  path), please open a private GitHub Security Advisory rather than a public
  issue.
- A bearer token is required by default. Setting `ALLOW_INSECURE_NO_AUTH=1`
  without a token only works on a loopback interface. Other local processes
  can reach the unauthenticated listener, so use it only on a trusted machine
  behind an authenticated tunnel or proxy. See [setup](README.md#setup).
