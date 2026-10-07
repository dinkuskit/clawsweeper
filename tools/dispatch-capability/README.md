# Fixed review dispatch capability

This operator-run workflow seals the existing central dispatch credential to a
reviewed registry of 59 GitHub Actions public encryption keys. It accepts no
caller-provided recipient or key. The original eight public recipients retain
named entries. Additional recipients use random opaque labels; no private
repository names or repository IDs belong in this public registry or output.
The operator retains the approved label-to-repository-ID mapping outside this
public repository. The canonical secret owner and a separately managed rollout
are excluded from this distribution batch.

Only the sealing step receives the central secret. It emits libsodium sealed
boxes bound to the fixed GitHub keys; no plaintext is logged, returned or
retained. An authorized operator downloads the encrypted artifact and checks
its exact recipient set against this registry. For each entry, resolve the
approved private mapping (or original public name), verify the live repository
ID, and compare BOTH its current public key and key ID with the registry. Submit
only the unchanged encrypted value to that repository's Actions secret API.
Any mismatch stops installation; a changed key requires a reviewed registry
update and a fresh sealing run. Only GitHub holds the decryption keys.

The central repository remains the canonical credential owner. All copies use
`CLAWSWEEPER_DISPATCH_TOKEN`. Provisioning does not mint a token or expand its
downstream permissions. Rotation updates the canonical secret and its complete
approved distribution together. The workflow is manual, runs only from main,
and checks out its immutable workflow commit without persisted Git credentials.
PR events never run it. Artifacts expire after one day.

Tests use generated fixture keys and a synthetic noncredential value. Follow-up
proof must establish actual dispatch for each caller; successful encryption is
not successful review routing. Keep private recipient mappings and installation
receipts in the operator's private proof store, never in public PRs or artifacts.
