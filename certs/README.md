# Extra root certificates for Docker builds

Only needed on a network that inspects TLS (a corporate proxy that re-signs HTTPS with its own root
CA). Without it, `docker compose build` fails inside the containers with errors like
`CERTIFICATE_VERIFY_FAILED` (pip) or `self-signed certificate in certificate chain` (npm), even though
your Mac trusts the proxy.

1. Find the proxy's **root** certificate — the last one in the chain your machine is shown, not a guess
   by name:

   ```bash
   openssl s_client -showcerts -connect pypi.org:443 </dev/null 2>/dev/null | awk '/BEGIN/,/END/'
   ```

   Or export it from Keychain Access (System Roots / System keychain) as a `.pem` / `.crt` file.
2. Put it in this folder as `something.crt` or `something.pem`. A file with several certificates is
   fine — the build splits it into one certificate per file (Debian's `update-ca-certificates`
   silently ignores bundles otherwise).
3. Build as usual: `docker compose build`.

Everything here except this README is git-ignored. Never commit a certificate: an internal CA in a
public repo tells everyone what your company's network trusts.

For `npm install` on the Mac itself behind the same proxy:
`export NODE_EXTRA_CA_CERTS=/path/to/your-ca.pem`.
