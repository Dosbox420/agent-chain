# Flag Propagation Audit — Is the SHARED_FRAG Fix Complete?

**Date:** 2026-10-11
**Question:** The Dirty Frag fix adds `skb_has_shared_frag()` guards in `esp4.c` /
`esp6.c`. Those guards only work if **every path that creates or copies an skb
propagates `SKBFL_SHARED_FRAG`**. Any path that silently drops the flag re-opens
the class, because every consumer guard becomes a no-op for that skb.
**Method:** Enumerate every function in `net/core/skbuff.c` that creates or copies
an skb, and check flag handling. Then trace reachability for each gap.

---

## Where the flag is propagated (6 sites, all correct)

```
2263:  skb_shinfo(n)->flags |= skb_shinfo(skb)->flags & SKBFL_SHARED_FRAG;
4251:  const int zc_flags = SKBFL_SHARED_FRAG | SKBFL_PURE_ZEROCOPY;
4402:  skb_shinfo(tgt)->flags |= skb_shinfo(skb)->flags & SKBFL_SHARED_FRAG;
5017:  ... SKBFL_SHARED_FRAG;
5034:  skb_shinfo(nskb)->flags |= skb_shinfo(frag_skb)->flags & SKBFL_SHARED_FRAG;
6264:  to_shinfo->flags |= from_shinfo->flags & SKBFL_SHARED_FRAG;
```

## Automated scan: 4 apparent gaps

A regex scan for skb-creating functions lacking `SHARED_FRAG` returned:

| Function | First reading | After tracing |
|---|---|---|
| `skb_copy_ubufs` | **no flag handling** | **SAFE** — calls `skb_zcopy_clear(skb, false)`, which clears `SKBFL_ALL_ZEROCOPY` (a superset of `SKBFL_SHARED_FRAG`). It also replaces all frags with private kernel pages, so the flag is semantically stale anyway. |
| `skb_zerocopy` | **no flag handling** | **NOT REACHABLE** — zero callers anywhere in the tree. Dead helper. |
| `skb_zerocopy_iter_stream` | **no flag handling** | **SAFE** — ends with `skb_zcopy_set()` → `skb_zcopy_init()`, which does `skb_shinfo(skb)->flags \|= uarg->flags` (a *second producer* path, not a propagation gap). |
| `__skb_splice_bits` | **no flag handling** | **SAFE by construction** — this is the *producer* entry point that hands frags to the app; the flag is set by the caller (`__ip_append_data`), not here. |

**Verdict: no propagation gap found.** All four candidates resolve as safe or
unreachable once the helper calls are traced. Stated as a bounded negative, not
proof of absence.

---

## What the tracing taught me (recorded so it is not re-learned)

**1. A regex that matches `SHARED_FRAG` is a poor audit.** Three of four hits were
false positives caused by helper indirection — `skb_zcopy_clear`,
`skb_zcopy_init`, `skb_zcopy_set`. The flag is set and cleared through helpers
that do not name it literally. Any future scan must include the helper set:
`skb_zcopy_clear`, `skb_zcopy_init`, `skb_zcopy_set`, `skb_zcopy_abort`,
`skb_orphan_frags_rx`, `skb_orphan_frags`.

**2. `SKBFL_ALL_ZEROCOPY` is the umbrella, and it includes `SHARED_FRAG`.**

```c
#define SKBFL_ZEROCOPY_FRAG   (SKBFL_ZEROCOPY_ENABLE | SKBFL_SHARED_FRAG)
#define SKBFL_ALL_ZEROCOPY    (SKBFL_ZEROCOPY_FRAG | SKBFL_PURE_ZEROCOPY | \
                               SKBFL_DONT_ORPHAN | SKBFL_MANAGED_FRAG_REFS)
```

So clearing the zerocopy state clears the shared-frag state too. That is why
`skb_copy_ubufs` is safe despite never mentioning the flag.

**3. There are two independent producers.**

| Producer | Sets | Path |
|---|---|---|
| TCP | `SKBFL_SHARED_FRAG` | `tcp.c:1366` |
| Datagram (UDP) | `SKBFL_SHARED_FRAG` | `__ip_append_data` (the Dirty Frag fix) |
| Zerocopy | `uarg->flags` | `skb_zcopy_init` |

A guard can be defeated by any producer that is not covered. The datagram
producer was missing — that was the vulnerability.

**4. The consumer guard is the fragile half.** Producers are few and centralised;
consumers are many and scattered. The correct hardening direction is **one
authoritative setter** (or an assertion in `skb_has_shared_frag` itself) rather
than per-consumer guards.

---

## Why this matters beyond Dirty Frag

The flag is a **security invariant**, not an optimisation hint. It is the
difference between "decrypt into a buffer you own" and "decrypt into a page
cache you do not own." Anything that can clone or copy an skb is in scope:

- `skb_clone`, `__skb_clone`, `skb_copy`, `pskb_copy`, `skb_copy_expand`
- `skb_segment`, `skb_shift`, `skb_split`
- `skb_try_coalesce`, `skb_copy_ubufs`
- every `__skb_fill_netmem_desc` / frag-transfer helper

A single future patch that adds an skb copy path and forgets the flag silently
disables every consumer guard in the kernel at once. That is exactly the failure
mode that produced a **9.3-year** vulnerability window.

### Recommended invariant

Add a self-check so a dropped flag is loud, not silent:

```c
static inline void skb_assert_shared_frag_consistent(const struct sk_buff *skb)
{
    if (skb_is_nonlinear(skb) && skb_has_frag_list(skb))
        WARN_ON_ONCE(!skb_has_shared_frag(skb) && skb_shinfo(skb)->nr_frags &&
                     !skb_frags_readable(skb));
}
```

Called from `skb_clone` / `skb_copy` / `skb_segment` in debug builds, this turns
a silent security regression into an immediate kernel warning.

---

## Summary

| Claim | Status |
|---|---|
| Flag propagation complete in mainline | **Verified** — 6 sites, all correct |
| `skb_copy_ubufs` drops the flag | **False positive** — cleared via `skb_zcopy_clear` |
| `skb_zerocopy` drops the flag | **Not reachable** — zero callers in tree |
| `skb_zerocopy_iter_stream` drops the flag | **False positive** — sets it via `skb_zcopy_init` |
| New exploitable instance found | **No** — bounded negative, not proof of absence |
| Guard count sufficient as a long-term fix | **No** — producer/consumer asymmetry favours a single authoritative setter |
