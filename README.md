# @pipeworx/or-dmv

Oregon DMV MCP — **live** wait times at all 60 Oregon DMV field offices, plus the office
locator the same payload carries. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

Oregon and North Carolina are the only two US states whose DMV publishes a
machine-readable live wait feed. Every other state's is captcha-gated, blocked to cloud
egress, broken, or only inside a phone app.

## Tools

- `or_dmv_wait_times(office?, city?, region?, open_only?, sort?, limit?)` — average minutes
  until served and customers currently queued, per field office.
- `or_dmv_offices(office?, city?, zip?, region?, limit?)` — address, city, ZIP, phone,
  latitude/longitude, ODOT region, appointment-only flag and the office's ODOT page.

## Auth

None. Keyless and unauthenticated.

## Data source

`https://dmv2u2.odot.state.or.us/waittimes/home/map`

## Scraped from HTML — no JSON endpoint exists

This is the one thing to know before depending on this pack.

ODOT renders the wait-time map **server-side**. There is no API behind it: the `/api` paths
one would guess at return nothing. The office array is assigned to `aveWaitModels` inside
an inline `<script>` tag on the page. The pack finds that identifier, brace-matches the
array literal that follows it, and `JSON.parse`s the result.

That makes Oregon structurally more fragile than an API-backed pack — an ODOT template
change can move or rename the identifier and break extraction until this pack is updated.
Those failures are reported as exactly that (`the Oregon wait-time page no longer contains
the aveWaitModels office array`) with a hint pointing at `nc_dmv_wait_times`, rather than
surfacing as a parsing bug of ours.

## Gotchas this pack handles for you

### Closed hours produce `not_reporting`, never a zero wait

Outside business hours ODOT sets `waitTimeEnabled: false` while leaving
`averageMinutesUntilServed` at `-1` and `customersWaiting` at `0`. Publishing that as a
zero-minute wait would read as "walk right in", so those offices come back as
`status: "not_reporting"` with `wait_minutes: null`.

`-1` is ODOT's unavailable sentinel and it survives `waitTimeEnabled` being true, so it is
mapped to `null` in that case too. Responses always carry `offices_reporting`, and when
nothing is reporting the `note` says the feed is switched off rather than the lines being
empty. `sort: "wait"` puts reporting offices first for the same reason.

### Fields deliberately dropped

Each office ships an `ipAddress` and a set of `fieldOfficeMachine*` fields. Those are
ODOT's internal queue-terminal plumbing and are **not** republished. Everything else is
passed through, including `open`, `appointmentOnly` and `closeDescription`
(as `closure_note`), which carry real information about an office being shut.

Phone numbers arrive as bare ten-digit strings (`5419672014`) and are formatted as
`(541) 967-2014`.

### Regions

`region` matches on the six ODOT groupings: Central Oregon, Eastern Oregon, Portland Area,
Southern Oregon, The Coast, Willamette Valley.

## Related

- `nc_dmv_wait_times` / `nc_dmv_offices` — North Carolina, the other live state wait feed.
- `ca_dmv_offices` — California field offices (no wait feed published).

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "or-dmv": {
      "url": "https://gateway.pipeworx.io/or-dmv/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/or-dmv/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Or Dmv data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
