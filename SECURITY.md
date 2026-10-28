# Security

Report a vulnerability to hello@verifex.dev with "Security" in the subject. Please do not open
a public issue for it.

This server holds no credentials of its own: it reads your Verifex API key from the environment
and sends it only to the configured Verifex API origin (https only, except localhost). If you
think your key was exposed, revoke it in the Verifex dashboard (API Keys) and create a new one.
