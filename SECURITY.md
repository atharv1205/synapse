# Security policy

## Supported versions

Only the latest published version of `synapse-map` receives security fixes. Please
upgrade before reporting.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub instead: open the repository's **Security** tab and
choose **Report a vulnerability**. Include what you found, how to reproduce it, and what
an attacker could do with it.

You can expect an acknowledgement within a week. Once a fix is ready it will be released
and the advisory published, crediting you unless you would rather stay anonymous.

## How Synapse is meant to be run

Knowing the intended setup helps judge what counts as a vulnerability.

- **It is a local tool.** `synapse serve` binds to `127.0.0.1` and only answers requests
  addressed to localhost, which blocks DNS-rebinding attacks from websites you visit.
  Binding elsewhere with `--host` is an explicit choice and prints a warning: the API has
  no authentication.
- **Keys stay in the environment.** `GEMINI_API_KEY` and `ANTHROPIC_API_KEY` are read
  from environment variables only, never from flags, files or the web page.
- **GitHub tokens are used once.** A token given for a private repository is used for the
  clone and the repository lookup, then dropped. It is never written to disk, logged, or
  returned by the API, and clone URLs are recorded with credentials removed.
- **Code goes to the cloud only by choice.** With the default local provider nothing
  leaves the machine. With Gemini or Claude, parts of the source are sent for summaries
  and answers.

Problems that break any of these guarantees are in scope, for example a way for a web
page to reach the local API, or a token or key ending up on disk or in a response.
