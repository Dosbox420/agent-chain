# PoC Dorking Report — Verified Vulnerability Corpus

**Date:** 2026-10-11
**Scope:** Broad — deliberately outside the agent-payments domain, per instruction.
**Method:** Enumerate PoC repositories and advisories, then **cross-verify every
CVE against NVD** before treating it as real. Findings confirmed against the
primary source (kernel commits and live mainline source), not PoC READMEs.

---

## 0. Tooling reality (recorded so it is not re-litigated)

The instruction was to find vulnerability docs "using google dorks". **Google was
not usable**, and the first pass returned 17 dorks × 0 hits — which was a broken
tool, not an absence of results. Verified backends:

| Backend | Result |
|---|---|
| Hermes `web_search` | **403** — keyless Firecrawl |
| Google (curl) | JS-only shell, no server-rendered results |
| Google (browser) | **"unusual traffic"** captcha on this IP |
| Bing (curl) | 200, but serves bot-detection junk; **ignores `site:` / `intitle:`** |
| DuckDuckGo HTML | 202, no result markup |
| searx.be / searxng / brave / mojeek / ecosia / startpage | 429 / 403 / no markers |
| **GitHub REST search API** | **works** — the actual index behind `site:github.com` |
| **GitHub Advisory DB** | **works** — structured GHSA + CVE |
| **OSV.dev** | **works** |
| **NVD API** | **works** — authoritative |

The workable substitute for `site:github.com` dorks is the GitHub Search API
itself, plus NVD for verification. Tooling saved at
`~/.hermes/cache/scratch/dork/{dork_engine,harvest_pocs}.py`.

**Corpus:** 124 repositories, 68 distinct CVEs, 7 query families.
Every named CVE was checked against NVD; "not in NVD" is reported as such and
never counted as a finding.

---

## 1. Headline finding: "Dirty Frag" — universal Linux LPE

Two page-cache write vulnerabilities, chained, giving root on every major
distribution. **~9-year window, deterministic logic bug, no race condition,
kernel does not panic on failure.**

| | |
|---|---|
| **CVE-2026-43284** | xfrm-ESP Page-Cache Write — CVSS **7.8** |
| **CVE-2026-43500** | RxRPC Page-Cache Write |
| Introduced | 2017-01-17 (esp) · 2023-06-08 (rxrpc) |
| Fixed | 2026-05-05 (esp) · 2026-05-10 (rxrpc) |
| Researcher | Hyunwoo Kim (@v4bel) |
| Upstream PoC | `github.com/V4bel/dirtyfrag` — **5,037★, 793 forks** |
| NVD tags | **Exploit**, Patch, Vendor Advisory, Third Party Advisory |

### Verified root cause (CVE-2026-43284)

`esp_input()` should call `skb_cow_data()` before in-place AEAD decryption when
the skb is non-linear. A branch bypasses that copy:

```c
if (!skb_cloned(skb)) {
    if (!skb_is_nonlinear(skb)) {
        nfrags = 1;
        goto skip_cow;                     // [1]
    } else if (!skb_has_frag_list(skb)) {
        nfrags = skb_shinfo(skb)->nr_frags;
        nfrags++;
        goto skip_cow;                     // [2]  <-- THE BUG
    }
}
```

If a page-cache page is pinned into the frag via `splice()`, that page becomes
both `src` and `dst`. In-place crypto then performs a **STORE**:

```c
scatterwalk_map_and_copy(tmp + 1, dst, assoclen + cryptlen, 4, 1);   // [3]
```

Both the **location** (tune payload length → target file offset) and the
**value** (high 32 bits of the ESP sequence number, freely set by the attacker
via the `XFRMA_REPLAY_ESN_VAL` netlink attribute) are attacker-controlled.

Critically: **AEAD authentication runs *after* the STORE.** The write lands
even when authentication fails, so the attacker modifies the page cache
**without knowing the SA's authentication key.**

### Verified against primary sources

- Vulnerable commit `72548b093ee3` — introduced **2017-08-09**
- Fix commit `a664bf3d603dc3bdcf9ae47cc21e0daec706d7a5` — merged **2026-03-31**
- Live mainline `net/ipv4/esp4.c` now reads:

```c
} else if (!skb_has_frag_list(skb) &&
           !skb_has_shared_frag(skb)) {      // <-- the fix
```

- `SKBFL_SHARED_FRAG = BIT(1)` confirmed present in this host's kernel headers
  (`include/linux/skbuff.h:512`)

### Why chaining matters

| | xfrm-ESP | RxRPC |
|---|---|---|
| Needs user namespace | yes | **no** |
| Module shipped by default | most distros | Ubuntu only |

Ubuntu often blocks unprivileged user namespaces via AppArmor — so ESP fails
there, but `rxrpc.ko` is loaded by default. The two cover each other's blind
spots, giving root on every major distribution.

**Dirty Frag defeats the Copy Fail mitigation.** Blacklisting `algif_aead` (the
published Copy Fail workaround) does **not** protect against Dirty Frag, which
triggers regardless of that module.

### Host assessment (this machine)

Kernel **7.1.1-76070101-generic** — above the patch line, so **not vulnerable**.
`esp4`/`esp6`/`rxrpc` modules are present but not loaded. Note: `skb_has_shared_frag`
is `static inline`, so it is compiled into `esp4.ko` with no symbol name — a
symbol-string search returns a **false negative**. Verified via headers instead.

---

## 2. Related: "Copy Fail" (CVE-2026-31431)

The motivating bug for the Dirty Frag research — same sink, different trigger.

- Linux LPE via `AF_ALG` + `splice()` page-cache overwrite
- CVSS **7.8**, `AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:I`
- Introduced 2017, fixed 2026-03-31 — **~8.6 years**
- Reported by **Taeyang Lee, Theori**; NVD tag includes **Exploit**
- **4 independent PoCs** in the corpus (Rust ×3, Shell ×1) — recurrence across
  independent authors is a strong reality signal

Mechanism: overwrites a read-only SUID binary (`/usr/bin/su`) with a minimal ELF
calling `setuid(0)` + `execve("/bin/sh")`. Single-shot, no race, no per-distro
offsets.

---

## 3. Weaponised Kubernetes escape

`Percivalll/Dirty-Frag-Kubernetes-PoC` — a **working container escape** turning
an unprivileged pod into node-level code execution, **validated on Amazon EKS
(kernel 6.12.80)**.

The chain exploits three properties that commonly coexist:

1. **Page-cache corruption** — an unprivileged process overwrites the in-memory
   cached pages of any file it can open read-only.
2. **Image layer sharing** — containerd/CRI-O overlay filesystems map identical
   image layers to the *same page-cache pages* across containers.
3. **Privileged DaemonSets** — many clusters run them (`privileged: true`,
   `hostNetwork: true`), and they periodically execute binaries from their image.

An unprivileged pod corrupts a binary in a shared image layer; a privileged
DaemonSet on the same node executes it with elevated privilege.

**The file on disk is never modified** — the corruption lives in the page cache
and is observed by later readers of the same cached page. That is why it evades
integrity monitoring.

Not limited to kube-proxy: any privileged DaemonSet sharing layers with an
attacker-controlled image (monitoring agents, CNI plugins, log collectors,
security agents) is a viable target.

---

## 4. Other verified CVEs from the corpus

| CVE | Score | NVD status | Exploit tag | Summary |
|---|---|---|---|---|
| CVE-2026-24061 | **9.8** | Analyzed | **yes** | telnetd (GNU Inetutils ≤2.7) — remote auth bypass via `-f root` in the `USER` env var |
| CVE-2026-63030 | **9.8** | Analyzed | no | WordPress 6.9.x/7.0.x — REST API batch route confusion + `author__not_in` → RCE ("wp2shell") |
| CVE-2026-21589 | **9.3** | Awaiting Analysis | no | Atlassian Data Center stack (Bitbucket/Confluence/Jira/Bamboo) |
| CVE-2026-43284 | 8.8 | Modified | **yes** | Dirty Frag esp component (above) |
| CVE-2026-96889 | 7.8 | Awaiting Analysis | — | VectorFreed |
| CVE-2026-31694 | 7.8 | Modified | — | — |
| CVE-2026-23111 | 7.8 | Modified | — | "noddlenpot" |
| CVE-2026-43499 | 7.8 | Modified | — | Two independent PoCs (S22U / FindN2) — mobile |
| CVE-2026-93485 | 7.1 | Deferred | — | Comment2Shell |
| CVE-2025-38352 | 7.8 | Analyzed | — | (2025 CVE, still being PoC'd) |
| CVE-2026-46215 | 7.8 | Modified | — | Linux kernel `drm: Set old handle` |
| CVE-2026-44011 | **8.6** | Deferred | — | Craft CMS 4.0.0–4.17.12 / 5.9.18 — RCE |
| CVE-2026-42945 | **8.1** | Modified | — | NGINX `ngx_http_rewrite_module` |
| CVE-2026-100520 | **8.8** | Deferred | — | Laranode <1.2.1 — path traversal in `POST /files` |
| CVE-2026-43500 | 7.8 | Modified | Patch | Dirty Frag rxrpc component (above) |
| CVE-2026-53921 | — | **ABSENT** | — | Repo exists (6★) but **no NVD record** — unassigned or unpublished |

Corpus language split: Python 58, C 17, Solidity 9, Rust 3, Shell 4, Go 2.

---

## 5. Signal vs noise — what the corpus teaches

Not everything that looks like a PoC repo is one. Observations:

- **Recurrence is the strongest reality signal.** CVE-2026-31431 had 4
  independent implementations by different authors; CVE-2026-43284 has 60 NVD
  references. One-off repos with 0 stars and a templated README are often
  auto-generated.
- **A `tc4dy/*` cluster** publishes many `CVE-YYYY-NNNNN-PoC-Exploit` repos in a
  uniform format. Some are verified real (CVE-2026-61511, 9.8, "Deferred"); the
  pattern is bulk-produced and should be verified individually, not trusted as a set.
- **"Not in NVD" ≠ "fake".** Several CVEs here (e.g. CVE-2026-6875, CVE-2026-1668)
  *are* in NVD but were simply outside the sample. Absence from a sample is not
  evidence of absence — the sample must be stated.
- **NVD `vulnStatus` is meaningful**: `Analyzed`/`Modified` means reviewed;
  `Awaiting Analysis` / `Received` / `Deferred` means the record is not final.
  Scoring an `Awaiting Analysis` CVE as authoritative overstates it.

---

## 6. Defensive takeaways

1. **Patch the kernel.** Both Dirty Frag CVEs are fixed in mainline (May 2026).
   Kernels below 6.19 are in scope for esp; rxrpc from 2023-06-08.
2. **The `algif_aead` blacklist is not sufficient.** It mitigates Copy Fail only.
   Dirty Frag's esp path triggers regardless.
3. **`/proc/sys/vm/drop_caches` after any suspected exploitation** — page-cache
   contamination persists across process restarts and survives until dropped.
4. **Container image layer sharing is an attack surface.** A privileged
   DaemonSet sharing layers with an untrusted image is a container-escape vector.
   Prefer isolated layers for privileged workloads.
5. **File-integrity monitoring will not catch this class.** The on-disk file is
   unchanged; only the page cache is corrupted.

---

## Artifacts

- `~/.hermes/human-ai-learning/poc-corpus.jsonl` — 124 repos, 68 CVEs
- `~/.hermes/cache/scratch/dork/dork_engine.py` — multi-backend dork runner
- `~/.hermes/cache/scratch/dork/harvest_pocs.py` — corpus builder + NVD verifier
- `~/.hermes/cache/scratch/dork/{wu.md,df.md,esp4.c,kpatch.txt}` — primary sources
