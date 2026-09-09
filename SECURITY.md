# Security boundaries

## Scope

The native helper is a short-lived Chrome native-messaging process, not a service.
It has no sockets, wallet IPC, login storage, telemetry, automatic updater, or shell
command API. The user retains control of VPN accounts and configuration.

Only one exact `chrome-extension://<id>/` origin is accepted in each build channel.
Chrome's `nativeMessaging` permission and the user-owned host manifest are required.
The origin argument is not a defense against another process already running as
the same user: local same-user compromise is outside this boundary. Production and
development helper identities never share an allowlist.

Requests and responses are limited to 4 KiB. IDs are UUIDs; schemas reject extra
fields. A process handles at most 128 frames. Provider subprocess output is capped
at 64 KiB with fixed deadlines (usually 3 seconds; IVPN connect 18 seconds). No raw
provider output, credentials, account details, IPs, or arbitrary exceptions cross
the protocol. Unknown state fails closed. A timeout is an uncertain operation, not
proof that the VPN did not connect.

Provider paths, arguments, versions and signing requirements are fixed in source.
Local signature validation forbids certificate network access. Caller-supplied
paths, commands, servers, accounts, tokens, URLs, and environment are rejected.
Connection operations serialize with a same-user no-follow lock. The v3 flow
refuses to create a second known tunnel or act on uncertain alternate-provider
state. v2 conservatively refuses when IVPN is installed.

## Installer boundary

The setup app operates only below the current user's Application Support directory
and the current user's Google Chrome native-host directory. There is no privileged
helper, launch agent, system-wide manifest, login item, or administrator prompt.

An installation journal owns exact immutable version directories named by version
and helper digest. Atomic journal and manifest replacement ensures an interrupted
upgrade leaves the old manifest usable. Install/Repair checks bundled bytes, and
Check installation checks hashes and the exact matching registration without
executing a provider. A missing registered file can be repaired; a foreign
registration is never silently overwritten.

Managed destinations reject symlinks, other owners, and group/world-writable paths.
Uninstall preflights every recorded version and refuses unexpected contents. It
removes individual owned files and empty version directories, never recursively
deleting a user folder. Other-channel registrations and unrelated files remain.
Filesystem checks are not designed to resist an actively malicious same-user
process racing every operation.

## What is not guaranteed

A provider's connected state does not prove this Chrome profile routes through it.
Split tunneling, browser proxies, VPN failures, background wallet services, other
apps, and IP exposure elsewhere are not prevented by this helper. No traffic
blocking is activated in this release. An installer signature authenticates the
distributor; it does not certify every provider or guarantee privacy.

## Reporting

Report suspected vulnerabilities privately to **[security@ahloop.com](mailto:security@ahloop.com)**,
the security contact listed in Anon's security and privacy pages. If this
repository's Security tab offers **Report a vulnerability**, that private GitHub
channel is also suitable. Do not open a public issue for an unpatched vulnerability.

Include the affected Guard version, macOS/provider versions, expected versus
observed behavior and a minimal reproduction using synthetic data. Do not send
wallet keys, seed phrases, credentials, wallet addresses, native-message payloads
or raw VPN output. Coordinate any sensitive follow-up privately with maintainers.

The 0.1.x line is a development preview, not a supported production security
boundary. Reports are welcome; no independent audit, response-time SLA or bounty
is claimed. The current review/distribution gates are in the
[release checklist](docs/release-checklist.md).
