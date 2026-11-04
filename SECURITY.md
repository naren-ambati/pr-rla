# Security policy

## Reporting a vulnerability

**Contact: to be decided before public release.** The founder decides the security contact (design decision D10). Until it is set here, there is no private reporting channel, and pr-rla has no public repository or issue tracker either.

When the contact exists, report privately to it, not in a public issue, and include what you need to show the problem: the pr-rla version, the command or API call, and a fixture or audit directory that reproduces it.

## What counts

pr-rla makes a statistical claim about changes that landed without review, and its value is that a third party can check the claim. So a vulnerability is anything that lets an audit say more than it shows, or that leaks what it holds:

- a way to make `verify` print `VERIFIED`, or `status` print `CERTIFIED`, for an audit whose population, seed, draws, verdicts or times were tampered with;
- a way to choose or predict the draws, or to move the seed round;
- a forged timestamp token or transparency-log entry that pr-rla accepts;
- a way for a verdict to count above the provenance the registration requires, or for an assistant to record one through pr-rla's own surfaces (the MCP server, the `review-draw` skill);
- a credential that reaches a host, a plugin or an output it should not, or a write that leaves a read-only context;
- a plugin that escapes the isolation the security model states for its Node version.

[`docs/security-model.md`](docs/security-model.md) lists every threat pr-rla is designed against (T1–T18), how each is mitigated, and the limits it states plainly. A limit stated there (for example that `presence` does not attest key hardware, threat T16, or that an isolated plugin on Node 22 and 24 can still open its own sockets) is known, not a vulnerability, though a way to make it worse is.

## Supported versions

None yet: nothing has been released. From the first public release (0.1.0), the latest release is the supported one.
