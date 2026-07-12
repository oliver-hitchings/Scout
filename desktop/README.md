# Scout Wails host

This directory is the native host only. It supervises the bundled Node service
and proxies its existing localhost UI into Wails; no workspace or opportunity
logic lives here. Wails is pinned at `v3.0.0-alpha.87`
(`d1be17b29915d77dd6f71f84f3820753d717a461`) in `third_party/wails-v3`.

Build with `go build ./cmd/scout-host` from this directory after
`git submodule update --init --recursive`. Do not replace this with `go install`.
