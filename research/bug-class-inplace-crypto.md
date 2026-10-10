# Bug Class: In-Place Crypto on Non-Private Pages

**Date:** 2026-10-11
**Method:** Read the four known instances, extract the common shape, then audit
every sibling kernel file that performs in-place crypto over skb frags.
**Result:** Bug class confirmed and generalised. **No new exploitable instance
found** in the siblings audited — and the negative result is reported as such.

---

## The class

An in-place crypto operation (src == dst) writes into a scatterlist or skb frag
whose pages the caller does **not** privately own. If those pages came from
`splice()` / a pipe, they are **page-cache backed**: the write lands in the page
cache of a file the attacker opened **read-only**.

The on-disk file is never modified. The corruption lives in memory and is
observed by later readers of the same cached page — which is exactly why
file-integrity monitoring does not catch it.

### Instances

| CVE | Name | In-place sink | Window |
|---|---|---|---|
| CVE-2022-0847 | **Dirty Pipe** | `pipe_buffer` flags uninitialised | 2022 |
| CVE-2026-31431 | **Copy Fail** | `algif_aead` in-place AEAD | 2017–2026 (8.6y) |
| CVE-2026-43284 | **Dirty Frag / esp** | `esp_input()` in-place decrypt | 2017–2026 (9.3y) |
| CVE-2026-43500 | **Dirty Frag / rxrpc** | `rxkad_verify_packet_1()` in-place | 2023–2026 (2.9y) |

### The two mitigations observed

The fixes take **two different forms**, and understanding both is what makes the
class auditable:

**(a) Guard the fast path — "do not skip the private copy".**
`esp4.c` / `esp6.c` add a shared-frag test before taking the `skip_cow` branch:

```c
} else if (!skb_has_frag_list(skb) &&
           !skb_has_shared_frag(skb)) {     // <-- added
    nfrags = skb_shinfo(skb)->nr_frags;
    nfrags++;
    goto skip_cow;
}
```

**(b) Change the sink — "decrypt into a private buffer".**
`rxkad.c` does not use a shared-frag guard at all. It redirects the output into
a kernel-private buffer:

```c
void *data = call->rx_dec_buffer;                       // private
fcrypt_pcbc_decrypt(cipher, zero_iv, data, data, 1);    // no longer skb-backed
```

So "is there a `SHARED_FRAG` check?" is **not** a sufficient audit question. A
file can be fixed and still have zero shared-frag guards.

### The Dirty Frag fix is actually a producer/consumer pair

Reading the real fix commit `f4c50a4034e6` settles the mechanism. The
`skb_has_shared_frag()` guard in `esp4.c` only works because something *marks*
the skb. The complete fix is **four lines across four files**:

| File | Change | Role |
|---|---|---|
| `net/ipv4/ip_output.c` | `if (!(flags & MSG_NO_SHARED_FRAGS)) skb_shinfo(skb)->flags \|= SKBFL_SHARED_FRAG;` | **producer** — marks UDP datagram splice frags |
| `net/ipv6/ip6_output.c` | same | **producer** (IPv6) |
| `net/ipv4/esp4.c` | `&& !skb_has_shared_frag(skb)` | **consumer** — refuses the fast path |
| `net/ipv6/esp6.c` | same | **consumer** (IPv6) |

**TCP already set the flag**; the datagram append paths (`__ip_append_data`) did
not. That omission is the entire vulnerability: an ESP-in-UDP packet built from
shared pipe pages looked like an ordinary uncloned nonlinear skb, so `esp_input`
took the no-COW fast path and decrypted in place over pages it did not own.

The commit also notes it **intentionally does not change ESP output**: in
`esp_output_head()` the trailer-append path is unreachable for nonlinear skbs,
because `skb_tailroom()` returns zero when `skb->data_len` is nonzero while the
ESP tailen is positive.

### Why this makes the class systemic

The guard has a **blast radius**. The flag must be propagated every time an skb
is copied, cloned, or split, or the marker is silently lost. Mainline
`net/core/skbuff.c` has **6** such propagation sites:

```
2263:  skb_shinfo(n)->flags |= skb_shinfo(skb)->flags & SKBFL_SHARED_FRAG;
4251:  const int zc_flags = SKBFL_SHARED_FRAG | SKBFL_PURE_ZEROCOPY;
4402:  skb_shinfo(tgt)->flags |= skb_shinfo(skb)->flags & SKBFL_SHARED_FRAG;
5017:  ... SKBFL_SHARED_FRAG;
5034:  skb_shinfo(nskb)->flags |= skb_shinfo(frag_skb)->flags & SKBFL_SHARED_FRAG;
6264:  to_shinfo->flags |= from_shinfo->flags & SKBFL_SHARED_FRAG;
```

**Any path that drops the flag re-opens the class**, because every consumer guard
becomes a no-op for that skb. The producer side is the fragile half, not the
consumer guard.

---

## Audit of sibling files (the hunt for a fifth instance)

Every kernel file performing in-place crypto over skb frags was fetched from
mainline and inspected:

| File | shared_frag guard | cow/unshare calls | Verdict |
|---|---|---|---|
| `net/ipv4/esp4.c` | **yes** | 3 | patched (form a) |
| `net/ipv6/esp6.c` | **yes** | 3 | patched (form a) |
| `net/rxrpc/rxkad.c` | no | 1 | **patched (form b)** — private buffer |
| `net/ipv4/ah4.c` | no | 2 | **clean** — `skb_cow_data` before in-place |
| `net/ipv6/ah6.c` | no | 2 | **clean** — `skb_cow_data` before in-place |
| `crypto/algif_aead.c` | no | 0 | patched — explicit `memcpy_sglist` |

### Files examined closely

**`rxkad.c` — one apparent live instance, resolved as safe.**
`fcrypt_pcbc_encrypt(cipher, zero_iv, hdr, hdr, 1)` at line 238 looks in-place
(src == dst). Traced the origin of `hdr`: it points into `txb->data`, a
**transmit** buffer owned by the kernel — not attacker-spliced, not page-cache
backed. The other in-place call (line 304) operates on a stack `crypto.buf`.
Neither is reachable from the splice path. **Not vulnerable.**

**`ah4.c` / `ah6.c` — clean by construction.**
Both call `skb_cow_data(skb, 0, &trailer)` before building the scatterlist and
running `ahash_request_set_crypt`. Because they always take the private-copy
path, the shared-frag condition never arises — they have no `skip_cow` branch to
get wrong.

**`algif_aead.c` — the Copy Fail fix is the out-of-place revert.**
The commit reverts in-place operation entirely and copies the associated data
explicitly via `memcpy_sglist(rsgl_src, tsgl_src, ctx->aead_assoclen)`.

---

## What this means

**No fifth exploitable instance was found in the files audited.** Stated plainly:
this is a negative result on a bounded set, not proof that none exists. The
siblings examined are the obvious ones — the ones sharing the `xfrm`/`AF_ALG`/
`rxrpc` splice-reachable structure. The class could still exist elsewhere, and
the right way to find it is systematic:

1. **Grep for in-place crypto calls** — `_decrypt(`, `_encrypt(`, `crypto_*` —
   where src and dst arguments are the same expression.
2. **For each, trace whether the buffer is skb-backed or frag-backed**, and if
   so, whether the skb can carry spliced pages.
3. **Check for a private-copy or shared-frag guard** on that path.
4. **Prefer `skb_cow_data` unconditionally** — `ah4`/`ah6` are safe precisely
   because they never take a conditional fast path.

### Why the class keeps recurring

Both mitigations are *conditional*. A guard added to one fast path does not
protect the next fast path added beside it. The esp bug was introduced by a
commit that added a `skip_cow` branch; it was fixed by adding a condition to that
branch. Any future optimisation that reintroduces a copy-skipping path reopens
the class.

The structural fix is to make in-place crypto on skb frags **impossible by
construction** — always copy to a private buffer before crypto, as `ah4`/`ah6`
and post-fix `rxkad` do. The conditional guards are patches, not the fix.

---

## Defensive implications

- **`algif_aead` blacklisting does not cover this class.** It mitigates Copy Fail
  only; Dirty Frag's esp path triggers regardless.
- **Drop the page cache after any suspected exploitation** —
  `echo 3 > /proc/sys/vm/drop_caches`. Contamination survives process restarts.
- **Integrity monitoring is blind to this class.** The on-disk bytes never change.
- **Container image layer sharing is the amplifier** — identical layers map to
  the *same page-cache pages*, so corruption propagates from an unprivileged pod
  to any privileged DaemonSet sharing those layers.

---

## Sources (primary)

- Live mainline: `net/ipv4/esp4.c`, `net/ipv6/esp6.c`, `net/rxrpc/rxkad.c`,
  `net/ipv4/ah4.c`, `net/ipv6/ah6.c`, `crypto/algif_aead.c`
- Kernel fix commits: `f4c50a4034e6` (esp), `aa54b1d27fe0` (rxrpc),
  `a664bf3d603dc3bdcf9ae47cc21e0daec706d7a5` (algif_aead)
- `V4bel/dirtyfrag` write-up (`assets/write-up.md`)
- NVD records for all four CVEs
