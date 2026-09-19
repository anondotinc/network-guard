# Development RPC proxy protocol v7

Introduced in 0.1.4 build 7 for explicit extension testing on macOS. Production
builds reject this protocol. v1–v6 and the strict v4 discovery inventory are
unchanged. Discover version >= 0.1.4 and channel `development`, then negotiate v7
on a new native port. This transport extends the development helper's security
scope: it handles wallet RPC data and creates outbound proxy connections.

The first request is a normal <=4096-byte frame:

```json
{"v":7,"id":"00000000-0000-4000-8000-000000000001","method":"rpcCapabilities"}
```

Success has exactly the same fields plus `ok:true`. Only after success may the
client send one frame of <=131072 bytes, with exactly `v,id,method,host,port,url,
headers,body`. Version and ID match the handshake. `method` is `rpc`; `host` is a
numeric IPv4/IPv6 proxy address; `port` is an integer 1–65535. `url` is HTTP(S),
without userinfo/fragment/control characters, <=4096 UTF-8 bytes. `headers` maps
lowercase names to values (32 headers, 8192 bytes total). Hop-by-hop, cookie,
host, compression and proxy authentication headers are rejected. `body` is
base64 UTF-8 JSON-RPC 2.0, <=65536 decoded bytes, at most 100 calls per batch.

Success is exactly `{v,id,ok:true,status,body}`; status is 200–599 excluding
redirects and body is base64, <=262144 decoded bytes. Response frame limit is
400000 bytes, below Chrome's 1 MiB native-to-browser limit. Errors are exactly
`{v,id,ok:false,error}` where error is `invalidRequest`, `proxyFailed`,
`responseTooLarge` or `cancelled`. No exceptions, addresses, bodies, or raw curl
output are included in errors. The session ends after one request.

The transport launches the fixed `/usr/bin/curl` executable without a shell.
URL, headers and body are escaped into stdin configuration; they do not appear
in process arguments or temporary files. The first flag disables curlrc; the
environment is fixed. An explicit `socks5h` proxy with an empty bypass list
forces target DNS through SOCKS, including localhost targets. There is no
direct fallback, automatic retry, redirect following, cookie store or
certificate-verification override. Proxy credentials are not supported.

Both subprocess output and elapsed time are bounded. Native execution permits
45 seconds, with a 47-second outer deadline; Chrome's client permits 50 seconds.
Port input closure cancels the child while the native process is running.
Cancellation cannot undo requests already delivered, and abrupt process death
can leave curl alive until its own deadline. Never infer that a cancelled
transaction was not submitted.

An enabled RPC proxy does **not** proxy all wallet or browser traffic. Other
HTTP APIs, images, WebSockets, XHR and mobile are outside this pilot. It is not a
traffic firewall, anonymity guarantee, or Tor Browser replacement. Expansion
requires transport coverage and independent leak testing, not just an IP check.

Run `node scripts/test-native.mjs` and `node scripts/test-rpc-proxy.mjs` locally.
The latter needs loopback listeners, uses only synthetic RPC bodies, and never
contacts public RPCs or changes browser, VPN, or proxy configuration.
