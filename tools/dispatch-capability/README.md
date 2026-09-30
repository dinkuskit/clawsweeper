# Priority review dispatch capability

This operator-run workflow distributes the existing central dispatch credential
to Commerce, Template Store, Inventory, Payments and DinkusKit. It accepts no
caller-provided recipient or key. The checked-in registry contains only GitHub
Actions public encryption keys, verified through each repository's API.

Only the sealing step receives the central secret. It emits libsodium sealed
boxes bound to those five GitHub keys; no plaintext is logged, returned or
retained. An authorized operator downloads the encrypted artifact, checks each
current key ID against the registry, and submits each unchanged encrypted value
to that repository's Actions secret API. Only GitHub holds the private keys.

The central repository is the canonical credential owner. These five copies are
one rotation bundle for `CLAWSWEEPER_DISPATCH_TOKEN`; provisioning does not expand
the credential's downstream permissions. A changed public key requires a new
reviewed registry and sealing run. Rotation must update the canonical secret and
all five copies together. The workflow is manual, runs only from main, and checks
out main without persisted Git credentials. PR events never run it.

Tests use generated fixture keys and a synthetic noncredential value. Follow-up
proof must establish actual dispatch for each caller; successful encryption is
not successful review routing.
